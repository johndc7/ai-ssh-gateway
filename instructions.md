# AI SSH Gateway Instructions

You can use this gateway (via MCP tools or the HTTP REST API) to interact safely with SSH and NetBird SSH servers authorized by the human operator.

## Workflow

1. **Check Sessions**:
   - MCP: `list_sessions`
   - REST: `GET ${baseUrl}/api/sessions` (lists active sessions, pending requests, `netbird` CLI status, and available `localShells` such as `pwsh`, `powershell`, `cmd`).
2. **Request New Session (SSH, NetBird SSH, or Local Terminal)**:
   - Remote SSH / NetBird:
     - MCP: `request_session` with `host`, `username`, optional `port`, `useNetbird` (`true` for NetBird identity-aware SSH), `reason`, and `waitForApproval`.
     - REST: `POST ${baseUrl}/api/sessions/request` with `{ "host": "...", "username": "...", "port": 22, "useNetbird": false, "reason": "..." }`.
   - Local Terminal (`pwsh` / `powershell` / `cmd` / `bash` / `zsh`):
     - MCP: `request_local_session` with optional `shell` (`"pwsh"`, `"powershell"`, `"cmd"`, etc.), `cwd`, `reason`, and `waitForApproval`.
     - REST: `POST ${baseUrl}/api/sessions/request` with `{ "type": "local", "shell": "powershell", "cwd": "...", "reason": "..." }`.
3. **Run Synchronous Commands (Preferred for non-interactive tasks)**:
   - MCP: `exec_command` with `{ "sessionId": "...", "command": "..." }`
   - REST: `POST ${baseUrl}/api/sessions/:id/exec` with `{ "command": "..." }`
   - Streams output to the operator's Web UI while returning clean `{ stdout, stderr, exitCode }` without disturbing the interactive PTY.
4. **Interactive PTY**:
   - Send input:
     - MCP: `send_terminal_input` (`sessionId`, `input`, optional `waitFor` regex, `timeoutMs`)
     - REST: `POST ${baseUrl}/api/sessions/:id/input` with `{ "input": "command\n", "waitFor": "root@.*:~# ", "timeout": 10000 }`
   - Poll output:
     - MCP: `read_terminal_output` (`sessionId`, `since`, `limit`, `clean`)
     - REST: `GET ${baseUrl}/api/sessions/:id/output?since=N&clean=true&limit=100` (pass `currentLine` from the previous response as `since`)
   - Monitor multiple sessions: `GET ${baseUrl}/api/sessions/outputs?ids=id1,id2&since=N&limit=50`
   - Full raw history:
     - MCP: `get_terminal_history`
     - REST: `GET ${baseUrl}/api/sessions/:id/history`
5. **Control Signals**:
   - MCP: `send_terminal_signal` (`SIGINT`, `EOF`, `SIGQUIT`, `SIGTSTP`)
   - REST: `POST ${baseUrl}/api/sessions/:id/signal` with `{ "signal": "SIGINT" }`
6. **File Operations (SFTP)**: Never use `nano` or `vim` over the PTY!
   - Read: MCP `read_remote_file` or `GET ${baseUrl}/api/sessions/:id/files?path=/etc/nginx/nginx.conf`
   - Write: MCP `write_remote_file` or `POST ${baseUrl}/api/sessions/:id/files?path=/etc/nginx/nginx.conf` with `{ "content": "..." }`
7. **Handoff to User**: If you encounter `sudo` password prompts, 2FA, or complex interactive screens, yield control to the human operator:
   - MCP: `handoff_to_user` (`sessionId`, `message`)
   - REST: `POST ${baseUrl}/api/sessions/:id/handoff` with `{ "message": "..." }`
   - Wait until the session `status` returns to `ai_control`.
8. **Cleanup**: Always close sessions when finished:
   - MCP: `close_session`
   - REST: `DELETE ${baseUrl}/api/sessions/:id`

## Best Practices for High-Volume Output (`tcpdump`, logs)
1. Always filter server-side (e.g., `journalctl -u nginx -n 100` or `tcpdump port 80 -c 50`).
2. Always pass a reasonable `limit` (e.g., `limit=50` or `100`) when reading PTY output to protect your context window.
