import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as nodePty from '@lydell/node-pty';

const IS_WIN = process.platform === 'win32';

const SHELL_DEFINITIONS = [
  {
    id: 'pwsh',
    label: 'PowerShell 7 (pwsh)',
    platforms: ['win32', 'linux', 'darwin'],
    candidates: IS_WIN
      ? [
          'pwsh.exe',
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
        ]
      : ['pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh'],
    interactiveArgs: ['-NoLogo'],
    buildExecArgs: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    conptyCrSubmit: IS_WIN
  },
  {
    id: 'powershell',
    label: 'Windows PowerShell (powershell.exe)',
    platforms: ['win32'],
    candidates: [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'powershell.exe'
    ],
    interactiveArgs: ['-NoLogo'],
    buildExecArgs: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    conptyCrSubmit: true
  },
  {
    id: 'cmd',
    label: 'Command Prompt (cmd.exe)',
    platforms: ['win32'],
    candidates: [
      process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'cmd.exe'
    ],
    interactiveArgs: [],
    buildExecArgs: (command) => ['/d', '/s', '/c', command],
    conptyCrSubmit: true
  },
  {
    id: 'bash',
    label: 'Bash',
    platforms: ['linux', 'darwin', 'win32'],
    candidates: IS_WIN
      ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash.exe']
      : ['/bin/bash', '/usr/bin/bash', 'bash'],
    interactiveArgs: [],
    buildExecArgs: (command) => ['-c', command],
    conptyCrSubmit: IS_WIN
  },
  {
    id: 'zsh',
    label: 'Zsh',
    platforms: ['linux', 'darwin'],
    candidates: ['/bin/zsh', '/usr/bin/zsh', 'zsh'],
    interactiveArgs: [],
    buildExecArgs: (command) => ['-c', command],
    conptyCrSubmit: false
  },
  {
    id: 'sh',
    label: 'Bourne Shell (sh)',
    platforms: ['linux', 'darwin'],
    candidates: ['/bin/sh', '/usr/bin/sh', 'sh'],
    interactiveArgs: [],
    buildExecArgs: (command) => ['-c', command],
    conptyCrSubmit: false
  }
];

function checkExecutable(candidate) {
  return new Promise((resolve) => {
    if (!candidate) return resolve(null);
    if (path.isAbsolute(candidate)) {
      return resolve(fs.existsSync(candidate) ? candidate : null);
    }
    const lookupCmd = IS_WIN ? 'where.exe' : 'which';
    execFile(lookupCmd, [candidate], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const firstLine = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      resolve(firstLine || null);
    });
  });
}

let cachedShells = null;
let cachedShellsAt = 0;

export async function getAvailableLocalShells({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cachedShells && now - cachedShellsAt < 60000) {
    return cachedShells;
  }

  const relevant = SHELL_DEFINITIONS.filter((def) => def.platforms.includes(process.platform));
  const results = [];

  for (const def of relevant) {
    let resolvedPath = null;
    for (const candidate of def.candidates) {
      resolvedPath = await checkExecutable(candidate);
      if (resolvedPath) break;
    }
    // On Windows, keep pwsh/powershell/cmd visible even if pwsh isn't installed; hide optional Git Bash if absent
    if (!resolvedPath && IS_WIN && def.id === 'bash') {
      continue;
    }
    results.push({
      id: def.id,
      label: def.label,
      available: Boolean(resolvedPath),
      executable: resolvedPath
    });
  }

  cachedShells = results;
  cachedShellsAt = now;
  return results;
}

export async function resolveShellDefinition(requestedShell) {
  const shells = await getAvailableLocalShells();
  let chosen;

  if (requestedShell) {
    const normalized = String(requestedShell).trim().toLowerCase().replace(/\.exe$/, '');
    chosen = shells.find((s) => s.id === normalized);
    if (!chosen) {
      const validIds = shells.map((s) => s.id).join(', ');
      throw new Error(`Unsupported shell "${requestedShell}". Supported shells: ${validIds}`);
    }
    if (!chosen.available || !chosen.executable) {
      throw new Error(`Shell "${chosen.label}" is not installed on this machine.`);
    }
  } else {
    chosen = shells.find((s) => s.available);
    if (!chosen) {
      throw new Error('No supported local shell found on this machine.');
    }
  }

  const def = SHELL_DEFINITIONS.find((d) => d.id === chosen.id);
  return {
    ...def,
    executable: chosen.executable
  };
}

