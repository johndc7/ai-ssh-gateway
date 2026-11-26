import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

function jsonContent(data) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function errorContent(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }]
  };
}

/**
 * Creates a backend adapter operating directly against the in-process SSHManager + Socket.IO server.
 */
export function createLocalGatewayBackend({ sshManager, io, getInstructions, uiUrl }) {
  const emitAndStore = (sessionId, data) => {
    if (io) {
      io.to(sessionId).emit('terminal:data', { sessionId, data });
    }
    sshManager.appendToHistory(sessionId, data);
  };

  return {
    async getInstructionsText() {
      return typeof getInstructions === 'function' ? getInstructions() : '';
    },

    async listSessions() {
      const sessions = sshManager.getSessions();
      const [netbird, localShells] = await Promise.all([
        sshManager.getNetbirdInfo(),
        sshManager.getLocalShellsInfo()
      ]);
      return { ...sessions, netbird, localShells, dashboardUrl: uiUrl || null };
    },

    async requestSession({ host, username, port = 22, useNetbird = false, reason = '', waitForApproval = true, timeoutMs = 120000 }) {
      const request = sshManager.createRequest(host, username, reason, { port, useNetbird });
      if (io) {
        io.emit('session:request', request);
      }
      if (!waitForApproval) {
        return { status: 'pending', request, dashboardUrl: uiUrl || null };
      }
      const resolution = await sshManager.waitForRequestResolution(request.id, timeoutMs);
      return { ...resolution, request, dashboardUrl: uiUrl || null };
    },

    async requestLocalSession({ shell, cwd, reason = '', waitForApproval = true, timeoutMs = 120000 }) {
      const request = await sshManager.createLocalRequest(shell, reason, { cwd });
      if (io) {
        io.emit('session:request', request);
      }
      if (!waitForApproval) {
        return { status: 'pending', request, dashboardUrl: uiUrl || null };
      }
      const resolution = await sshManager.waitForRequestResolution(request.id, timeoutMs);
      return { ...resolution, request, dashboardUrl: uiUrl || null };
    },

    async execCommand({ sessionId, command, timeoutMs }) {
      if (io) {
        io.emit('session:ai_activity', { sessionId });
      }
      emitAndStore(sessionId, `\r\n\x1b[33m[Background Command]\x1b[0m \x1b[1m${command}\x1b[0m\r\n`);
      try {
        const result = await sshManager.exec(sessionId, command, {
          timeoutMs,
          onStdout: (data) => emitAndStore(sessionId, data.replace(/\r?\n/g, '\r\n')),
          onStderr: (data) => emitAndStore(sessionId, `\x1b[31m${data.replace(/\r?\n/g, '\r\n')}\x1b[0m`)
        });
        emitAndStore(sessionId, `\x1b[33m[Command Exited with Code: ${result.exitCode}]\x1b[0m\r\n`);
        return result;
      } catch (err) {
        emitAndStore(sessionId, `\x1b[31m[Background Command Error: ${err.message}]\x1b[0m\r\n`);
        throw err;
      }
    },

    async sendTerminalInput({ sessionId, input, waitFor, timeoutMs }) {
      if (io) {
        io.emit('session:ai_activity', { sessionId });
      }
      if (waitFor) {
        return sshManager.writeAndWait(sessionId, input, waitFor, timeoutMs);
      }
      const ok = sshManager.write(sessionId, input);
      if (!ok) throw new Error('Session not found');
      const output = sshManager.getOutput(sessionId, 0, false);
      return { success: true, currentLine: output ? output.currentLine : 0 };
    },

    async readTerminalOutput({ sessionId, since = 0, limit = 100, clean = true }) {
      const result = sshManager.getOutput(sessionId, since, clean, limit);
      if (!result) throw new Error('Session not found');
      return result;
    },

    async getTerminalHistory({ sessionId }) {
      const history = sshManager.getHistory(sessionId);
      if (history === null) throw new Error('Session not found');
      return history;
    },

    async sendTerminalSignal({ sessionId, signal }) {
      if (io) {
        io.emit('session:ai_activity', { sessionId });
      }
      sshManager.sendSignal(sessionId, signal);
      return { success: true };
    },

    async readRemoteFile({ sessionId, path }) {
      return sshManager.sftpReadFile(sessionId, path);
    },

    async writeRemoteFile({ sessionId, path, content }) {
      return sshManager.sftpWriteFile(sessionId, path, content);
    },

    async handoffToUser({ sessionId, message }) {
      const ok = sshManager.handoff(sessionId, message);
      if (!ok) throw new Error('Session not found');
      if (io) {
        const msg = message || 'Manual assistance requested by AI';
        io.to(sessionId).emit('session:status', { sessionId, status: 'user_control', message: msg });
        io.emit('session:status', { sessionId, status: 'user_control', message: msg });
      }
      return { success: true, status: 'user_control' };
    },

    async closeSession({ sessionId }) {
      const ok = sshManager.disconnect(sessionId, io);
      if (!ok) throw new Error('Session not found');
      return { success: true };
    }
  };
}

