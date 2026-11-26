import { Client } from 'ssh2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import stripAnsi from 'strip-ansi';
import {
  validateSshTarget,
  getNetbirdStatus,
  detectNetbirdSsh,
  createNetbirdProxySocket
} from './netbird.js';
import {
  getAvailableLocalShells,
  resolveShellDefinition,
  resolveWorkingDirectory,
  spawnLocalShellStream,
  execLocalCommand,
  getLocalUsername
} from './local-shell.js';

export class GatewayError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class ValidationError extends GatewayError {
  constructor(message) {
    super(message, 400);
  }
}

export class SessionAccessDeniedError extends GatewayError {
  constructor(message = 'Access Denied: Session is under User Control') {
    super(message, 403);
  }
}

export class SessionNotFoundError extends GatewayError {
  constructor(message = 'Session not found') {
    super(message, 404);
  }
}

const MAX_OUTPUT_LINES = 10000;
const MAX_RAW_HISTORY_CHARS = 500000;
const DEFAULT_EXEC_MAX_BUFFER = 5 * 1024 * 1024; // 5 MB
const DEFAULT_EXEC_TIMEOUT_MS = 120000; // 2 minutes
const MAX_WAIT_TIMEOUT_MS = 120000;
const MAX_REGEX_LENGTH = 512;
const MAX_WAIT_CAPTURE_CHARS = 65536;
const PENDING_REQUEST_TTL_MS = 30 * 60 * 1000; // 30 minutes

function computeFingerprint(keyBuffer) {
  const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

function formatHostKeyId(host, port) {
  const normalized = host.toLowerCase();
  return port && Number(port) !== 22 ? `[${normalized}]:${port}` : normalized;
}

function lookupKnownHostKeys(host, port, knownHostsPath) {
  const filePath = knownHostsPath || path.join(os.homedir(), '.ssh', 'known_hosts');
  if (!fs.existsSync(filePath)) return [];

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const targetId = formatHostKeyId(host, port);
  const matchedKeys = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('@revoked')) continue;

    // Optional marker like @cert-authority
    const tokens = line.split(/\s+/);
    let idx = 0;
    if (tokens[0].startsWith('@')) idx = 1;
    if (tokens.length < idx + 3) continue;

    const hostSpec = tokens[idx];
    const keyBase64 = tokens[idx + 2];
    if (!keyBase64) continue;

    if (hostSpec.startsWith('|1|')) {
      // Hashed OpenSSH entry: |1|base64Salt|base64Hash
      const parts = hostSpec.split('|');
      if (parts.length === 4) {
        try {
          const salt = Buffer.from(parts[2], 'base64');
          const expected = parts[3];
          const computed = crypto.createHmac('sha1', salt).update(targetId).digest('base64');
          if (computed === expected) {
            matchedKeys.push(keyBase64);
          }
        } catch {
          // Ignore malformed entry
        }
      }
    } else {
      const patterns = hostSpec.split(',').map((h) => h.trim().toLowerCase());
      if (patterns.includes(targetId)) {
        matchedKeys.push(keyBase64);
      }
    }
  }

  return matchedKeys;
}

export class SSHManager extends EventEmitter {
  constructor({ netbird = {}, localShell = {} } = {}) {
    super();
    this.sessions = new Map(); // id -> session data
    this.pendingRequests = new Map(); // id -> request data
    this.requestWaiters = new Map(); // requestId -> Set<{ resolve, reject, timer }>
    this.trustedHostKeys = new Map(); // hostKeyId -> Set<base64Key>
    this.netbirdAdapter = {
      getNetbirdStatus: netbird.getNetbirdStatus || getNetbirdStatus,
      detectNetbirdSsh: netbird.detectNetbirdSsh || detectNetbirdSsh,
      createNetbirdProxySocket: netbird.createNetbirdProxySocket || createNetbirdProxySocket
    };
    this.localShellAdapter = {
      getAvailableLocalShells: localShell.getAvailableLocalShells || getAvailableLocalShells,
      resolveShellDefinition: localShell.resolveShellDefinition || resolveShellDefinition,
      spawnLocalShellStream: localShell.spawnLocalShellStream || spawnLocalShellStream,
      execLocalCommand: localShell.execLocalCommand || execLocalCommand
    };
  }

