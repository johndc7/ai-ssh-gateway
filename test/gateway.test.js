import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2Pkg from 'ssh2';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateSshTarget } from '../src/netbird.js';
import { SSHManager } from '../src/ssh-manager.js';
import { createGatewayServer } from '../src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { Server: SshServer, utils: sshUtils } = ssh2Pkg;
const { STATUS_CODE } = sshUtils.sftp;

function startMockSshServer({ hostKeyPrivate } = {}) {
  const keys = hostKeyPrivate
    ? { private: hostKeyPrivate }
    : sshUtils.generateKeyPairSync('ed25519');
  const remoteFiles = new Map([['/etc/greeting.txt', 'hello from sftp\n']]);

  const sshServer = new SshServer({ hostKeys: [keys.private] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none' && ctx.username === 'nbuser') {
        return ctx.accept();
      }
      if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'secret123') {
        return ctx.accept();
      }
      ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty?.();
        });

        session.on('window-change', (acceptWin) => {
          acceptWin?.();
        });

        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          stream.write('Welcome to MockSSH\r\ntestuser@mock:~$ ');

          let lineBuf = '';
          stream.on('data', (chunk) => {
            const s = chunk.toString('utf8');
            if (s === '\x03') {
              stream.write('^C\r\ntestuser@mock:~$ ');
              lineBuf = '';
              return;
            }
            lineBuf += s;
            if (lineBuf.includes('\n')) {
              const cmd = lineBuf.trim();
              lineBuf = '';
              stream.write(`${cmd}\r\noutput:${cmd}\r\ntestuser@mock:~$ `);
            }
          });
        });

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          if (info.command.startsWith('echo ')) {
            stream.write(`${info.command.slice(5)}\n`);
            stream.exit(0);
            stream.end();
          } else if (info.command === 'failcmd') {
            stream.stderr.write('something went wrong\n');
            stream.exit(2);
            stream.end();
          } else {
            stream.write(`ran:${info.command}\n`);
            stream.exit(0);
            stream.end();
          }
        });

        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const openHandles = new Map();
          let handleSeq = 1;

          sftp.on('OPEN', (reqid, filename, flags) => {
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(handleSeq++, 0);
            // Write/truncate flags create or clear entry
            const isWrite = Boolean(flags & 0x00000002) || Boolean(flags & 0x00000008) || Boolean(flags & 0x00000010);
            if (isWrite && (flags & 0x00000010)) {
              remoteFiles.set(filename, '');
            } else if (!isWrite && !remoteFiles.has(filename)) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            openHandles.set(handle.toString('hex'), { filename, readDone: false });
            sftp.handle(reqid, handle);
          });

          sftp.on('FSTAT', (reqid, handle) => {
            const entry = openHandles.get(handle.toString('hex'));
            if (!entry || !remoteFiles.has(entry.filename)) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            const buf = Buffer.from(remoteFiles.get(entry.filename), 'utf8');
            sftp.attrs(reqid, { mode: 0o100644, size: buf.length, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
          });

          sftp.on('STAT', (reqid, filename) => {
            if (!remoteFiles.has(filename)) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            const buf = Buffer.from(remoteFiles.get(filename), 'utf8');
            sftp.attrs(reqid, { mode: 0o100644, size: buf.length, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
          });

          sftp.on('READ', (reqid, handle, offset, length) => {
            const entry = openHandles.get(handle.toString('hex'));
            if (!entry || !remoteFiles.has(entry.filename)) {
              return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }
            const buf = Buffer.from(remoteFiles.get(entry.filename), 'utf8');
            if (offset >= buf.length) {
              return sftp.status(reqid, STATUS_CODE.EOF);
            }
            sftp.data(reqid, buf.subarray(offset, offset + length));
          });

          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const entry = openHandles.get(handle.toString('hex'));
            if (!entry) return sftp.status(reqid, STATUS_CODE.FAILURE);
            const existing = Buffer.from(remoteFiles.get(entry.filename) || '', 'utf8');
            const target = Buffer.alloc(Math.max(existing.length, offset + data.length));
            existing.copy(target, 0);
            data.copy(target, offset);
            remoteFiles.set(entry.filename, target.toString('utf8'));
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('CLOSE', (reqid, handle) => {
            openHandles.delete(handle.toString('hex'));
            sftp.status(reqid, STATUS_CODE.OK);
          });
        });
      });
    });
  });

  return new Promise((resolve, reject) => {
    sshServer.once('error', reject);
    sshServer.listen(0, '127.0.0.1', () => {
      const { port } = sshServer.address();
      resolve({
        sshServer,
        port,
        remoteFiles,
        privateKey: keys.private,
        close: () => new Promise((r) => sshServer.close(() => r()))
      });
    });
  });
}