/**
 * Creates a backend adapter forwarding MCP tool calls over HTTP to an already-running local gateway.
 */
export function createRemoteGatewayBackend({ baseUrl, apiKey }) {
  const headers = (extra = {}) => {
    const h = { ...extra };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  };

  async function apiFetch(pathname, options = {}) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: headers(options.headers)
    });
    const contentType = res.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const payload = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const msg = isJson && payload && payload.error ? payload.error : String(payload || res.statusText);
      throw new Error(msg);
    }
    return payload;
  }

  return {
    async getInstructionsText() {
      return apiFetch('/instructions');
    },
    async listSessions() {
      return apiFetch('/api/sessions');
    },
    async requestSession({ host, username, port = 22, useNetbird = false, reason = '', waitForApproval = true, timeoutMs = 120000 }) {
      return apiFetch('/api/sessions/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ssh', host, username, port, useNetbird, reason, waitForApproval, timeoutMs })
      });
    },
    async requestLocalSession({ shell, cwd, reason = '', waitForApproval = true, timeoutMs = 120000 }) {
      return apiFetch('/api/sessions/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'local', shell, cwd, reason, waitForApproval, timeoutMs })
      });
    },
    async execCommand({ sessionId, command, timeoutMs }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, timeoutMs })
      });
    },
    async sendTerminalInput({ sessionId, input, waitFor, timeoutMs }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, waitFor, timeout: timeoutMs })
      });
    },
    async readTerminalOutput({ sessionId, since = 0, limit = 100, clean = true }) {
      const params = new URLSearchParams({
        since: String(since),
        clean: String(clean)
      });
      if (limit) params.set('limit', String(limit));
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/output?${params.toString()}`);
    },
    async getTerminalHistory({ sessionId }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
    },
    async sendTerminalSignal({ sessionId, signal }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signal })
      });
    },
    async readRemoteFile({ sessionId, path }) {
      const params = new URLSearchParams({ path });
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?${params.toString()}`);
    },
    async writeRemoteFile({ sessionId, path, content }) {
      const params = new URLSearchParams({ path });
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
    },
    async handoffToUser({ sessionId, message }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
    },
    async closeSession({ sessionId }) {
      return apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      });
    }
  };
}