  _pruneExpiredRequests() {
    const cutoff = Date.now() - PENDING_REQUEST_TTL_MS;
    for (const [id, req] of this.pendingRequests.entries()) {
      if (req.createdAt.getTime() < cutoff) {
        this.rejectRequest(id, 'Connection request expired');
      }
    }
  }

  createRequest(host, username, reason, options = {}) {
    this._pruneExpiredRequests();
    if (!username || typeof username !== 'string' || !username.trim()) {
      throw new ValidationError('Missing or invalid username');
    }
    let validated;
    try {
      validated = validateSshTarget(host, options.port ?? 22);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const id = crypto.randomUUID();
    const request = {
      id,
      type: 'ssh',
      host: validated.host,
      port: validated.port,
      username: username.trim(),
      reason: typeof reason === 'string' ? reason.trim() : '',
      useNetbird: Boolean(options.useNetbird),
      status: 'pending',
      createdAt: new Date()
    };
    this.pendingRequests.set(id, request);
    this.emit('request:created', request);
    return request;
  }

  async createLocalRequest(shell, reason, options = {}) {
    this._pruneExpiredRequests();
    let shellDef;
    let resolvedCwd;
    try {
      shellDef = await this.localShellAdapter.resolveShellDefinition(shell);
      resolvedCwd = resolveWorkingDirectory(options.cwd);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const id = crypto.randomUUID();
    const request = {
      id,
      type: 'local',
      shell: shellDef.id,
      shellLabel: shellDef.label,
      cwd: resolvedCwd,
      host: 'localhost',
      port: null,
      username: getLocalUsername(),
      reason: typeof reason === 'string' ? reason.trim() : '',
      useNetbird: false,
      status: 'pending',
      createdAt: new Date()
    };
    this.pendingRequests.set(id, request);
    this.emit('request:created', request);
    return request;
  }

  rejectRequest(requestId, reason = 'Connection request rejected by operator') {
    const req = this.pendingRequests.get(requestId);
    if (!req) return false;
    this.pendingRequests.delete(requestId);
    this._settleRequestWaiters(requestId, null, new SessionAccessDeniedError(reason));
    this.emit('request:removed', { requestId, status: 'rejected' });
    return true;
  }

  waitForRequestResolution(requestId, timeoutMs = 120000) {
    if (!this.pendingRequests.has(requestId)) {
      return Promise.reject(new SessionNotFoundError('Pending request not found'));
    }
    const clamped = Math.min(Math.max(1000, Number(timeoutMs) || 120000), 600000);
    return new Promise((resolve, reject) => {
      let waiters = this.requestWaiters.get(requestId);
      if (!waiters) {
        waiters = new Set();
        this.requestWaiters.set(requestId, waiters);
      }
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(entry);
          if (waiters.size === 0) this.requestWaiters.delete(requestId);
          resolve({ status: 'pending', requestId, timeout: true });
        }, clamped)
      };
      waiters.add(entry);
    });
  }

  _settleRequestWaiters(requestId, sessionSummary, err = null) {
    const waiters = this.requestWaiters.get(requestId);
    if (!waiters) return;
    this.requestWaiters.delete(requestId);
    for (const entry of waiters) {
      clearTimeout(entry.timer);
      if (err) entry.reject(err);
      else entry.resolve({ status: 'connected', session: sessionSummary });
    }
  }

  async connect(requestId, authConfig = {}, name, io) {
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new SessionNotFoundError('Request not found');

    let session;
    if (request.type === 'local' || authConfig.type === 'local') {
      session = await this._establishLocalSession(
        {
          shell: authConfig.shell || request.shell,
          cwd: authConfig.cwd || request.cwd,
          cols: authConfig.cols,
          rows: authConfig.rows
        },
        name,
        io
      );
    } else {
      const mergedConfig = {
        ...authConfig,
        host: authConfig.host || request.host,
        port: authConfig.port || request.port || 22,
        username: authConfig.username || request.username,
        useNetbird: authConfig.useNetbird !== undefined ? Boolean(authConfig.useNetbird) : Boolean(request.useNetbird)
      };
      session = await this._establishSession(mergedConfig, name, io);
    }

    this.pendingRequests.delete(requestId);
    this.emit('request:removed', { requestId, status: 'approved', sessionId: session.id });
    this._settleRequestWaiters(requestId, {
      id: session.id,
      name: session.name,
      status: session.status,
      transport: session.transport,
      isLocal: Boolean(session.isLocal),
      shell: session.shell || null
    });
    return session;
  }

  async connectDirect(authConfig = {}, name, io) {
    if (authConfig && authConfig.type === 'local') {
      return this._establishLocalSession(authConfig, name, io);
    }
    return this._establishSession(authConfig, name, io);
  }

  async connectLocalDirect(localConfig = {}, name, io) {
    return this._establishLocalSession(localConfig, name, io);
  }

  async _establishLocalSession(localConfig = {}, name, io) {
    let shellInfo;
    let resolvedCwd;
    try {
      shellInfo = await this.localShellAdapter.resolveShellDefinition(localConfig.shell);
      resolvedCwd = resolveWorkingDirectory(localConfig.cwd);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const sessionId = crypto.randomUUID();
    const { stream, isPty, pid } = this.localShellAdapter.spawnLocalShellStream(shellInfo, {
      cwd: resolvedCwd,
      cols: localConfig.cols,
      rows: localConfig.rows
    });

    const ptyDecoder = new StringDecoder('utf8');
    const localUser = getLocalUsername();
    const session = {
      id: sessionId,
      name: name || `Local (${shellInfo.id})`,
      isLocal: true,
      shell: shellInfo.id,
      shellInfo,
      cwd: resolvedCwd,
      isPty,
      pid,
      host: 'localhost',
      port: null,
      username: localUser,
      transport: `local-${shellInfo.id}`,
      hostKeyFingerprint: null,
      conn: null,
      stream,
      sftp: null,
      sftpPromise: null,
      proxySocket: null,
      status: 'ai_control',
      outputBuffer: [],
      currentLine: 0,
      isRecording: true,
      partialLine: '',
      handoffMessage: null,
      rawBuffer: ''
    };

    const cleanupSession = () => {
      if (!this.sessions.has(sessionId)) return;
      const trailing = ptyDecoder.end();
      if (trailing && session.isRecording) {
        this._handleOutput(session, trailing);
      }
      this.sessions.delete(sessionId);
      if (io) {
        io.to(sessionId).emit('session:closed', { sessionId });
        io.emit('session:closed', { sessionId });
      }
      try {
        stream.destroy?.();
      } catch {
        // ignore
      }
    };

    stream.on('data', (data) => {
      const str = ptyDecoder.write(data);
      if (!str) return;

      this._appendRaw(session, str);

      if (io) {
        io.to(sessionId).emit('terminal:data', { sessionId, data: str });
      }

      if (session.isRecording) {
        this._handleOutput(session, str);
      }
    });

    stream.on('close', cleanupSession);

    this.sessions.set(sessionId, session);
    return session;
  }

  _verifyHostKey(host, port, keyBuffer, { strictHostKeyChecking = false, knownHostsPath } = {}) {
    const keyBase64 = keyBuffer.toString('base64');
    const presentedFp = computeFingerprint(keyBuffer);
    const hostKeyId = formatHostKeyId(host, port);

    const diskKeys = lookupKnownHostKeys(host, port, knownHostsPath);
    const memoryKeys = this.trustedHostKeys.get(hostKeyId);
    const knownSet = new Set([...diskKeys, ...(memoryKeys || [])]);

    if (knownSet.size > 0) {
      if (knownSet.has(keyBase64)) {
        return { trusted: true, fingerprint: presentedFp };
      }
      return {
        trusted: false,
        fingerprint: presentedFp,
        reason: `Host key mismatch for ${hostKeyId} (got ${presentedFp}). Connection refused to prevent potential MITM attack.`
      };
    }

    if (strictHostKeyChecking) {
      return {
        trusted: false,
        fingerprint: presentedFp,
        reason: `Unknown host key (${presentedFp}) for ${hostKeyId} rejected (strict host key checking enabled).`
      };
    }

    // Trust-On-First-Use (TOFU) for session lifetime
    if (!this.trustedHostKeys.has(hostKeyId)) {
      this.trustedHostKeys.set(hostKeyId, new Set());
    }
    this.trustedHostKeys.get(hostKeyId).add(keyBase64);
    return { trusted: true, fingerprint: presentedFp };
  }

  async _establishSession(authConfig, name, io) {
    if (!authConfig || typeof authConfig !== 'object') {
      throw new ValidationError('Missing authentication configuration');
    }
    if (!authConfig.username || typeof authConfig.username !== 'string' || !authConfig.username.trim()) {
      throw new ValidationError('Missing SSH username');
    }

    let validated;
    try {
      validated = validateSshTarget(authConfig.host, authConfig.port ?? 22);
    } catch (err) {
      throw new ValidationError(err.message);
    }

    const sessionHost = validated.host;
    const sessionPort = validated.port;
    const sessionUser = authConfig.username.trim();
    const useNetbird = Boolean(authConfig.useNetbird || authConfig.authType === 'netbird');

    let proxySocket = null;
    let transportType = 'ssh';

    if (useNetbird) {
      const detection = await this.netbirdAdapter.detectNetbirdSsh(sessionHost, sessionPort);
      if (detection.mode === 'jwt') {
        transportType = 'netbird-jwt';
        proxySocket = await this.netbirdAdapter.createNetbirdProxySocket(sessionHost, sessionPort, {
          noBrowser: Boolean(authConfig.netbirdNoBrowser),
          noCache: Boolean(authConfig.netbirdNoCache),
          onStderr: (msg) => {
            const trimmed = msg.trim();
            if (trimmed && io) {
              io.emit('session:netbird_info', { host: sessionHost, message: trimmed });
            }
          }
        });
      } else if (detection.mode === 'no-jwt') {
        transportType = 'netbird-machine';
      } else if (detection.mode === 'regular-ssh') {
        const hasFallbackAuth = Boolean(authConfig.password || authConfig.privateKey || authConfig.useAgent);
        if (!hasFallbackAuth) {
          throw new GatewayError(
            `Host ${sessionHost}:${sessionPort} is running regular SSH rather than NetBird SSH (or --allow-server-ssh is disabled on peer). Provide SSH credentials or enable NetBird SSH on the target.`,
            400
          );
        }
        transportType = 'netbird-mesh-ssh';
      } else {
        // Attempt proxy as fallback in case `detect` timed out while waiting on daemon/tunnel
        transportType = 'netbird-proxy';
        proxySocket = await this.netbirdAdapter.createNetbirdProxySocket(sessionHost, sessionPort, {
          noBrowser: Boolean(authConfig.netbirdNoBrowser),
          noCache: Boolean(authConfig.netbirdNoCache),
          onStderr: (msg) => {
            const trimmed = msg.trim();
            if (trimmed && io) {
              io.emit('session:netbird_info', { host: sessionHost, message: trimmed });
            }
          }
        });
      }
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const sessionId = crypto.randomUUID();
      let settled = false;
      let hostKeyError = null;
      let kbPasswordAttempted = false;

      const failBeforeReady = (err) => {
        if (settled) return;
        settled = true;
        if (proxySocket && !proxySocket.destroyed) {
          proxySocket.destroy();
        }
        try {
          conn.end();
        } catch {
          // ignore
        }
        reject(err);
      };

      if (proxySocket) {
        proxySocket.on('error', (err) => {
          failBeforeReady(err);
        });
      }

      conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        if (!prompts || prompts.length === 0) {
          finish([]);
          return;
        }
        if (authConfig.password && !kbPasswordAttempted && prompts.length === 1) {
          kbPasswordAttempted = true;
          finish([authConfig.password]);
          return;
        }
        finish(prompts.map(() => ''));
      });

      let hostKeyFingerprint = null;

      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            return failBeforeReady(err);
          }

          const ptyDecoder = new StringDecoder('utf8');
          const session = {
            id: sessionId,
            name: name || `${sessionUser}@${sessionHost}`,
            host: sessionHost,
            port: sessionPort,
            username: sessionUser,
            transport: transportType,
            hostKeyFingerprint,
            conn,
            stream,
            sftp: null,
            sftpPromise: null,
            proxySocket,
            status: 'ai_control',
            outputBuffer: [],
            currentLine: 0,
            isRecording: true,
            partialLine: '',
            handoffMessage: null,
            rawBuffer: ''
          };

          const cleanupSession = () => {
            if (!this.sessions.has(sessionId)) return;
            const trailing = ptyDecoder.end();
            if (trailing && session.isRecording) {
              this._handleOutput(session, trailing);
            }
            this.sessions.delete(sessionId);
            if (io) {
              io.to(sessionId).emit('session:closed', { sessionId });
              io.emit('session:closed', { sessionId });
            }
            if (proxySocket && !proxySocket.destroyed) {
              proxySocket.destroy();
            }
            try {
              conn.end();
            } catch {
              // ignore
            }
          };

          stream.on('data', (data) => {
            const str = ptyDecoder.write(data);
            if (!str) return;

            this._appendRaw(session, str);

            if (io) {
              io.to(sessionId).emit('terminal:data', { sessionId, data: str });
            }

            if (session.isRecording) {
              this._handleOutput(session, str);
            }
          });

          stream.on('close', cleanupSession);
          conn.on('close', cleanupSession);
          conn.on('end', cleanupSession);

          this.sessions.set(sessionId, session);
          settled = true;
          resolve(session);
        });
      });

      conn.on('error', (err) => {
        if (!settled) {
          if (hostKeyError) {
            failBeforeReady(new GatewayError(hostKeyError, 400));
          } else {
            failBeforeReady(err);
          }
        } else {
          // Active session encountered a transport error; ensure cleanup runs
          const existing = this.sessions.get(sessionId);
          if (existing) {
            this.disconnect(sessionId, io);
          }
        }
      });

      const connectConfig = {
        username: sessionUser,
        readyTimeout: Number(authConfig.readyTimeout) || 30000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        tryKeyboard: Boolean(authConfig.password || useNetbird)
      };

      if (proxySocket) {
        connectConfig.sock = proxySocket;
        // NetBird proxy uses ephemeral local host keys after validating peer identity
        connectConfig.hostVerifier = (keyBuf) => {
          hostKeyFingerprint = computeFingerprint(keyBuf);
          return true;
        };
      } else {
        connectConfig.host = sessionHost;
        connectConfig.port = sessionPort;
        connectConfig.hostVerifier = (keyBuf) => {
          if (transportType === 'netbird-machine' && !authConfig.strictHostKeyChecking) {
            hostKeyFingerprint = computeFingerprint(keyBuf);
            return true;
          }
          const check = this._verifyHostKey(sessionHost, sessionPort, keyBuf, {
            strictHostKeyChecking: Boolean(authConfig.strictHostKeyChecking),
            knownHostsPath: authConfig.knownHostsPath
          });
          hostKeyFingerprint = check.fingerprint;
          if (!check.trusted) {
            hostKeyError = check.reason;
            return false;
          }
          return true;
        };
      }

      if (useNetbird && !authConfig.password && !authConfig.privateKey && !authConfig.useAgent) {
        connectConfig.authHandler = ['none', 'keyboard-interactive', 'publickey', 'password'];
      } else {
        if (authConfig.password) {
          connectConfig.password = authConfig.password;
        }
        if (authConfig.privateKey) {
          connectConfig.privateKey = authConfig.privateKey;
          if (authConfig.passphrase) {
            connectConfig.passphrase = authConfig.passphrase;
          }
        }
        if (authConfig.useAgent || authConfig.authType === 'agent') {
          connectConfig.agent =
            authConfig.agent ||
            process.env.SSH_AUTH_SOCK ||
            (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
          if (!connectConfig.agent) {
            return failBeforeReady(
              new ValidationError('SSH Agent requested, but SSH_AUTH_SOCK is not set.')
            );
          }
        }
      }

      try {
        conn.connect(connectConfig);
      } catch (err) {
        failBeforeReady(err);
      }
    });
  }

  _appendRaw(session, str) {
    session.rawBuffer += str;
    if (session.rawBuffer.length > MAX_RAW_HISTORY_CHARS) {
      session.rawBuffer = session.rawBuffer.slice(-MAX_RAW_HISTORY_CHARS);
    }
  }

  _normalizePtyInput(session, data, bypassControl = false) {
    if (!bypassControl && session.isLocal && session.isPty && session.shellInfo?.conptyCrSubmit) {
      return data.replace(/\r?\n/g, '\r');
    }
    return data;
  }

  _handleOutput(session, data) {
    // Windows ConPTY frequently repositions the cursor via CSI <row>;1H instead of emitting \r\n
    const normalizedData =
      session.isLocal && session.isPty && process.platform === 'win32'
        ? data.replace(/\x1b\[\d+;1H/g, '\n')
        : data;
    const fullContent = session.partialLine + normalizedData;
    const lines = fullContent.split(/\r?\n/);

    // Last element is the new partial line (empty string if data ended with a newline)
    session.partialLine = lines.pop();

    for (const line of lines) {
      session.outputBuffer.push(line);
      session.currentLine++;
      if (session.outputBuffer.length > MAX_OUTPUT_LINES) {
        session.outputBuffer.shift();
      }
    }
  }

  getOutput(sessionId, since = 0, clean = true, limit = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const numericSince = Math.max(0, Number(since) || 0);
    const bufferSize = session.outputBuffer.length;
    const totalLinesProduced = session.currentLine;
    const startOffset = totalLinesProduced - bufferSize;

    const startIndex = Math.max(0, numericSince - startOffset);
    let lines = session.outputBuffer.slice(startIndex);

    // Always append non-empty partialLine (e.g., shell prompt or in-progress line).
    // `currentLine` tracks completed lines only so polling with `since = currentLine`
    // never skips a partial line once it completes with a newline.
    if (session.partialLine) {
      lines.push(session.partialLine);
    }

    if (clean) {
      lines = lines.map((l) => stripAnsi(l));
    }

    if (limit && typeof limit === 'number' && limit > 0 && lines.length > limit) {
      lines = lines.slice(-limit);
    }

    return {
      lines,
      currentLine: totalLinesProduced,
      hasPartialLine: Boolean(session.partialLine)
    };
  }

  write(sessionId, data, bypassControl = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (typeof data !== 'string') {
      throw new ValidationError('Input must be a string');
    }

    if (session.status === 'user_control' && !bypassControl) {
      throw new SessionAccessDeniedError();
    }

    session.stream.write(this._normalizePtyInput(session, data, bypassControl));
    return true;
  }

  async exec(sessionId, command, onStdoutOrOpts, onStderrMaybe) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();

    if (typeof command !== 'string' || !command.trim()) {
      throw new ValidationError('Missing or invalid command');
    }

    if (session.status === 'user_control') {
      throw new SessionAccessDeniedError();
    }

    let onStdout = null;
    let onStderr = null;
    let timeoutMs = DEFAULT_EXEC_TIMEOUT_MS;
    let maxBuffer = DEFAULT_EXEC_MAX_BUFFER;

    if (typeof onStdoutOrOpts === 'function') {
      onStdout = onStdoutOrOpts;
      onStderr = typeof onStderrMaybe === 'function' ? onStderrMaybe : null;
    } else if (onStdoutOrOpts && typeof onStdoutOrOpts === 'object') {
      onStdout = onStdoutOrOpts.onStdout || null;
      onStderr = onStdoutOrOpts.onStderr || null;
      if (onStdoutOrOpts.timeoutMs !== undefined) {
        timeoutMs = Math.min(Math.max(500, Number(onStdoutOrOpts.timeoutMs) || DEFAULT_EXEC_TIMEOUT_MS), 600000);
      }
      if (onStdoutOrOpts.maxBuffer !== undefined) {
        maxBuffer = Math.max(1024, Number(onStdoutOrOpts.maxBuffer) || DEFAULT_EXEC_MAX_BUFFER);
      }
    }

    if (session.isLocal) {
      try {
        return await this.localShellAdapter.execLocalCommand(session.shellInfo, command, {
          cwd: session.cwd,
          timeoutMs,
          maxBuffer,
          onStdout,
          onStderr
        });
      } catch (err) {
        if (err.statusCode) {
          throw new GatewayError(err.message, err.statusCode);
        }
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      session.conn.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';
        let totalBytes = 0;
        let finished = false;
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');

        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          try {
            stream.close();
          } catch {
            // ignore
          }
          reject(new GatewayError(`Command timed out after ${timeoutMs}ms`, 504));
        }, timeoutMs);

        const checkBufferLimit = (chunkLen) => {
          totalBytes += chunkLen;
          if (totalBytes > maxBuffer && !finished) {
            finished = true;
            clearTimeout(timer);
            try {
              stream.close();
            } catch {
              // ignore
            }
            reject(new GatewayError(`Command output exceeded maxBuffer (${maxBuffer} bytes)`, 413));
            return false;
          }
          return true;
        };

        stream.on('data', (data) => {
          if (!checkBufferLimit(data.length)) return;
          const text = outDecoder.write(data);
          if (text) {
            stdout += text;
            if (onStdout) onStdout(text);
          }
        });

        stream.stderr.on('data', (data) => {
          if (!checkBufferLimit(data.length)) return;
          const text = errDecoder.write(data);
          if (text) {
            stderr += text;
            if (onStderr) onStderr(text);
          }
        });

        stream.on('error', (streamErr) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          reject(streamErr);
        });

        stream.on('close', (code, signal) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const outRem = outDecoder.end();
          const errRem = errDecoder.end();
          if (outRem) {
            stdout += outRem;
            if (onStdout) onStdout(outRem);
          }
          if (errRem) {
            stderr += errRem;
            if (onStderr) onStderr(errRem);
          }
          resolve({
            stdout,
            stderr,
            exitCode: code ?? 0,
            signal: signal || null
          });
        });
      });
    });
  }

  handoff(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'user_control';
    session.handoffMessage = message || 'Manual assistance requested by AI';
    return true;
  }

  disconnect(sessionId, io = null) {
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    this.sessions.delete(sessionId);
    if (session.proxySocket && !session.proxySocket.destroyed) {
      session.proxySocket.destroy();
    }
    if (session.isLocal) {
      try {
        session.stream?.destroy?.();
      } catch {
        // ignore
      }
    } else {
      try {
        session.conn?.end();
      } catch {
        // ignore
      }
    }
    if (io) {
      io.to(sessionId).emit('session:closed', { sessionId });
      io.emit('session:closed', { sessionId });
    }
    return true;
  }

  disconnectAll() {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.disconnect(sessionId);
    }
  }

  returnControl(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'ai_control';
    session.handoffMessage = null;
    return true;
  }

  setRecording(sessionId, enabled) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.isRecording = Boolean(enabled);
    return true;
  }

  async _getSftp(session) {
    if (session.sftp) return session.sftp;
    if (session.sftpPromise) return session.sftpPromise;

    session.sftpPromise = new Promise((resolve, reject) => {
      session.conn.sftp((err, sftp) => {
        session.sftpPromise = null;
        if (err) {
          return reject(new GatewayError(`SFTP subsystem unavailable: ${err.message}`, 502));
        }
        const clearSftp = () => {
          if (session.sftp === sftp) {
            session.sftp = null;
          }
        };
        sftp.on('close', clearSftp);
        sftp.on('end', clearSftp);
        sftp.on('error', clearSftp);
        session.sftp = sftp;
        resolve(sftp);
      });
    });

    return session.sftpPromise;
  }

  async sftpReadFile(sessionId, remotePath) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    if (session.status === 'user_control') throw new SessionAccessDeniedError();
    if (!remotePath || typeof remotePath !== 'string') {
      throw new ValidationError('Missing remote file path');
    }

    if (session.isLocal) {
      const resolvedPath = path.resolve(session.cwd || process.cwd(), remotePath);
      try {
        return await fs.promises.readFile(resolvedPath, 'utf8');
      } catch (err) {
        throw new GatewayError(`Local file read failed: ${err.message}`, 500);
      }
    }

    const sftp = await this._getSftp(session);
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, 'utf8', (err, data) => {
        if (err) reject(new GatewayError(`SFTP read failed: ${err.message}`, 500));
        else resolve(data);
      });
    });
  }

  async sftpWriteFile(sessionId, remotePath, content) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    if (session.status === 'user_control') throw new SessionAccessDeniedError();
    if (!remotePath || typeof remotePath !== 'string') {
      throw new ValidationError('Missing remote file path');
    }
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
      throw new ValidationError('File content must be a string');
    }

    if (session.isLocal) {
      const resolvedPath = path.resolve(session.cwd || process.cwd(), remotePath);
      try {
        await fs.promises.writeFile(resolvedPath, content, 'utf8');
        return { success: true };
      } catch (err) {
        throw new GatewayError(`Local file write failed: ${err.message}`, 500);
      }
    }

    const sftp = await this._getSftp(session);
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, content, (err) => {
        if (err) reject(new GatewayError(`SFTP write failed: ${err.message}`, 500));
        else resolve({ success: true });
      });
    });
  }

  sendSignal(sessionId, signal) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    if (session.status === 'user_control') throw new SessionAccessDeniedError();

    const signals = {
      SIGINT: '\x03', // Ctrl+C
      EOF: '\x04', // Ctrl+D
      SIGQUIT: '\x1c', // Ctrl+\
      SIGTSTP: '\x1a' // Ctrl+Z
    };
    if (!signals[signal]) {
      throw new ValidationError(`Unsupported signal "${signal}". Valid signals: ${Object.keys(signals).join(', ')}`);
    }
    session.stream.write(signals[signal]);
    return true;
  }

  async writeAndWait(sessionId, data, waitForRegex, timeoutMs = 10000) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError();
    if (session.status === 'user_control') throw new SessionAccessDeniedError();
    if (typeof data !== 'string') throw new ValidationError('Input must be a string');
    if (typeof waitForRegex !== 'string' || !waitForRegex || waitForRegex.length > MAX_REGEX_LENGTH) {
      throw new ValidationError(`waitFor regex must be a non-empty string up to ${MAX_REGEX_LENGTH} chars`);
    }

    let regex;
    try {
      regex = new RegExp(waitForRegex);
    } catch (err) {
      throw new ValidationError(`Invalid waitFor regular expression: ${err.message}`);
    }

    const clampedTimeout = Math.min(
      Math.max(100, Number(timeoutMs) || 10000),
      MAX_WAIT_TIMEOUT_MS
    );

    return new Promise((resolve, reject) => {
      const startLine = session.currentLine;
      const decoder = new StringDecoder('utf8');
      let capturedClean = '';

      const buildResult = (timedOut = false) => {
        if (session.isRecording) {
          const result = this.getOutput(sessionId, startLine, true) || {
            lines: capturedClean.split(/\r?\n/),
            currentLine: session.currentLine
          };
          if (timedOut) result.timeout = true;
          return result;
        }
        // Fallback when UI toggled recording off so writeAndWait still returns captured lines
        const result = {
          lines: capturedClean ? capturedClean.split(/\r?\n/) : [],
          currentLine: session.currentLine
        };
        if (timedOut) result.timeout = true;
        return result;
      };

      const checkOutput = (newData) => {
        const chunkStr = decoder.write(newData);
        if (!chunkStr) return;
        const normalizedChunk =
          session.isLocal && session.isPty && process.platform === 'win32'
            ? chunkStr.replace(/\x1b\[\d+;1H/g, '\n')
            : chunkStr;
        capturedClean += stripAnsi(normalizedChunk);
        if (capturedClean.length > MAX_WAIT_CAPTURE_CHARS) {
          capturedClean = capturedClean.slice(-MAX_WAIT_CAPTURE_CHARS);
        }
        if (regex.test(capturedClean)) {
          cleanup();
          resolve(buildResult(false));
        }
      };

      const onStreamClose = () => {
        cleanup();
        reject(new GatewayError('Terminal stream closed while waiting for output', 502));
      };

      const timer = setTimeout(() => {
        cleanup();
        resolve(buildResult(true));
      }, clampedTimeout);

      const cleanup = () => {
        clearTimeout(timer);
        session.stream.removeListener('data', checkOutput);
        session.stream.removeListener('close', onStreamClose);
      };

      session.stream.on('data', checkOutput);
      session.stream.once('close', onStreamClose);
      session.stream.write(this._normalizePtyInput(session, data, false));
    });
  }

  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.rawBuffer;
  }

  appendToHistory(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this._appendRaw(session, data);
    }
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    const numCols = Number(cols);
    const numRows = Number(rows);
    if (session && session.stream && Number.isInteger(numCols) && Number.isInteger(numRows) && numCols > 0 && numRows > 0) {
      session.stream.setWindow(numRows, numCols, 0, 0);
    }
  }

  async getNetbirdInfo() {
    return this.netbirdAdapter.getNetbirdStatus();
  }

  async getLocalShellsInfo() {
    return this.localShellAdapter.getAvailableLocalShells();
  }

  getSessions() {
    this._pruneExpiredRequests();
    const active = Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      isLocal: Boolean(s.isLocal),
      shell: s.shell || null,
      cwd: s.cwd || null,
      host: s.host,
      port: s.port,
      username: s.username,
      transport: s.transport,
      hostKeyFingerprint: s.hostKeyFingerprint,
      status: s.status,
      isRecording: s.isRecording,
      handoffMessage: s.handoffMessage
    }));
    const pending = Array.from(this.pendingRequests.values());
    return { active, pending };
  }
}

export default new SSHManager();
