const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const stripAnsi = require('strip-ansi');

class SSHManager {
  constructor() {
    this.sessions = new Map(); // id -> session data
    this.pendingRequests = new Map(); // id -> request data
  }

  createRequest(host, username, reason) {
    const id = uuidv4();
    const request = {
      id,
      host,
      username,
      reason,
      status: 'pending',
      createdAt: new Date()
    };
    this.pendingRequests.set(id, request);
    return request;
  }

  async connect(requestId, authConfig, name, io) {
    const request = this.pendingRequests.get(requestId);
    if (!request) throw new Error('Request not found');

    return new Promise((resolve, reject) => {
      const conn = new Client();
      const sessionId = uuidv4();

      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color' }, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          const sessionHost = authConfig.host || request.host;
          const sessionUser = authConfig.username || request.username;
          
          const session = {
            id: sessionId,
            name: name || `${sessionUser}@${sessionHost}`,
            conn,
            stream,
            status: 'ai_control',
            outputBuffer: [],
            currentLine: 0,
            isRecording: true,
            partialLine: '',
            handoffMessage: null,
            rawBuffer: ''
          };

          stream.on('data', (data) => {
            const str = data.toString('utf-8');
            
            session.rawBuffer += str;
            if (session.rawBuffer.length > 500000) {
              session.rawBuffer = session.rawBuffer.slice(-500000);
            }
            
            // Send raw data to Web UI regardless of recording status
            io.to(sessionId).emit('terminal:data', { sessionId, data: str });

            if (session.isRecording) {
              this._handleOutput(session, str);
            }
          });

          stream.on('close', () => {
            this.sessions.delete(sessionId);
            io.to(sessionId).emit('session:closed');
            conn.end();
          });

          this.sessions.set(sessionId, session);
          this.pendingRequests.delete(requestId);
          resolve(session);
        });
      }).on('error', (err) => {
        reject(err);
      }).connect({
        host: authConfig.host || request.host,
        port: authConfig.port || 22,
        username: authConfig.username || request.username,
        password: authConfig.password,
        privateKey: authConfig.privateKey,
        passphrase: authConfig.passphrase
      });
    });
  }

  _handleOutput(session, data) {
    const fullContent = session.partialLine + data;
    const lines = fullContent.split(/\r?\n/);
    
    // Last element is the new partial line (might be empty if ended with newline)
    session.partialLine = lines.pop();

    for (const line of lines) {
      session.outputBuffer.push(line);
      session.currentLine++;
      // Limit buffer to 10k lines
      if (session.outputBuffer.length > 10000) {
        session.outputBuffer.shift();
      }
    }
  }

  getOutput(sessionId, since = 0, clean = true, limit = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Buffer stores the last 10,000 lines. 
    // We need to calculate the index relative to the rolling buffer.
    const bufferSize = session.outputBuffer.length;
    const totalLinesProduced = session.currentLine;
    const startOffset = totalLinesProduced - bufferSize;

    const startIndex = Math.max(0, since - startOffset);
    let lines = session.outputBuffer.slice(startIndex);

    // If there's a partial line (like a prompt "password: "), include it if it's new
    if (session.partialLine && since <= totalLinesProduced) {
        lines.push(session.partialLine);
    }

    if (clean) {
      lines = lines.map(l => stripAnsi(l));
    }

    if (limit && typeof limit === 'number' && limit > 0 && lines.length > limit) {
      // If we limit to 50 lines, we want the LAST 50 lines of the chunk
      lines = lines.slice(-limit);
    }

    return {
      lines,
      currentLine: totalLinesProduced + (session.partialLine ? 1 : 0)
    };
  }

  write(sessionId, data, bypassControl = false) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    if (session.status === 'user_control' && !bypassControl) {
        throw new Error('Access Denied: Session is under User Control');
    }

    session.stream.write(data);
    return true;
  }

  async exec(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    if (session.status === 'user_control') {
        throw new Error('Access Denied: Session is under User Control');
    }

    return new Promise((resolve, reject) => {
      session.conn.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({ stdout, stderr, exitCode: code, signal });
        }).on('data', (data) => {
          stdout += data.toString();
        }).stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  handoff(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'user_control';
    session.handoffMessage = message;
    return true;
  }

  disconnect(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!sessionId) return false;
    if (session) {
        session.conn.end();
        this.sessions.delete(sessionId);
        return true;
    }
    return false;
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
    session.isRecording = enabled;
    return true;
  }

  sftpReadFile(sessionId, remotePath) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sftp) throw new Error('Session or SFTP not available');
    return new Promise((resolve, reject) => {
      session.sftp.readFile(remotePath, 'utf8', (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  sftpWriteFile(sessionId, remotePath, content) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sftp) throw new Error('Session or SFTP not available');
    return new Promise((resolve, reject) => {
      session.sftp.writeFile(remotePath, content, (err) => {
        if (err) reject(err);
        else resolve({ success: true });
      });
    });
  }

  sendSignal(sessionId, signal) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.status === 'user_control') throw new Error('Access Denied');
    const signals = {
      'SIGINT': '\x03', // Ctrl+C
      'EOF': '\x04', // Ctrl+D
      'SIGQUIT': '\x1c', // Ctrl+\\
      'SIGTSTP': '\x1a' // Ctrl+Z
    };
    if (signals[signal]) {
      session.stream.write(signals[signal]);
      return true;
    }
    return false;
  }

  async writeAndWait(sessionId, data, waitForRegex, timeoutMs = 10000) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status === 'user_control') throw new Error('Access Denied');
    
    return new Promise((resolve, reject) => {
      const regex = new RegExp(waitForRegex);
      const startLine = session.currentLine;
      let capturedOutput = '';
      
      const checkOutput = (newData) => {
        capturedOutput += stripAnsi(newData.toString('utf-8'));
        if (regex.test(capturedOutput)) {
          cleanup();
          resolve(this.getOutput(sessionId, startLine, true));
        }
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for pattern in output'));
      }, timeoutMs);
      
      const cleanup = () => {
        clearTimeout(timeout);
        session.stream.removeListener('data', checkOutput);
      };
      
      session.stream.on('data', checkOutput);
      session.stream.write(data);
    });
  }

  getHistory(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.rawBuffer : '';
  }

  resize(sessionId, cols, rows) {
    const session = this.sessions.get(sessionId);
    if (session && session.stream) {
      session.stream.setWindow(rows, cols, 0, 0);
    }
  }

  getSessions() {
    const active = Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      isRecording: s.isRecording,
      handoffMessage: s.handoffMessage
    }));
    const pending = Array.from(this.pendingRequests.values());
    return { active, pending };
  }
}

module.exports = new SSHManager();
