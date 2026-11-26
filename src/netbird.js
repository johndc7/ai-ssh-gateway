import { spawn, execFile } from 'node:child_process';
import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATE_PATHS = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Netbird\\netbird.exe',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Netbird', 'netbird.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Netbird', 'netbird.exe')
    ]
  : [
      '/usr/bin/netbird',
      '/usr/local/bin/netbird',
      '/opt/homebrew/bin/netbird',
      '/snap/bin/netbird'
    ];

export function validateSshTarget(host, port = 22) {
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('Invalid SSH host');
  }
  const trimmed = host.trim();
  if (trimmed.startsWith('-') || /[\s\0\r\n]/.test(trimmed)) {
    throw new Error('Invalid characters in SSH host');
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('Invalid SSH port (must be 1-65535)');
  }
  return { host: trimmed, port: portNum };
}

let cachedStatus = null;
let cachedAt = 0;

export async function getNetbirdStatus({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedStatus && now - cachedAt < 30000) {
    return cachedStatus;
  }

  const candidates = [];
  if (process.env.NETBIRD_BIN) {
    candidates.push(process.env.NETBIRD_BIN);
  }
  candidates.push('netbird');
  for (const p of CANDIDATE_PATHS) {
    if (p && fs.existsSync(p)) {
      candidates.push(p);
    }
  }

  for (const bin of candidates) {
    try {
      const version = await execVersion(bin);
      cachedStatus = { available: true, binaryPath: bin, version };
      cachedAt = now;
      return cachedStatus;
    } catch {
      // Try next candidate
    }
  }

  cachedStatus = { available: false, binaryPath: null, version: null };
  cachedAt = now;
  return cachedStatus;
}

function execVersion(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['version'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.toString('utf8').trim());
    });
  });
}

/**
 * Runs `netbird ssh detect <host> <port>`.
 * NetBird CLI exit codes: 0 = JWT required, 1 = NetBird SSH without JWT, 2 = regular SSH.
 */
export async function detectNetbirdSsh(host, port = 22, { timeoutMs = 15000, binaryPath } = {}) {
  const target = validateSshTarget(host, port);
  const bin = binaryPath || (await getNetbirdStatus()).binaryPath;
  if (!bin) {
    throw new Error('NetBird CLI was not found on this machine. Install NetBird or set NETBIRD_BIN.');
  }

  return new Promise((resolve) => {
    execFile(
      bin,
      ['ssh', 'detect', target.host, String(target.port)],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          return resolve({ mode: 'jwt', exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
        const code = typeof err.code === 'number' ? err.code : null;
        if (code === 1) {
          return resolve({ mode: 'no-jwt', exitCode: 1, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
        if (code === 2) {
          return resolve({ mode: 'regular-ssh', exitCode: 2, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
        return resolve({
          mode: 'unknown',
          exitCode: code,
          error: err.killed ? 'NetBird SSH detection timed out' : err.message,
          stderr: String(stderr || '')
        });
      }
    );
  });
}

export class NetbirdProxySocket extends Duplex {
  constructor(proc, { onStderr } = {}) {
    super();
    this.proc = proc;
    this.stderrOutput = '';
    const stderrDecoder = new StringDecoder('utf8');

    proc.stdout.on('data', (chunk) => {
      if (!this.push(chunk)) {
        proc.stdout.pause();
      }
    });

    proc.stdout.on('end', () => {
      this.push(null);
    });

    proc.stdout.on('error', (err) => {
      this.destroy(err);
    });

    proc.stdin.on('error', (err) => {
      // Ignore EPIPE when child exits first; proc exit handler will surface meaningful stderr
      if (err && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
        this.destroy(err);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = stderrDecoder.write(chunk);
      this.stderrOutput += text;
      if (this.stderrOutput.length > 16384) {
        this.stderrOutput = this.stderrOutput.slice(-16384);
      }
      if (typeof onStderr === 'function') {
        onStderr(text);
      }
    });

    proc.on('error', (err) => {
      this.destroy(new Error(`Failed to launch netbird ssh proxy: ${err.message}`));
    });

    proc.on('close', (code) => {
      const trailing = stderrDecoder.end();
      if (trailing) {
        this.stderrOutput += trailing;
        if (typeof onStderr === 'function') onStderr(trailing);
      }
      if (code !== 0 && code !== null && !this.destroyed) {
        const detail = this.stderrOutput.trim();
        this.destroy(new Error(detail || `netbird ssh proxy exited with code ${code}`));
      } else if (!this.destroyed) {
        this.push(null);
      }
    });
  }

  _read() {
    if (this.proc && this.proc.stdout) {
      this.proc.stdout.resume();
    }
  }

  _write(chunk, encoding, callback) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      callback(new Error('NetBird proxy stdin is closed'));
      return;
    }
    this.proc.stdin.write(chunk, encoding, callback);
  }

  _final(callback) {
    if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.end(callback);
    } else {
      callback();
    }
  }

  _destroy(err, callback) {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        // Ignore kill error on already exited process
      }
    }
    callback(err);
  }
}

export async function createNetbirdProxySocket(host, port = 22, {
  binaryPath,
  noBrowser = false,
  noCache = false,
  onStderr
} = {}) {
  const target = validateSshTarget(host, port);
  const bin = binaryPath || (await getNetbirdStatus()).binaryPath;
  if (!bin) {
    throw new Error('NetBird CLI was not found on this machine. Install NetBird or set NETBIRD_BIN.');
  }

  const args = ['ssh', 'proxy'];
  if (noBrowser) args.push('--no-browser');
  if (noCache) args.push('--no-cache');
  args.push(target.host, String(target.port));

  const proc = spawn(bin, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  return new NetbirdProxySocket(proc, { onStderr });
}
