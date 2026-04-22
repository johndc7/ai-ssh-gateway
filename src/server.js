import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sshManager from './ssh-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// REST API for AI Agents
app.get('/api/sessions', (req, res) => {
  res.json(sshManager.getSessions());
});

app.get('/api/sessions/outputs', (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',') : [];
  const since = parseInt(req.query.since) || 0;
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  const clean = req.query.clean !== 'false';
  const results = {};
  for (const id of ids) {
     results[id] = sshManager.getOutput(id, since, clean, limit);
  }
  res.json(results);
});

app.post('/api/sessions/request', (req, res) => {
  const { host, username, reason } = req.body;
  if (!host || !username) return res.status(400).json({ error: 'Missing host or username' });
  const request = sshManager.createRequest(host, username, reason);
  io.emit('session:request', request);
  res.json(request);
});

app.get('/api/sessions/:id/output', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  const clean = req.query.clean !== 'false';
  const result = sshManager.getOutput(req.params.id, since, clean, limit);
  if (!result) return res.status(404).json({ error: 'Session not found' });
  res.json(result);
});

app.get('/api/sessions/:id/history', (req, res) => {
  const history = sshManager.getHistory(req.params.id);
  res.send(history || '');
});

app.post('/api/sessions/:id/input', async (req, res) => {
  const { input, waitFor, timeout } = req.body;
  if (!input) return res.status(400).json({ error: 'Missing input' });
  
  io.emit('session:ai_activity', { sessionId: req.params.id });

  if (waitFor) {
    try {
       const result = await sshManager.writeAndWait(req.params.id, input, waitFor, timeout);
       res.json(result);
    } catch (err) {
       res.status(500).json({ error: err.message });
    }
  } else {
    const success = sshManager.write(req.params.id, input);
    if (!success) return res.status(404).json({ error: 'Session not found' });
    const result = sshManager.getOutput(req.params.id, 0, false);
    res.json({ currentLine: result.currentLine });
  }
});

app.post('/api/sessions/:id/signal', (req, res) => {
  const { signal } = req.body;
  if (!signal) return res.status(400).json({ error: 'Missing signal' });
  io.emit('session:ai_activity', { sessionId: req.params.id });
  const success = sshManager.sendSignal(req.params.id, signal);
  if (!success) return res.status(400).json({ error: 'Invalid signal or session' });
  res.json({ success: true });
});

app.post('/api/sessions/:id/exec', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Missing command' });
  const sessionId = req.params.id;

  const emitAndStore = (data) => {
    io.to(sessionId).emit('terminal:data', { sessionId, data });
    if (typeof sshManager.appendToHistory === 'function') {
      sshManager.appendToHistory(sessionId, data);
    }
  };
  
  const formattedCmd = `\r\n\x1b[33m[Background Command]\x1b[0m \x1b[1m${command}\x1b[0m\r\n`;
  emitAndStore(formattedCmd);

  try {
    const result = await sshManager.exec(
      sessionId, 
      command,
      (data) => {
        emitAndStore(data.replace(/\r?\n/g, '\r\n'));
      },
      (data) => {
        emitAndStore(`\x1b[31m${data.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
      }
    );
    const exitMsg = `\x1b[33m[Command Exited with Code: ${result.exitCode}]\x1b[0m\r\n`;
    emitAndStore(exitMsg);
    res.json(result);
  } catch (err) {
    const errMsg = `\x1b[31m[Background Command Error: ${err.message}]\x1b[0m\r\n`;
    emitAndStore(errMsg);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id/files', async (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'Missing path query parameter' });
  try {
    const content = await sshManager.sftpReadFile(req.params.id, req.query.path);
    res.send(content);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/files', async (req, res) => {
  if (!req.query.path) return res.status(400).json({ error: 'Missing path query parameter' });
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Missing content body parameter' });
  try {
    const result = await sshManager.sftpWriteFile(req.params.id, req.query.path, content);
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions/:id/handoff', (req, res) => {
  const { message } = req.body;
  const success = sshManager.handoff(req.params.id, message);
  if (!success) return res.status(404).json({ error: 'Session not found' });
  io.to(req.params.id).emit('session:status', { status: 'user_control', message });
  res.json({ success: true });
});

app.delete('/api/sessions/:id', (req, res) => {
  const success = sshManager.disconnect(req.params.id);
  if (!success) return res.status(404).json({ error: 'Session not found' });
  res.json({ success: true });
});

app.get('/instructions', (req, res) => {
    const host = req.get('host');
    const protocol = req.protocol;
    const baseUrl = `${protocol}://${host}`;

    try {
        const instructionsPath = path.join(__dirname, '../instructions.md');
        let content = fs.readFileSync(instructionsPath, 'utf8');
        content = content.replace(/\$\{baseUrl\}/g, baseUrl);
        res.send(content.trim());
    } catch (err) {
        res.status(500).json({ error: 'Instructions file not found' });
    }
});

// Socket.io for Web UI
io.on('connection', (socket) => {
  socket.on('session:join', (sessionId) => {
    socket.join(sessionId);
  });

  socket.on('session:connect', async ({ requestId, authConfig, name }) => {
    try {
      console.log(`Attempting connection for request ${requestId} to ${authConfig.host || 'original host'}`);
      const session = await sshManager.connect(requestId, authConfig, name, io);
      console.log(`Session started: ${session.id}`);
      io.emit('session:started', {
        id: session.id,
        name: session.name,
        status: session.status
      });
    } catch (err) {
      console.error('Connection error:', err);
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('terminal:input', ({ sessionId, data }) => {
    sshManager.write(sessionId, data, true); // true to bypass control check for UI input
  });

  socket.on('terminal:resize', ({ sessionId, cols, rows }) => {
    sshManager.resize(sessionId, cols, rows);
  });

  socket.on('session:return_control', (sessionId) => {
    sshManager.returnControl(sessionId);
    io.to(sessionId).emit('session:status', { status: 'ai_control' });
  });

  socket.on('session:set_recording', ({ sessionId, enabled }) => {
    sshManager.setRecording(sessionId, enabled);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`AI SSH Gateway running at http://127.0.0.1:${PORT}`);
});

export default server;