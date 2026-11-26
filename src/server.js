import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import defaultSshManager, {
  SessionNotFoundError,
  ValidationError
} from './ssh-manager.js';
import {
  createLocalGatewayBackend,
  createRemoteGatewayBackend,
  createExpressMcpRouter,
  startStdioMcpServer
} from './mcp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '../public');
const INSTRUCTIONS_PATH = path.join(__dirname, '../instructions.md');
const PACKAGE_JSON_PATH = path.join(__dirname, '../package.json');

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const UI_COOKIE_NAME = 'gateway_ui_token';

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return pkg.version || '1.1.1';
  } catch {
    return '1.1.1';
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return cookies;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

export function extractHostname(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const closeBracket = trimmed.indexOf(']');
    return closeBracket !== -1 ? trimmed.slice(0, closeBracket + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx !== -1 ? trimmed.slice(0, colonIdx) : trimmed;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendApiError(res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  res.status(status).json({ error: err?.message || 'Internal Server Error' });
}

export function createGatewayServer({
  sshManager = defaultSshManager,
  apiKey = process.env.GATEWAY_API_KEY || null,
  logger = console
} = {}) {
  const version = readPackageVersion();
  const uiOperatorToken = crypto.randomBytes(32).toString('hex');

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // Security headers + DNS rebinding Host validation
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    const hostname = extractHostname(req.headers.host);
    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      return res.status(403).json({ error: 'Forbidden: Invalid Host header' });
    }
    next();
  });

  const hasValidUiCookie = (req) => {
    const cookies = parseCookies(req.headers.cookie);
    return timingSafeEqualStr(cookies[UI_COOKIE_NAME], uiOperatorToken);
  };

  const requireAgentOrUiAuth = (req, res, next) => {
    if (!apiKey) return next();
    if (hasValidUiCookie(req)) return next();

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const headerKey = req.headers['x-api-key'] || '';
    const provided = bearer || (typeof headerKey === 'string' ? headerKey : '');

    if (provided && timingSafeEqualStr(provided, apiKey)) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: Valid API key required' });
  };

  const buildBaseUrl = (req) => {
    const addr = server.address();
    if (req && req.headers.host) {
      const hostHeader = req.headers.host;
      if (ALLOWED_HOSTNAMES.has(extractHostname(hostHeader))) {
        return `http://${hostHeader}`;
      }
    }
    const port = addr && typeof addr === 'object' ? addr.port : process.env.PORT || 3000;
    return `http://127.0.0.1:${port}`;
  };

  const loadInstructions = (baseUrl) => {
    const url = baseUrl || buildBaseUrl();
    const raw = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8');
    return raw.replace(/\$\{baseUrl\}/g, url).trim();
  };

  // Serve UI entrypoint and issue HttpOnly SameSite=Strict operator cookie
  const serveIndexHtml = (_req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${UI_COOKIE_NAME}=${uiOperatorToken}; HttpOnly; SameSite=Strict; Path=/`
    );
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  };

  app.get('/', serveIndexHtml);
  app.get('/index.html', serveIndexHtml);
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // Lightweight unauthenticated health probe on localhost for CLI --mcp discovery
  app.get('/api/health', (_req, res) => {
    res.json({ service: 'ai-ssh-gateway', status: 'ok', version });
  });

  // Streamable HTTP MCP Endpoint (/mcp)
  const localBackend = createLocalGatewayBackend({
    sshManager,
    io,
    getInstructions: () => loadInstructions(),
    uiUrl: null
  });
  const mcpRouter = createExpressMcpRouter(localBackend, { version });
  app.use('/mcp', requireAgentOrUiAuth, mcpRouter);

  // Scoped JSON parsers for REST API
  const jsonSmall = express.json({ limit: '1mb' });
  const jsonFiles = express.json({ limit: '50mb' });

  app.get('/api/sessions', requireAgentOrUiAuth, async (_req, res) => {
    try {
      const sessions = sshManager.getSessions();
      const [netbird, localShells] = await Promise.all([
        sshManager.getNetbirdInfo(),
        sshManager.getLocalShellsInfo()
      ]);
      res.json({ ...sessions, netbird, localShells });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.get('/api/sessions/outputs', requireAgentOrUiAuth, (req, res) => {
    const ids = req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : [];
    const since = parseInt(req.query.since, 10) || 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const clean = req.query.clean !== 'false';
    const results = {};
    for (const id of ids) {
      results[id] = sshManager.getOutput(id, since, clean, limit);
    }
    res.json(results);
  });

  app.post('/api/sessions/request', requireAgentOrUiAuth, jsonSmall, async (req, res) => {
    try {
      const { type, shell, cwd, host, username, reason, port, useNetbird, waitForApproval, timeoutMs } = req.body || {};

      let request;
      if (type === 'local' || (!host && shell)) {
        request = await sshManager.createLocalRequest(shell, reason, { cwd });
      } else {
        if (!host || !username) {
          return res.status(400).json({ error: 'Missing host or username (or specify type: "local")' });
        }
        request = sshManager.createRequest(host, username, reason, { port, useNetbird });
      }
      io.emit('session:request', request);

      if (waitForApproval) {
        const resolution = await sshManager.waitForRequestResolution(request.id, timeoutMs);
        return res.json({ ...resolution, request });
      }
      res.json(request);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.delete('/api/sessions/requests/:id', (req, res) => {
    if (!hasValidUiCookie(req)) {
      return res.status(403).json({ error: 'Forbidden: Operator UI authorization required' });
    }
    const removed = sshManager.rejectRequest(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Pending request not found' });
    io.emit('session:request_removed', { requestId: req.params.id, status: 'rejected' });
    res.json({ success: true });
  });

  app.get('/api/sessions/:id/output', requireAgentOrUiAuth, (req, res) => {
    const since = parseInt(req.query.since, 10) || 0;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const clean = req.query.clean !== 'false';
    const result = sshManager.getOutput(req.params.id, since, clean, limit);
    if (!result) return res.status(404).json({ error: 'Session not found' });
    res.json(result);
  });

  app.get('/api/sessions/:id/history', requireAgentOrUiAuth, (req, res) => {
    const history = sshManager.getHistory(req.params.id);
    if (history === null) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.type('text/plain; charset=utf-8').send(history);
  });

  app.post('/api/sessions/:id/input', requireAgentOrUiAuth, jsonSmall, async (req, res) => {
    try {
      const { input, waitFor, timeout } = req.body || {};
      if (typeof input !== 'string' || input.length === 0) {
        return res.status(400).json({ error: 'Missing input' });
      }

      io.emit('session:ai_activity', { sessionId: req.params.id });

      if (waitFor) {
        const result = await sshManager.writeAndWait(req.params.id, input, waitFor, timeout);
        return res.json(result);
      }

      const success = sshManager.write(req.params.id, input);
      if (!success) return res.status(404).json({ error: 'Session not found' });
      const result = sshManager.getOutput(req.params.id, 0, false);
      res.json({ currentLine: result.currentLine });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post('/api/sessions/:id/signal', requireAgentOrUiAuth, jsonSmall, (req, res) => {
    try {
      const { signal } = req.body || {};
      if (!signal) return res.status(400).json({ error: 'Missing signal' });
      io.emit('session:ai_activity', { sessionId: req.params.id });
      sshManager.sendSignal(req.params.id, signal);
      res.json({ success: true });
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post('/api/sessions/:id/exec', requireAgentOrUiAuth, jsonSmall, async (req, res) => {
    const { command, timeoutMs } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Missing command' });
    }
    const sessionId = req.params.id;
    if (!sshManager.sessions.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    io.emit('session:ai_activity', { sessionId });

    const emitAndStore = (data) => {
      io.to(sessionId).emit('terminal:data', { sessionId, data });
      sshManager.appendToHistory(sessionId, data);
    };

    const formattedCmd = `\r\n\x1b[33m[Background Command]\x1b[0m \x1b[1m${command}\x1b[0m\r\n`;
    emitAndStore(formattedCmd);

    try {
      const result = await sshManager.exec(sessionId, command, {
        timeoutMs,
        onStdout: (data) => {
          emitAndStore(data.replace(/\r?\n/g, '\r\n'));
        },
        onStderr: (data) => {
          emitAndStore(`\x1b[31m${data.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
        }
      });
      const exitMsg = `\x1b[33m[Command Exited with Code: ${result.exitCode}]\x1b[0m\r\n`;
      emitAndStore(exitMsg);
      res.json(result);
    } catch (err) {
      const errMsg = `\x1b[31m[Background Command Error: ${err.message}]\x1b[0m\r\n`;
      emitAndStore(errMsg);
      sendApiError(res, err);
    }
  });

  app.get('/api/sessions/:id/files', requireAgentOrUiAuth, async (req, res) => {
    if (!req.query.path) {
      return res.status(400).json({ error: 'Missing path query parameter' });
    }
    try {
      const content = await sshManager.sftpReadFile(req.params.id, String(req.query.path));
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post('/api/sessions/:id/files', requireAgentOrUiAuth, jsonFiles, async (req, res) => {
    if (!req.query.path) {
      return res.status(400).json({ error: 'Missing path query parameter' });
    }
    const { content } = req.body || {};
    if (content === undefined) {
      return res.status(400).json({ error: 'Missing content body parameter' });
    }
    try {
      const result = await sshManager.sftpWriteFile(req.params.id, String(req.query.path), content);
      res.json(result);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  app.post('/api/sessions/:id/handoff', requireAgentOrUiAuth, jsonSmall, (req, res) => {
    const { message } = req.body || {};
    const msg = message || 'Manual assistance requested by AI';
    const success = sshManager.handoff(req.params.id, msg);
    if (!success) return res.status(404).json({ error: 'Session not found' });
    io.to(req.params.id).emit('session:status', { sessionId: req.params.id, status: 'user_control', message: msg });
    io.emit('session:status', { sessionId: req.params.id, status: 'user_control', message: msg });
    res.json({ success: true });
  });

  app.delete('/api/sessions/:id', requireAgentOrUiAuth, (req, res) => {
    const success = sshManager.disconnect(req.params.id, io);
    if (!success) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
  });

  app.get('/instructions', requireAgentOrUiAuth, (req, res) => {
    try {
      const content = loadInstructions(buildBaseUrl(req));
      res.type('text/plain; charset=utf-8').send(content);
    } catch {
      res.status(500).json({ error: 'Instructions file not found' });
    }
  });

  // Express JSON / body parser error handler
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request payload too large' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Malformed JSON request body' });
    }
    sendApiError(res, err);
  });

  // Restrict Socket.IO strictly to authenticated browser UI sessions
  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin) {
      try {
        const parsedOrigin = new URL(origin);
        if (!ALLOWED_HOSTNAMES.has(parsedOrigin.hostname.toLowerCase())) {
          return next(new Error('Forbidden origin'));
        }
      } catch {
        return next(new Error('Malformed origin'));
      }
    }

    const cookies = parseCookies(socket.handshake.headers.cookie);
    if (!timingSafeEqualStr(cookies[UI_COOKIE_NAME], uiOperatorToken)) {
      return next(new Error('Unauthorized UI session: reload dashboard page'));
    }
    next();
  });

  io.on('connection', (socket) => {
    socket.on('session:join', (sessionId) => {
      if (typeof sessionId === 'string' && sessionId) {
        socket.join(sessionId);
      }
    });

    socket.on('session:connect', async (payload = {}, ack) => {
      const { requestId, authConfig, name } = payload || {};
      try {
        if (!requestId) throw new ValidationError('Missing requestId');
        logger.error?.(
          `Attempting connection for request ${requestId} to ${authConfig?.host || 'requested host'}`
        );
        const session = await sshManager.connect(requestId, authConfig || {}, name, io);
        const summary = {
          id: session.id,
          name: session.name,
          status: session.status,
          transport: session.transport,
          isLocal: Boolean(session.isLocal),
          shell: session.shell || null
        };
        io.emit('session:request_removed', { requestId, status: 'approved', sessionId: session.id });
        io.emit('session:started', summary);
        if (typeof ack === 'function') ack({ ok: true, session: summary });
      } catch (err) {
        logger.error?.('Connection error:', err.message);
        socket.emit('session:connect_error', { requestId, message: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('session:connect_manual', async (payload = {}, ack) => {
      const { authConfig, name } = payload || {};
      try {
        const session = await sshManager.connectDirect(authConfig || {}, name, io);
        const summary = {
          id: session.id,
          name: session.name,
          status: session.status,
          transport: session.transport,
          isLocal: Boolean(session.isLocal),
          shell: session.shell || null
        };
        io.emit('session:started', summary);
        if (typeof ack === 'function') ack({ ok: true, session: summary });
      } catch (err) {
        logger.error?.('Manual connection error:', err.message);
        socket.emit('session:connect_error', { message: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('session:connect_local', async (payload = {}, ack) => {
      const { shell, cwd, cols, rows, name } = payload || {};
      try {
        const session = await sshManager.connectLocalDirect({ shell, cwd, cols, rows }, name, io);
        const summary = {
          id: session.id,
          name: session.name,
          status: session.status,
          transport: session.transport,
          isLocal: true,
          shell: session.shell
        };
        io.emit('session:started', summary);
        if (typeof ack === 'function') ack({ ok: true, session: summary });
      } catch (err) {
        logger.error?.('Local terminal error:', err.message);
        socket.emit('session:connect_error', { message: err.message });
        if (typeof ack === 'function') ack({ ok: false, error: err.message });
      }
    });

    socket.on('session:reject_request', (payload = {}, ack) => {
      const { requestId } = payload || {};
      if (!requestId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Missing requestId' });
        return;
      }
      const removed = sshManager.rejectRequest(requestId);
      if (!removed) {
        if (typeof ack === 'function') ack({ ok: false, error: new SessionNotFoundError('Request not found').message });
        return;
      }
      io.emit('session:request_removed', { requestId, status: 'rejected' });
      if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('terminal:input', ({ sessionId, data } = {}) => {
      try {
        sshManager.write(sessionId, data, true); // bypass control check for authenticated operator UI
      } catch (err) {
        logger.error?.('UI terminal input error:', err.message);
      }
    });

    socket.on('terminal:resize', ({ sessionId, cols, rows } = {}) => {
      sshManager.resize(sessionId, cols, rows);
    });

    socket.on('session:return_control', (sessionId) => {
      if (sshManager.returnControl(sessionId)) {
        io.to(sessionId).emit('session:status', { sessionId, status: 'ai_control', message: null });
        io.emit('session:status', { sessionId, status: 'ai_control', message: null });
      }
    });

    socket.on('session:set_recording', ({ sessionId, enabled } = {}) => {
      sshManager.setRecording(sessionId, enabled);
    });
  });

  const close = async () => {
    await mcpRouter.closeAll();
    sshManager.disconnectAll();
    await new Promise((resolve) => io.close(() => resolve()));
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };

  return {
    app,
    server,
    io,
    sshManager,
    uiOperatorToken,
    localBackend,
    close
  };
}

async function probeExistingGateway(baseUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.service === 'ai-ssh-gateway';
  } catch {
    return false;
  }
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    mcpStdio: false,
    port: Number(process.env.PORT) || 3000,
    gatewayUrl: process.env.GATEWAY_URL || null,
    apiKey: process.env.GATEWAY_API_KEY || null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mcp' || arg === '--stdio') {
      opts.mcpStdio = true;
    } else if (arg === '--port' || arg === '-p') {
      opts.port = Number(argv[++i]) || opts.port;
    } else if (arg.startsWith('--port=')) {
      opts.port = Number(arg.split('=')[1]) || opts.port;
    } else if (arg === '--gateway-url') {
      opts.gatewayUrl = argv[++i] || null;
    } else if (arg.startsWith('--gateway-url=')) {
      opts.gatewayUrl = arg.split('=')[1] || null;
    } else if (arg === '--api-key') {
      opts.apiKey = argv[++i] || null;
    } else if (arg.startsWith('--api-key=')) {
      opts.apiKey = arg.split('=')[1] || null;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

export async function runCli(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  const version = readPackageVersion();

  if (opts.help) {
    console.log(`AI SSH Gateway v${version}

Usage:
  ai-ssh-gateway [options]

Options:
  --port, -p <port>        Local HTTP/Web UI port (default: 3000 or PORT env)
  --mcp                    Start MCP server over stdio (attaches to or launches Web UI on 127.0.0.1:<port>)
  --gateway-url <url>      Connect --mcp stdio mode to an existing gateway URL
  --api-key <token>        Require Bearer API key for REST API & MCP requests (or GATEWAY_API_KEY env)
  --help, -h               Show help
`);
    return;
  }

  // In --mcp stdio mode, stdout MUST contain only JSON-RPC messages
  const log = opts.mcpStdio ? (...args) => console.error(...args) : (...args) => console.log(...args);
  const logger = {
    log,
    error: (...args) => console.error(...args)
  };

  if (opts.mcpStdio) {
    const candidateUrl = (opts.gatewayUrl || `http://127.0.0.1:${opts.port}`).replace(/\/+$/, '');
    if (opts.gatewayUrl || (await probeExistingGateway(candidateUrl))) {
      log(`[MCP] Connected stdio transport to running AI SSH Gateway at ${candidateUrl}`);
      const remoteBackend = createRemoteGatewayBackend({
        baseUrl: candidateUrl,
        apiKey: opts.apiKey
      });
      await startStdioMcpServer(remoteBackend, {
        version,
        onDisconnect: () => process.exit(0)
      });
      return;
    }

    const gateway = createGatewayServer({ apiKey: opts.apiKey, logger });
    await new Promise((resolve, reject) => {
      gateway.server.once('error', reject);
      gateway.server.listen(opts.port, '127.0.0.1', () => resolve());
    });
    const uiUrl = `http://127.0.0.1:${opts.port}`;
    log(`[MCP] AI SSH Gateway Web UI & HTTP server started at ${uiUrl} (MCP HTTP: ${uiUrl}/mcp)`);

    const stdioBackend = createLocalGatewayBackend({
      sshManager: gateway.sshManager,
      io: gateway.io,
      getInstructions: () => {
        const raw = fs.readFileSync(INSTRUCTIONS_PATH, 'utf8');
        return raw.replace(/\$\{baseUrl\}/g, uiUrl).trim();
      },
      uiUrl
    });
    let mcpStdio = null;
    const shutdown = async () => {
      if (mcpStdio) {
        await mcpStdio.transport.close().catch(() => {});
      }
      await gateway.close();
      process.exit(0);
    };
    mcpStdio = await startStdioMcpServer(stdioBackend, {
      version,
      onDisconnect: shutdown
    });

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  const gateway = createGatewayServer({ apiKey: opts.apiKey, logger });
  gateway.server.listen(opts.port, '127.0.0.1', () => {
    const uiUrl = `http://127.0.0.1:${opts.port}`;
    log(`AI SSH Gateway running at ${uiUrl}`);
    log(`MCP Streamable HTTP endpoint ready at ${uiUrl}/mcp`);
  });

  const shutdown = async () => {
    log('\nShutting down AI SSH Gateway...');
    await gateway.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return gateway;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  runCli().catch((err) => {
    console.error('Fatal error starting AI SSH Gateway:', err);
    process.exit(1);
  });
}

export default createGatewayServer;