export function resolveWorkingDirectory(cwd) {
  const target = cwd && typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : process.cwd();
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`Working directory does not exist: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory path is not a directory: ${target}`);
  }
  return target;
}

export class LocalPtyStream extends EventEmitter {
  constructor(ptyProcess) {
    super();
    this.ptyProcess = ptyProcess;
    this.closed = false;

    this._dataDisposable = ptyProcess.onData((data) => {
      if (!this.closed) {
        this.emit('data', Buffer.from(data, 'utf8'));
      }
    });

    this._exitDisposable = ptyProcess.onExit(() => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
  }

  write(data) {
    if (this.closed) return false;
    this.ptyProcess.write(typeof data === 'string' ? data : data.toString('utf8'));
    return true;
  }

  setWindow(rows, cols) {
    if (this.closed) return;
    try {
      this.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Ignore resize errors if process exited simultaneously
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this._dataDisposable?.dispose?.();
      this._exitDisposable?.dispose?.();
    } catch {
      // ignore
    }
    try {
      this.ptyProcess.kill();
    } catch {
      // ignore
    }
    this.emit('close');
  }
}

export class FallbackChildStream extends EventEmitter {
  constructor(proc) {
    super();
    this.proc = proc;
    this.closed = false;

    proc.stdout.on('data', (chunk) => {
      if (!this.closed) this.emit('data', chunk);
    });
    proc.stderr.on('data', (chunk) => {
      if (!this.closed) this.emit('data', chunk);
    });
    proc.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
    proc.on('error', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
  }

  write(data) {
    if (this.closed || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    return this.proc.stdin.write(data);
  }

  setWindow() {
    // No-op when running without native PTY
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
    this.emit('close');
  }
}

export function spawnLocalShellStream(shellInfo, { cwd, cols = 100, rows = 30, env } = {}) {
  const mergedEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    ...(env || {})
  };

  try {
    const ptyProc = nodePty.spawn(shellInfo.executable, shellInfo.interactiveArgs, {
      name: 'xterm-256color',
      cols: Math.max(20, Number(cols) || 100),
      rows: Math.max(5, Number(rows) || 30),
      cwd,
      env: mergedEnv
    });
    return { stream: new LocalPtyStream(ptyProc), isPty: true, pid: ptyProc.pid };
  } catch {
    const child = spawn(shellInfo.executable, shellInfo.interactiveArgs, {
      cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    return { stream: new FallbackChildStream(child), isPty: false, pid: child.pid };
  }
}

export function execLocalCommand(shellInfo, command, {
  cwd = process.cwd(),
  timeoutMs = 120000,
  maxBuffer = 5 * 1024 * 1024,
  onStdout = null,
  onStderr = null
} = {}) {
  return new Promise((resolve, reject) => {
    const args = shellInfo.buildExecArgs(command);
    const proc = spawn(shellInfo.executable, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

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
        proc.kill();
      } catch {
        // ignore
      }
      const err = new Error(`Command timed out after ${timeoutMs}ms`);
      err.statusCode = 504;
      reject(err);
    }, timeoutMs);

    const checkLimit = (len) => {
      totalBytes += len;
      if (totalBytes > maxBuffer && !finished) {
        finished = true;
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
          // ignore
        }
        const err = new Error(`Command output exceeded maxBuffer (${maxBuffer} bytes)`);
        err.statusCode = 413;
        reject(err);
        return false;
      }
      return true;
    };

    proc.stdout.on('data', (chunk) => {
      if (!checkLimit(chunk.length)) return;
      const text = outDecoder.write(chunk);
      if (text) {
        stdout += text;
        if (onStdout) onStdout(text);
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (!checkLimit(chunk.length)) return;
      const text = errDecoder.write(chunk);
      if (text) {
        stderr += text;
        if (onStderr) onStderr(text);
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code, signal) => {
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
}

export function getLocalUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || 'local';
  }
}