export function createMcpServer(backend, { version = '1.1.1' } = {}) {
  const server = new McpServer({
    name: 'ai-ssh-gateway',
    version
  });

  server.registerResource(
    'instructions',
    'gateway://instructions',
    {
      title: 'AI SSH Gateway Operational Instructions',
      description: 'Best practices and workflow instructions for interacting with SSH and NetBird SSH sessions.',
      mimeType: 'text/markdown'
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: await backend.getInstructionsText()
        }
      ]
    })
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List SSH Sessions',
      description: 'List active SSH sessions, pending connection requests, and NetBird SSH availability.',
      inputSchema: {}
    },
    async () => {
      try {
        return jsonContent(await backend.listSessions());
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'request_session',
    {
      title: 'Request SSH Session',
      description: 'Request human authorization to open an SSH or NetBird SSH connection to a host.',
      inputSchema: {
        host: z.string().min(1).describe('Target hostname, IP address, or NetBird peer name'),
        username: z.string().min(1).describe('SSH username (e.g. root, ubuntu)'),
        port: z.number().int().min(1).max(65535).optional().describe('SSH port (default: 22)'),
        useNetbird: z.boolean().optional().describe('Set true to request NetBird identity-aware SSH'),
        reason: z.string().optional().describe('Explanation shown to the human operator when approving'),
        waitForApproval: z.boolean().optional().describe('Wait for operator approval before returning (default: true)'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Max wait time in ms when waitForApproval is true (default: 120000)')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.requestSession(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'request_local_session',
    {
      title: 'Request Local Terminal Session',
      description: 'Request human operator approval to open a local shell session (pwsh, powershell, cmd, bash, zsh, or sh) on the gateway host.',
      inputSchema: {
        shell: z.enum(['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'sh']).optional().describe('Preferred local shell (defaults to best available system shell)'),
        cwd: z.string().optional().describe('Optional local working directory path'),
        reason: z.string().optional().describe('Explanation shown to the human operator when approving'),
        waitForApproval: z.boolean().optional().describe('Wait for operator approval before returning (default: true)'),
        timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Max wait time in ms when waitForApproval is true (default: 120000)')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.requestLocalSession(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'exec_command',
    {
      title: 'Execute SSH Command',
      description: 'Execute a clean synchronous command over a dedicated SSH exec channel without disturbing the interactive PTY.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        command: z.string().min(1).describe('Shell command to execute'),
        timeoutMs: z.number().int().min(500).max(600000).optional().describe('Execution timeout in ms (default: 120000)')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.execCommand(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'send_terminal_input',
    {
      title: 'Send Interactive PTY Input',
      description: 'Send raw input (remember trailing \\n to submit commands) to the stateful interactive PTY shell, optionally waiting for a prompt regex.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        input: z.string().describe('Raw text to write to the PTY (include \\n to press Enter)'),
        waitFor: z.string().optional().describe('Optional JavaScript regex string to wait for in terminal output before returning'),
        timeoutMs: z.number().int().min(100).max(120000).optional().describe('Timeout in ms when waitFor is specified (default: 10000)')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.sendTerminalInput(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'read_terminal_output',
    {
      title: 'Read Interactive PTY Output',
      description: 'Read buffered output lines from an interactive PTY session using line-offset pagination.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        since: z.number().int().min(0).optional().describe('Line offset returned as currentLine from the previous call (default: 0)'),
        limit: z.number().int().min(1).max(2000).optional().describe('Maximum trailing lines to return to protect context window (default: 100)'),
        clean: z.boolean().optional().describe('Strip ANSI escape codes (default: true)')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.readTerminalOutput(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'get_terminal_history',
    {
      title: 'Get Raw Terminal History',
      description: 'Fetch the raw terminal output buffer for an active SSH session.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.getTerminalHistory(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'send_terminal_signal',
    {
      title: 'Send Control Signal to PTY',
      description: 'Send a control signal (SIGINT / Ctrl+C, EOF / Ctrl+D, SIGQUIT, SIGTSTP / Ctrl+Z) to the interactive PTY.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        signal: z.enum(['SIGINT', 'EOF', 'SIGQUIT', 'SIGTSTP']).describe('Control signal to send')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.sendTerminalSignal(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'read_remote_file',
    {
      title: 'Read Remote File via SFTP',
      description: 'Read a remote text file directly over SFTP (prefer this over nano/vim/cat for file inspection).',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        path: z.string().min(1).describe('Remote file path on the SSH server')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.readRemoteFile(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'write_remote_file',
    {
      title: 'Write Remote File via SFTP',
      description: 'Write UTF-8 text content directly to a remote file over SFTP (prefer this over nano/vim/heredocs).',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        path: z.string().min(1).describe('Remote file path on the SSH server'),
        content: z.string().describe('Full text content to write')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.writeRemoteFile(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'handoff_to_user',
    {
      title: 'Handoff Session to Human Operator',
      description: 'Pause AI access and ask the human operator to intervene in the Web UI terminal (e.g. sudo password, 2FA, complex interactive prompt).',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID'),
        message: z.string().min(1).describe('Message displayed to the human operator explaining what help is needed')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.handoffToUser(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    'close_session',
    {
      title: 'Close SSH Session',
      description: 'Disconnect an active SSH session and release resources.',
      inputSchema: {
        sessionId: z.string().min(1).describe('Active SSH session ID')
      }
    },
    async (args) => {
      try {
        return jsonContent(await backend.closeSession(args));
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  return server;
}

export function createExpressMcpRouter(backend, { version = '1.1.1' } = {}) {
  const router = express.Router();
  const mcpSessions = new Map(); // sessionId -> { transport, server, lastSeen }
  const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

  const pruneIdle = () => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, entry] of mcpSessions.entries()) {
      if (entry.lastSeen < cutoff) {
        mcpSessions.delete(id);
        entry.transport.close().catch(() => {});
      }
    }
  };

  router.post('/', express.json({ limit: '10mb' }), async (req, res) => {
    pruneIdle();
    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId) {
        const entry = mcpSessions.get(sessionId);
        if (!entry) {
          return res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'MCP session not found' },
            id: null
          });
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (isInitializeRequest(req.body)) {
        const server = createMcpServer(backend, { version });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            mcpSessions.set(sid, { transport, server, lastSeen: Date.now() });
          },
          onsessionclosed: (sid) => {
            mcpSessions.delete(sid);
          }
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            mcpSessions.delete(transport.sessionId);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Stateless single-shot JSON-RPC fallback
      const statelessServer = createMcpServer(backend, { version });
      const statelessTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });
      res.on('close', () => {
        statelessTransport.close().catch(() => {});
        statelessServer.close().catch(() => {});
      });
      await statelessServer.connect(statelessTransport);
      await statelessTransport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal MCP server error' },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Missing mcp-session-id header' },
        id: null
      });
    }
    const entry = mcpSessions.get(sessionId);
    if (!entry) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP session not found' },
        id: null
      });
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  };

  router.get('/', handleSessionRequest);
  router.delete('/', handleSessionRequest);

  router.closeAll = async () => {
    for (const [id, entry] of mcpSessions.entries()) {
      mcpSessions.delete(id);
      await entry.transport.close().catch(() => {});
      await entry.server.close().catch(() => {});
    }
  };

  return router;
}

export async function startStdioMcpServer(backend, { version = '1.1.1', onDisconnect } = {}) {
  const server = createMcpServer(backend, { version });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closed = false;
  const handleEnd = async () => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
    if (typeof onDisconnect === 'function') {
      await onDisconnect();
    }
  };
  process.stdin.once('end', handleEnd);
  process.stdin.once('close', handleEnd);

  return { server, transport };
}
