# AI SSH Gateway

An interactive SSH & **NetBird SSH** gateway designed to safely connect AI agents (via **Model Context Protocol (MCP)** or REST API) to remote servers, while giving human operators real-time visibility, credential isolation, and manual override via a local Web UI.

## Features

* **Model Context Protocol (MCP) Support:** Built-in MCP server supporting both **Streamable HTTP** (`/mcp`) and **stdio** (`npx ai-ssh-gateway --mcp`). If a local gateway UI is already running, `--mcp` stdio instances automatically attach to the shared dashboard.
* **Local Terminals (`pwsh` / `powershell` / `cmd`):** Launch local interactive ConPTY shells (`pwsh`, `powershell.exe`, `cmd.exe`, plus `bash`/`zsh`/`sh` on Linux/macOS) directly from the Web UI or let AI agents request supervised local shell access.
* **NetBird SSH & Standard SSH:** Connect using **NetBird identity-aware SSH** (OIDC/JWT SSO via `netbird ssh proxy` or machine-identity peers) alongside traditional SSH password, PEM/OpenSSH private keys, and local SSH Agent (`SSH_AUTH_SOCK` / Windows OpenSSH Agent).
* **Secure Delegation:** AI agents never see your SSH passwords, private keys, or NetBird SSO tokens. They request access, and you approve or reject requests from the local browser dashboard.
* **Live Terminal Monitoring & Manual Override:** Watch every PTY interaction and background `exec` command in real time via xterm.js. Take over typing at any moment (or receive AI `handoff` requests for `sudo` / 2FA), then click **Return to AI**.
* **SFTP File Read/Write:** Read and write remote files cleanly over SFTP without wasting tokens on terminal editors.

## Quick Start

Start the Web UI, REST API, and Streamable HTTP MCP server:

```bash
npx ai-ssh-gateway
```

* **Web Dashboard:** `http://127.0.0.1:3000`
* **Streamable HTTP MCP Endpoint:** `http://127.0.0.1:3000/mcp`
* **Dynamic Agent Instructions:** `http://127.0.0.1:3000/instructions`

### CLI Options

```text
ai-ssh-gateway [options]

  --port, -p <port>        Local HTTP/Web UI port (default: 3000 or PORT env)
  --mcp                    Start MCP server over stdio (launches or attaches to Web UI on 127.0.0.1:<port>)
  --gateway-url <url>      Connect --mcp stdio mode to an existing gateway URL
  --api-key <token>        Require Bearer API key for REST API & MCP requests (or GATEWAY_API_KEY env)
```

## Connecting MCP Clients

### Option 1: Stdio Transport (Claude Desktop, Cursor, Antigravity, etc.)

```json
{
  "mcpServers": {
    "ai-ssh-gateway": {
      "command": "npx",
      "args": ["-y", "ai-ssh-gateway", "--mcp"]
    }
  }
}
```

When launched with `--mcp`, the gateway automatically starts the local Web UI at `http://127.0.0.1:3000` (or shares an already-running gateway instance on that port).

### Option 2: Streamable HTTP Transport

Start `npx ai-ssh-gateway` and point your MCP client at:

```text
http://127.0.0.1:3000/mcp
```

### Exposed MCP Tools

* `list_sessions` — List active sessions, pending requests, NetBird CLI status, and available local shells.
* `request_session` — Request human approval for an SSH or NetBird SSH connection (`host`, `username`, `port`, `useNetbird`, `reason`, `waitForApproval`).
* `request_local_session` — Request human approval for a local terminal session (`shell`: `pwsh` / `powershell` / `cmd` / `bash` / `zsh` / `sh`, `cwd`, `reason`, `waitForApproval`).
* `exec_command` — Run a synchronous command on a dedicated SSH channel (`stdout`, `stderr`, `exitCode`).
* `send_terminal_input` — Write to the interactive PTY shell with optional `waitFor` regex matching.
* `read_terminal_output` — Poll buffered lines from the interactive PTY (`since`, `limit`, `clean`).
* `get_terminal_history` — Read raw terminal output history.
* `send_terminal_signal` — Send `SIGINT`, `EOF`, `SIGQUIT`, or `SIGTSTP` to the PTY.
* `read_remote_file` / `write_remote_file` — Read and write remote files via SFTP.
* `handoff_to_user` — Yield control to the human operator with an explanation banner.
* `close_session` — Disconnect and clean up an SSH session.

## NetBird SSH Support

To connect to peers over [NetBird SSH](https://docs.netbird.io/how-to/access-netbird-network-resources#enable-ssh-access):
1. Ensure the `netbird` CLI is installed locally (`NETBIRD_BIN` can override the binary path if needed) and NetBird SSH (`--allow-server-ssh`, plus `--enable-ssh-sftp` if using SFTP) is enabled on the remote peer.
2. Either let the AI pass `useNetbird: true` when requesting a session, or choose **NetBird SSH (Identity / SSO)** in the Web UI approval / manual connection modal.
3. The gateway automatically probes the peer with `netbird ssh detect` and tunnels JWT/SSO sessions via `netbird ssh proxy` (opening a browser SSO prompt if your token isn't cached).

## Core REST API Overview

* `GET /api/sessions` — List active sessions, pending requests, and NetBird availability.
* `POST /api/sessions/request` — Request access (`host`, `username`, `port`, `useNetbird`, `reason`, `waitForApproval`).
* `POST /api/sessions/:id/exec` — Run a clean command (`command`, `timeoutMs`).
* `POST /api/sessions/:id/input` — Send input to interactive PTY (`input`, `waitFor`, `timeout`).
* `POST /api/sessions/:id/signal` — Send control signals (`SIGINT`, `EOF`, `SIGQUIT`, `SIGTSTP`).
* `GET /api/sessions/:id/output?since=N&limit=100&clean=true` — Poll interactive PTY output.
* `GET /api/sessions/outputs?ids=id1,id2&limit=50` — Poll multiple sessions.
* `GET /api/sessions/:id/history` — Fetch raw PTY history (`text/plain`).
* `GET /api/sessions/:id/files?path=/path` — Read file via SFTP (`text/plain`).
* `POST /api/sessions/:id/files?path=/path` — Write file via SFTP (`{ "content": "..." }`).
* `POST /api/sessions/:id/handoff` — Yield session control to the human operator (`message`).
* `DELETE /api/sessions/:id` — Disconnect SSH session.

## License

MIT

## Disclaimer

**Use at your own risk.** This tool is provided "as is", without warranty of any kind, express or implied. Connecting AI agents to remote systems carries inherent security risks; you assume full responsibility for monitoring agent actions and securing your infrastructure.