test('validateSshTarget rejects CLI option injection and invalid ports', () => {
  assert.deepEqual(validateSshTarget('10.0.0.5', 2222), { host: '10.0.0.5', port: 2222 });
  assert.throws(() => validateSshTarget('-oProxyCommand=evil', 22), /Invalid characters/);
  assert.throws(() => validateSshTarget('bad host', 22), /Invalid characters/);
  assert.throws(() => validateSshTarget('example.com', 70000), /Invalid SSH port/);
});

test('SSHManager getOutput pagination never skips completed partial lines', () => {
  const manager = new SSHManager();
  const fakeSession = {
    id: 's1',
    outputBuffer: [],
    currentLine: 0,
    partialLine: '',
    isRecording: true
  };
  manager.sessions.set('s1', fakeSession);

  manager._handleOutput(fakeSession, 'Welcome\r\nuser@host:~$ ');
  const poll1 = manager.getOutput('s1', 0, true);
  assert.deepEqual(poll1.lines, ['Welcome', 'user@host:~$ ']);
  assert.equal(poll1.currentLine, 1);

  // Now the prompt completes with a command and produces output + a new prompt
  manager._handleOutput(fakeSession, 'ls\r\nfileA.txt\r\nuser@host:~$ ');
  const poll2 = manager.getOutput('s1', poll1.currentLine, true);
  assert.deepEqual(poll2.lines, ['user@host:~$ ls', 'fileA.txt', 'user@host:~$ ']);
  assert.equal(poll2.currentLine, 3);
});

