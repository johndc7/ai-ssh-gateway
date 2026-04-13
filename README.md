# AI SSH Gateway

An interactive SSH gateway designed specifically to safely connect AI agents (like Gemini CLI, Cursor, or custom scripts) to remote servers. It provides a RESTful API for agents to interact with SSH sessions, and a modern Web UI for humans to monitor, approve, and optionally intervene.

## Features

* **Secure Delegation:** AI agents never see your SSH passwords or private keys. They request access to a server, and you approve it and provide credentials via the local Web UI.
* **Live Monitoring:** Watch everything the AI does in real-time through a persistent, browser-based terminal.
* **Manual Override:** At any point, you can take over the session (e.g., to handle a complex interactive prompt, 2FA, or `sudo` password), and then return control back to the AI.
* **Agent-Friendly API:** A clean REST API that provides stripped ANSI output, synchronized command execution, and long-running interactive PTY support.
* **Zero Configuration:** Runs locally on your machine and serves the UI over a local port.

## Quick Start

You can run the gateway directly without installing it globally:

```bash
npx ai-ssh-gateway
```

This will start the server and print the local URL (default: `http://127.0.0.1:3000`). Open this URL in your browser to access the dashboard.

## How it Works

1. **Start the Gateway:** Run `npx ai-ssh-gateway`.
2. **AI Requests Access:** Point your AI agent to `http://127.0.0.1:3000`. The agent uses the API to request an SSH session to `user@hostname`.
3. **Human Approval:** You see the pending request in the Web UI. You click "Approve", enter the password or key details, and the gateway establishes the connection.
4. **AI Interacts:** The AI uses the API to send commands and read output. You watch the live terminal in your browser.
5. **Handoff (Optional):** If the AI gets stuck (e.g., needs a password), it can pause its execution and send a "handoff" message to the UI. You type in the terminal to resolve the prompt, then click "Return to AI".

## AI Agent Instructions

If you are an AI reading this, you can fetch your operational instructions dynamically from the running gateway at:

`GET http://127.0.0.1:3000/instructions`

### Core API Overview

* `GET /api/sessions` - List active sessions and pending requests.
* `POST /api/sessions/request` - Request access to a new server (`host`, `username`, `reason`).
* `POST /api/sessions/:id/exec` - Run a synchronized, clean command (`command`). Best for simple tasks.
* `POST /api/sessions/:id/input` - Send raw input to the interactive PTY (`input`, `waitFor` regex).
* `POST /api/sessions/:id/signal` - Send control signals (`signal: "SIGINT"`, `EOF`, etc.).
* `GET /api/sessions/:id/output?since=N&limit=50&clean=true` - Poll for new output from the interactive PTY. Use `limit` to protect your context window!
* `GET /api/sessions/outputs?ids=id1,id2&limit=50` - Poll multiple active logs simultaneously.
* `GET /api/sessions/:id/files?path=/path` - Read files directly via SFTP (bypass `nano`).
* `POST /api/sessions/:id/files?path=/path` - Write files directly via SFTP (`content`).
* `POST /api/sessions/:id/handoff` - Yield control to the human user with a `message` explaining what is needed.

## License

MIT
