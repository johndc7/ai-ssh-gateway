# AI SSH Gateway Instructions

You can use this tool to interact with SSH servers that the user has authorized.

## Workflow

1. **Check Sessions**: Call `GET ${baseUrl}/api/sessions` to see active and pending sessions.
2. **Request New Session**: Call `POST ${baseUrl}/api/sessions/request` with `host`, `username`, and `reason`. The user will see this in their UI and can choose to connect.
3. **Run Synchronous Commands**: For simple tasks (ls, cat, checking status), use `POST ${baseUrl}/api/sessions/:id/exec` with `{ "command": "..." }`. This is clean and doesn't interfere with the interactive terminal.
4. **Interactive PTY**: For interactive tools or stateful shell sessions:
    - Send input: `POST ${baseUrl}/api/sessions/:id/input` with `{ "input": "command\n" }`.
    - **Wait For Prompt (Recommended):** Pass `waitFor` (regex string) and `timeout` in the input payload. The API will block and return the output once the regex is matched, saving you from polling. Example: `{ "input": "apt update\n", "waitFor": "root@.*:~# " }`.
    - Poll output: `GET ${baseUrl}/api/sessions/:id/output?since=N&clean=true&limit=100` (Use limit to protect your context window!).
    - Monitor multiple sessions: `GET ${baseUrl}/api/sessions/outputs?ids=id1,id2&since=N&limit=50`
5. **Control Signals**: Use `POST ${baseUrl}/api/sessions/:id/signal` with `{ "signal": "SIGINT" }` (or EOF, SIGQUIT, SIGTSTP) instead of struggling with escape codes.
6. **File Operations (SFTP)**: Never use `nano` or `vim` over the PTY! It wastes tokens.
    - Read: `GET ${baseUrl}/api/sessions/:id/files?path=/etc/nginx/nginx.conf`
    - Write: `POST ${baseUrl}/api/sessions/:id/files?path=/etc/nginx/nginx.conf` with `{ "content": "..." }`.
7. **Handoff to User**: If you hit a wall (e.g., complex interactive prompt, 2FA, sudo password you don't have), call `POST ${baseUrl}/api/sessions/:id/handoff` with a `message` explaining what you need. Wait for the session status to return to `ai_control`.

## Passwords and Sudo
You are allowed to type passwords if you know them. However, if you do not know a password, or a 2FA prompt appears, use the Handoff API to ask the human user to provide it.

## Best Practices for High-Volume Output (tcpdump, logs)
If you are running commands that produce massive output, DO NOT fetch the raw output into your context window.
1. ALWAYS use server-side filtering (e.g., `tcpdump port 80 | grep "specific_thing"`).
2. ALWAYS use the `limit=50` parameter on `GET /output` or `GET /outputs` endpoints to prevent context window crashes.