test('End-to-end REST API, SFTP, exec streaming, user_control lock, host-key TOFU, NetBird proxy, and MCP', async (t) => {
  const mockSsh = await startMockSshServer();

  // Mock NetBird adapter tunneling `jwt` proxy socket to our local mock SSH server
  const sshManager = new SSHManager({
    netbird: {
      getNetbirdStatus: async () => ({ available: true, binaryPath: 'mock-netbird', version: '0.81.3' }),
      detectNetbirdSsh: async () => ({ mode: 'jwt', exitCode: 0 }),
      createNetbirdProxySocket: async (_host, port) => {
        const tcpSock = net.connect(port, '127.0.0.1');
        return tcpSock;
      }
    }
  });

  const gateway = createGatewayServer({ sshManager });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const { port: httpPort } = gateway.server.address();
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  t.after(async () => {
    await gateway.close();
    await mockSsh.close();
  });

  // 1. DNS Rebinding protection blocks foreign Host header (use http.get since WHATWG fetch strips Host)
  const rebindStatus = await new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: httpPort,
        path: '/api/sessions',
        headers: { Host: 'attacker.example.com' }
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on('error', reject);
  });
  assert.equal(rebindStatus, 403);

  // 2. Dashboard issues HttpOnly SameSite=Strict operator cookie
  const indexRes = await fetch(`${baseUrl}/`);
  assert.equal(indexRes.status, 200);
  const setCookie = indexRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /gateway_ui_token=[a-f0-9]+; HttpOnly; SameSite=Strict/);
  const uiCookie = setCookie.split(';')[0];

  // 3. Instructions served as text/plain (not text/html)
  const instRes = await fetch(`${baseUrl}/instructions`);
  assert.equal(instRes.status, 200);
  assert.match(instRes.headers.get('content-type') || '', /^text\/plain/);

  // 4. Request session & reject request via operator UI cookie
  const req1Res = await fetch(`${baseUrl}/api/sessions/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: '127.0.0.1', port: mockSsh.port, username: 'testuser', reason: 'Reject test' })
  });
  assert.equal(req1Res.status, 200);
  const req1 = await req1Res.json();

  // Rejecting without UI cookie must be forbidden (403)
  const badReject = await fetch(`${baseUrl}/api/sessions/requests/${req1.id}`, { method: 'DELETE' });
  assert.equal(badReject.status, 403);

  const okReject = await fetch(`${baseUrl}/api/sessions/requests/${req1.id}`, {
    method: 'DELETE',
    headers: { Cookie: uiCookie }
  });
  assert.equal(okReject.status, 200);

  // 5. Connect standard SSH session & test PTY writeAndWait, exec streaming, SFTP, and handoff lock
  const req2 = sshManager.createRequest('127.0.0.1', 'testuser', 'E2E test', { port: mockSsh.port });
  const session = await sshManager.connect(req2.id, {
    host: '127.0.0.1',
    port: mockSsh.port,
    username: 'testuser',
    password: 'secret123',
    knownHostsPath: 'C:/nonexistent-known-hosts-for-test'
  }, 'testuser@127.0.0.1', gateway.io);

  // Invalid waitFor regex returns 400 JSON
  const badRegexRes = await fetch(`${baseUrl}/api/sessions/${session.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'whoami\n', waitFor: '[unclosed' })
  });
  assert.equal(badRegexRes.status, 400);

  // Valid writeAndWait matches prompt
  const waitRes = await fetch(`${baseUrl}/api/sessions/${session.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: 'hello\n', waitFor: 'output:hello', timeout: 5000 })
  });
  assert.equal(waitRes.status, 200);
  const waitJson = await waitRes.json();
  assert.ok(waitJson.lines.some((l) => l.includes('output:hello')));

  // Exec command streams output into session raw history AND returns stdout/exitCode
  const execRes = await fetch(`${baseUrl}/api/sessions/${session.id}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo streamed-check' })
  });
  assert.equal(execRes.status, 200);
  const execJson = await execRes.json();
  assert.equal(execJson.exitCode, 0);
  assert.equal(execJson.stdout.trim(), 'streamed-check');

  const historyRes = await fetch(`${baseUrl}/api/sessions/${session.id}/history`);
  assert.match(historyRes.headers.get('content-type') || '', /^text\/plain/);
  const historyText = await historyRes.text();
  assert.match(historyText, /streamed-check/);

  // SFTP Read & Write
  const readRes = await fetch(`${baseUrl}/api/sessions/${session.id}/files?path=${encodeURIComponent('/etc/greeting.txt')}`);
  assert.equal(readRes.status, 200);
  assert.match(readRes.headers.get('content-type') || '', /^text\/plain/);
  assert.equal(await readRes.text(), 'hello from sftp\n');

  const writeRes = await fetch(`${baseUrl}/api/sessions/${session.id}/files?path=${encodeURIComponent('/tmp/new.txt')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'updated via sftp' })
  });
  assert.equal(writeRes.status, 200);
  assert.equal(mockSsh.remoteFiles.get('/tmp/new.txt'), 'updated via sftp');

  // Handoff puts session into user_control and blocks AI input, signal, exec, and SFTP with 403 JSON
  const handoffRes = await fetch(`${baseUrl}/api/sessions/${session.id}/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Need sudo password' })
  });
  assert.equal(handoffRes.status, 200);

  for (const blockedCall of [
    fetch(`${baseUrl}/api/sessions/${session.id}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'ls\n' })
    }),
    fetch(`${baseUrl}/api/sessions/${session.id}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal: 'SIGINT' })
    }),
    fetch(`${baseUrl}/api/sessions/${session.id}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'id' })
    }),
    fetch(`${baseUrl}/api/sessions/${session.id}/files?path=/etc/greeting.txt`)
  ]) {
    const r = await blockedCall;
    assert.equal(r.status, 403);
  }

  sshManager.returnControl(session.id);

  // 6. NetBird SSH (JWT proxy tunnel) end-to-end connection
  const nbSession = await sshManager.connectDirect({
    host: '127.0.0.1',
    port: mockSsh.port,
    username: 'nbuser',
    useNetbird: true
  }, 'nbuser@peer.netbird.cloud', gateway.io);
  assert.equal(nbSession.transport, 'netbird-jwt');

  const nbExec = await sshManager.exec(nbSession.id, 'echo via-netbird');
  assert.equal(nbExec.stdout.trim(), 'via-netbird');

  // 7. MCP Streamable HTTP Client end-to-end against /mcp
  const mcpClient = new McpClient({ name: 'test-mcp-client', version: '1.0.0' });
  const mcpTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  await mcpClient.connect(mcpTransport);

  const toolsList = await mcpClient.listTools();
  const toolNames = toolsList.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('list_sessions'));
  assert.ok(toolNames.includes('request_session'));
  assert.ok(toolNames.includes('request_local_session'));
  assert.ok(toolNames.includes('exec_command'));
  assert.ok(toolNames.includes('read_remote_file'));
  assert.ok(toolNames.includes('write_remote_file'));

  const listResult = await mcpClient.callTool({ name: 'list_sessions', arguments: {} });
  const parsedSessions = JSON.parse(listResult.content[0].text);
  assert.equal(parsedSessions.active.length, 2);
  assert.equal(parsedSessions.netbird.available, true);
  assert.ok(Array.isArray(parsedSessions.localShells));
  assert.ok(parsedSessions.localShells.some((s) => s.available));

  const mcpExecResult = await mcpClient.callTool({
    name: 'exec_command',
    arguments: { sessionId: nbSession.id, command: 'echo hello-from-mcp' }
  });
  const parsedExec = JSON.parse(mcpExecResult.content[0].text);
  assert.equal(parsedExec.stdout.trim(), 'hello-from-mcp');

  await mcpClient.callTool({
    name: 'close_session',
    arguments: { sessionId: nbSession.id }
  });
  await mcpTransport.close();

  // 8. MCP Stdio CLI mode (--mcp) automatically attaches to the running local gateway
  const stdioClient = new McpClient({ name: 'test-stdio-client', version: '1.0.0' });
  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '../bin/server.js'), '--mcp', '--port', String(httpPort)],
    stderr: 'pipe'
  });
  await stdioClient.connect(stdioTransport);
  const stdioList = await stdioClient.callTool({ name: 'list_sessions', arguments: {} });
  const stdioParsed = JSON.parse(stdioList.content[0].text);
  assert.equal(stdioParsed.active.length, 1);
  assert.equal(stdioParsed.active[0].id, session.id);
  await stdioTransport.close();

  // 9. Host Key Mismatch Detection (TOFU recorded mockSsh's key; a different server key on same host:port must fail!)
  sshManager.disconnect(session.id);
  await mockSsh.close();
  const imposterKeys = sshUtils.generateKeyPairSync('ed25519');
  const imposterServer = new SshServer({ hostKeys: [imposterKeys.private] }, (c) => {
    c.on('error', () => {});
    c.on('authentication', (ctx) => ctx.accept());
  });
  await new Promise((resolve) => imposterServer.listen(mockSsh.port, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      () =>
        sshManager.connectDirect({
          host: '127.0.0.1',
          port: mockSsh.port,
          username: 'testuser',
          password: 'secret123',
          knownHostsPath: 'C:/nonexistent-known-hosts-for-test'
        }),
      /Host key mismatch/
    );
  } finally {
    await new Promise((resolve) => imposterServer.close(() => resolve()));
  }
});

test('Local shell sessions (cmd / powershell / sh) support interactive ConPTY writeAndWait, exec, and request approval', async (t) => {
  const sshManager = new SSHManager();
  const gateway = createGatewayServer({ sshManager });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const { port: httpPort } = gateway.server.address();
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  t.after(async () => {
    await gateway.close();
  });

  const preferredShell = process.platform === 'win32' ? 'cmd' : 'sh';

  // Request a local shell via REST API
  const reqRes = await fetch(`${baseUrl}/api/sessions/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'local', shell: preferredShell, reason: 'Local diagnostics' })
  });
  assert.equal(reqRes.status, 200);
  const localReq = await reqRes.json();
  assert.equal(localReq.type, 'local');
  assert.equal(localReq.shell, preferredShell);

  // Approve and establish local terminal session
  const localSession = await sshManager.connect(localReq.id, { type: 'local', shell: preferredShell }, null, gateway.io);
  assert.equal(localSession.isLocal, true);
  assert.equal(localSession.shell, preferredShell);

  // Interactive PTY writeAndWait submitting with trailing \n (auto-normalized to \r on Windows ConPTY)
  const waitRes = await fetch(`${baseUrl}/api/sessions/${localSession.id}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: 'echo LOCAL_PTY_SUCCESS\n',
      waitFor: 'LOCAL_PTY_SUCCESS',
      timeout: 8000
    })
  });
  assert.equal(waitRes.status, 200);
  const waitJson = await waitRes.json();
  assert.ok(waitJson.lines.some((l) => l.includes('LOCAL_PTY_SUCCESS')));

  // Non-interactive exec on local session
  const execRes = await fetch(`${baseUrl}/api/sessions/${localSession.id}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo LOCAL_EXEC_SUCCESS' })
  });
  assert.equal(execRes.status, 200);
  const execJson = await execRes.json();
  assert.equal(execJson.exitCode, 0);
  assert.match(execJson.stdout, /LOCAL_EXEC_SUCCESS/);

  // Also test PowerShell on Windows if available
  if (process.platform === 'win32') {
    const psSession = await sshManager.connectLocalDirect({ shell: 'powershell' }, 'Local PS', gateway.io);
    const psExec = await sshManager.exec(psSession.id, 'Write-Output ("PS_" + (20 + 22))');
    assert.equal(psExec.exitCode, 0);
    assert.equal(psExec.stdout.trim(), 'PS_42');
    sshManager.disconnect(psSession.id);
  }

  sshManager.disconnect(localSession.id);
});
