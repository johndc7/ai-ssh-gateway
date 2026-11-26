const socket = io();
const terminalContainer = document.getElementById('terminal-container');
const sessionList = document.getElementById('session-list');
const pendingList = document.getElementById('pending-requests');
const activeSessionName = document.getElementById('active-session-name');
const transportChip = document.getElementById('transport-chip');
const terminalHeader = document.getElementById('terminal-header');
const emptyState = document.getElementById('empty-state');
const recordToggle = document.getElementById('record-toggle');
const autoTakeToggle = document.getElementById('auto-take-toggle');
const autoSwitchToggle = document.getElementById('auto-switch-toggle');
const returnControlBtn = document.getElementById('return-control-btn');
const closeSessionBtn = document.getElementById('close-session-btn');
const handoffAlert = document.getElementById('handoff-alert');
const handoffMessage = document.getElementById('handoff-message');
const serverStatusText = document.getElementById('server-status-text');
const serverStatusDot = document.getElementById('server-status');
const controlChip = document.getElementById('control-chip');
const netbirdBadge = document.getElementById('netbird-badge');
const netbirdBadgeText = document.getElementById('netbird-badge-text');

let terminals = {}; // sessionId -> { term, fitAddon, container, ready }
let currentSessionId = null;
let sessions = [];
let pendingRequests = [];
let netbirdStatus = { available: false, version: null };
let localShells = [];

// XSS-safe Toast Notifications
function showToast(title, message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    const toastEl = document.createElement('div');
    toastEl.className = `toast align-items-center text-bg-${type} border-0 mb-2`;
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');

    const flex = document.createElement('div');
    flex.className = 'd-flex';

    const body = document.createElement('div');
    body.className = 'toast-body text-break';

    const strong = document.createElement('strong');
    strong.textContent = title;
    body.appendChild(strong);
    body.appendChild(document.createElement('br'));
    body.appendChild(document.createTextNode(message));

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-close btn-close-white me-2 m-auto';
    closeBtn.setAttribute('data-bs-dismiss', 'toast');
    closeBtn.setAttribute('aria-label', 'Close');

    flex.appendChild(body);
    flex.appendChild(closeBtn);
    toastEl.appendChild(flex);
    toastContainer.appendChild(toastEl);

    const toast = new bootstrap.Toast(toastEl, { autohide: true, delay: 5500 });
    toast.show();

    toastEl.addEventListener('hidden.bs.toast', () => {
        toastEl.remove();
    });
}

function getOrCreateTerminal(sessionId) {
    if (terminals[sessionId]) return terminals[sessionId];

    const container = document.createElement('div');
    container.className = 'terminal-wrapper h-100 w-100 d-none';
    terminalContainer.appendChild(container);

    const term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#000000',
            foreground: '#e1e1e1',
            cursor: '#bb86fc',
            selectionBackground: 'rgba(187, 134, 252, 0.3)'
        },
        fontFamily: '"JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        letterSpacing: 0.5,
        lineHeight: 1.2
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    term.onData((data) => {
        const session = sessions.find((s) => s.id === sessionId);
        if (session && session.status === 'ai_control' && autoTakeToggle.checked) {
            takeControlManually(sessionId);
        }
        socket.emit('terminal:input', { sessionId, data });
    });

    term.onResize(({ cols, rows }) => {
        socket.emit('terminal:resize', { sessionId, cols, rows });
    });

    const termEntry = { term, fitAddon, container, ready: false };
    terminals[sessionId] = termEntry;

    // Fetch history first, then subscribe to live room stream to avoid duplicate/reordered chunks
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/history`)
        .then((res) => (res.ok ? res.text() : ''))
        .then((history) => {
            if (history) term.write(history);
            termEntry.ready = true;
            socket.emit('session:join', sessionId);
            setTimeout(() => {
                if (currentSessionId === sessionId) {
                    fitAddon.fit();
                }
            }, 50);
        })
        .catch(() => {
            termEntry.ready = true;
            socket.emit('session:join', sessionId);
        });

    return termEntry;
}

window.addEventListener('resize', () => {
    if (currentSessionId && terminals[currentSessionId]) {
        terminals[currentSessionId].fitAddon.fit();
    }
});

function takeControlManually(sessionId) {
    if (!sessionId) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'User typing detected - switched to manual control' })
    }).catch(() => {});
}

// Socket Events
socket.on('connect', () => {
    serverStatusText.textContent = 'Connected';
    serverStatusDot.className = 'status-indicator status-connected';
    refreshSessions();
});

socket.on('disconnect', () => {
    serverStatusText.textContent = 'Disconnected';
    serverStatusDot.className = 'status-indicator status-disconnected';
    showToast('Connection Lost', 'Disconnected from the gateway server.', 'danger');
});

socket.on('connect_error', (err) => {
    showToast('Connection Error', err?.message || 'Failed to connect to gateway server.', 'danger');
});

socket.on('session:request', (request) => {
    if (!pendingRequests.some((r) => r.id === request.id)) {
        pendingRequests.push(request);
    }
    renderPending();
    if (request.type === 'local') {
        showToast('New Local Shell Request', `AI requested local ${request.shell} terminal`, 'warning');
    } else {
        const via = request.useNetbird ? ' (NetBird SSH)' : '';
        showToast('New Connection Request', `Incoming request for ${request.username}@${request.host}${via}`, 'info');
    }
});

socket.on('session:request_removed', ({ requestId }) => {
    pendingRequests = pendingRequests.filter((r) => r.id !== requestId);
    renderPending();
});

socket.on('session:netbird_info', ({ host, message }) => {
    showToast(`NetBird SSH (${host})`, message, 'info');
});

socket.on('session:started', (session) => {
    refreshSessions().then(() => {
        switchSession(session.id);
    });
});

socket.on('terminal:data', ({ sessionId, data }) => {
    const termObj = terminals[sessionId];
    if (termObj && termObj.ready) {
        termObj.term.write(data);
    }
});

socket.on('session:ai_activity', ({ sessionId }) => {
    if (autoSwitchToggle && autoSwitchToggle.checked && currentSessionId !== sessionId) {
        switchSession(sessionId);
    }
});

socket.on('session:status', ({ sessionId, status, message }) => {
    const targetId = sessionId || currentSessionId;
    const session = sessions.find((s) => s.id === targetId);
    if (session) {
        session.status = status;
        session.handoffMessage = message;
        if (currentSessionId === session.id) {
            updateUIForStatus(status, message);
        }
    }
    renderSessions();
});

socket.on('session:closed', () => {
    refreshSessions().then(() => {
        Object.keys(terminals).forEach((id) => {
            if (!sessions.find((s) => s.id === id)) {
                terminals[id].container.remove();
                terminals[id].term.dispose();
                delete terminals[id];
            }
        });
    });
});

function updateNetbirdUI() {
    if (!netbirdBadge) return;
    if (netbirdStatus && netbirdStatus.available) {
        netbirdBadge.classList.remove('d-none');
        netbirdBadgeText.textContent = netbirdStatus.version
            ? `NetBird ${netbirdStatus.version}`
            : 'NetBird Ready';
    } else {
        netbirdBadge.classList.add('d-none');
    }
}

function populateLocalShellSelect(selectEl, preferredId = null) {
    if (!selectEl || !Array.isArray(localShells) || localShells.length === 0) return;
    const prevValue = preferredId || selectEl.value;
    selectEl.textContent = '';

    let selectedId = null;
    for (const sh of localShells) {
        const opt = document.createElement('option');
        opt.value = sh.id;
        opt.textContent = sh.available ? sh.label : `${sh.label} — Not Installed`;
        opt.disabled = !sh.available;
        if (sh.available && !selectedId) {
            selectedId = sh.id;
        }
        if (sh.available && sh.id === prevValue) {
            selectedId = sh.id;
        }
        selectEl.appendChild(opt);
    }
    if (selectedId) {
        selectEl.value = selectedId;
    }
}

function updateLocalShellDropdowns() {
    populateLocalShellSelect(document.getElementById('local-shell-select'));
    populateLocalShellSelect(document.getElementById('modal-local-shell'));
}

// UI Actions
async function refreshSessions() {
    try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const data = await res.json();
        sessions = data.active || [];
        pendingRequests = data.pending || [];
        if (data.netbird) {
            netbirdStatus = data.netbird;
            updateNetbirdUI();
        }
        if (Array.isArray(data.localShells)) {
            localShells = data.localShells;
            updateLocalShellDropdowns();
        }
        renderSessions();
        renderPending();

        sessions.forEach((s) => {
            const termEntry = getOrCreateTerminal(s.id);
            if (termEntry.ready) {
                socket.emit('session:join', s.id);
            }
        });

        if (sessions.length > 0) {
            if (!currentSessionId || !sessions.find((s) => s.id === currentSessionId)) {
                switchSession(sessions[0].id);
            } else {
                const active = sessions.find((s) => s.id === currentSessionId);
                updateTransportChip(active.transport);
            }
        } else {
            terminalHeader.classList.add('d-none');
            terminalContainer.classList.add('d-none');
            emptyState.classList.remove('d-none');
            currentSessionId = null;
        }
    } catch (err) {
        console.error('Error refreshing sessions:', err);
    }
}

function renderSessions() {
    sessionList.textContent = '';
    sessions.forEach((s) => {
        const item = document.createElement('a');
        item.className = `list-group-item list-group-item-action d-flex align-items-center ${s.id === currentSessionId ? 'active' : ''}`;
        item.href = '#';
        item.setAttribute('role', 'button');

        const icon = document.createElement('span');
        icon.className = 'material-icons size-16 me-2';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = s.status === 'ai_control' ? 'auto_fix_high' : 'person';

        const label = document.createElement('div');
        label.className = 'text-truncate flex-grow-1';
        label.textContent = s.name;

        item.appendChild(icon);
        item.appendChild(label);

        if (s.isLocal || (s.transport && s.transport.startsWith('local-'))) {
            const locIcon = document.createElement('span');
            locIcon.className = 'material-icons size-14 ms-1 text-info';
            locIcon.title = `Local Shell (${s.shell || 'local'})`;
            locIcon.textContent = 'terminal';
            item.appendChild(locIcon);
        } else if (s.transport && s.transport.startsWith('netbird')) {
            const nbIcon = document.createElement('span');
            nbIcon.className = 'material-icons size-14 ms-1 text-warning';
            nbIcon.title = 'NetBird SSH';
            nbIcon.textContent = 'hub';
            item.appendChild(nbIcon);
        }

        item.addEventListener('click', (e) => {
            e.preventDefault();
            switchSession(s.id);
        });
        sessionList.appendChild(item);
    });
}

function renderPending() {
    pendingList.textContent = '';
    if (pendingRequests.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'text-muted small ps-2';
        empty.textContent = 'No pending requests.';
        pendingList.appendChild(empty);
        return;
    }

    pendingRequests.forEach((r) => {
        const card = document.createElement('div');
        card.className = 'card bg-dark-2 border-primary border-opacity-25 mb-2 mx-1 shadow-sm';

        const cardBody = document.createElement('div');
        cardBody.className = 'card-body p-2';

        const headerRow = document.createElement('div');
        headerRow.className = 'd-flex align-items-center justify-content-between mb-1 gap-1';

        const leftTitle = document.createElement('div');
        leftTitle.className = 'd-flex align-items-center text-truncate';

        const icon = document.createElement('span');
        icon.className = `material-icons size-16 ${r.type === 'local' ? 'text-info' : 'text-primary'} me-1`;
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = r.type === 'local' ? 'terminal' : 'person_add';

        const title = document.createElement('h6');
        title.className = 'card-title mb-0 small fw-bold text-truncate text-light';
        if (r.type === 'local') {
            title.textContent = `Local (${r.shell})`;
        } else {
            const portSuffix = r.port && Number(r.port) !== 22 ? `:${r.port}` : '';
            title.textContent = `${r.username}@${r.host}${portSuffix}`;
        }

        leftTitle.appendChild(icon);
        leftTitle.appendChild(title);
        headerRow.appendChild(leftTitle);

        if (r.type === 'local') {
            const badge = document.createElement('span');
            badge.className = 'chip chip-local py-0 px-2 font-size-07rem';
            badge.textContent = 'Local';
            headerRow.appendChild(badge);
        } else if (r.useNetbird) {
            const badge = document.createElement('span');
            badge.className = 'chip chip-netbird py-0 px-2 font-size-07rem';
            badge.textContent = 'NetBird';
            headerRow.appendChild(badge);
        }

        const reason = document.createElement('p');
        reason.className = 'card-text mb-2 text-secondary font-size-075rem text-break';
        reason.textContent = r.reason || 'No reason provided';

        const btnGroup = document.createElement('div');
        btnGroup.className = 'd-flex gap-1';

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'btn btn-primary btn-sm flex-grow-1 py-1 font-size-07rem';
        approveBtn.textContent = 'Approve';
        approveBtn.setAttribute('aria-label', `Approve connection to ${r.host}`);
        approveBtn.addEventListener('click', () => showAuthModal(r));

        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'btn btn-outline-danger btn-sm py-1 px-2 font-size-07rem';
        rejectBtn.textContent = 'Reject';
        rejectBtn.setAttribute('aria-label', `Reject connection to ${r.host}`);
        rejectBtn.addEventListener('click', () => rejectPendingRequest(r.id));

        btnGroup.appendChild(approveBtn);
        btnGroup.appendChild(rejectBtn);

        cardBody.appendChild(headerRow);
        cardBody.appendChild(reason);
        cardBody.appendChild(btnGroup);
        card.appendChild(cardBody);
        pendingList.appendChild(card);
    });
}

function rejectPendingRequest(requestId) {
    socket.emit('session:reject_request', { requestId }, (resp) => {
        if (resp && !resp.ok) {
            showToast('Error', resp.error || 'Failed to reject request', 'danger');
        }
    });
}

function updateTransportChip(transport) {
    if (!transportChip) return;
    if (transport && transport.startsWith('local-')) {
        transportChip.className = 'chip chip-local';
        transportChip.textContent = `Local: ${transport.slice(6)}`;
    } else if (transport && transport.startsWith('netbird')) {
        transportChip.className = 'chip chip-netbird';
        transportChip.textContent = transport === 'netbird-jwt' ? 'NetBird SSO' : 'NetBird SSH';
    } else {
        transportChip.classList.add('d-none');
    }
}

function switchSession(id) {
    currentSessionId = id;
    const session = sessions.find((s) => s.id === id);
    if (!session) return;

    activeSessionName.textContent = session.name;
    updateTransportChip(session.transport);
    terminalHeader.classList.remove('d-none');
    terminalContainer.classList.remove('d-none');
    emptyState.classList.add('d-none');

    Object.values(terminals).forEach((t) => t.container.classList.add('d-none'));

    const termObj = getOrCreateTerminal(id);
    termObj.container.classList.remove('d-none');

    if (termObj.ready) {
        socket.emit('session:join', id);
    }

    updateUIForStatus(session.status, session.handoffMessage);
    if (recordToggle) recordToggle.checked = session.isRecording !== false;

    renderSessions();
    setTimeout(() => {
        termObj.fitAddon.fit();
    }, 10);
}

function updateUIForStatus(status, message) {
    controlChip.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'material-icons me-1 size-14';
    icon.setAttribute('aria-hidden', 'true');

    if (status === 'user_control') {
        icon.textContent = 'person';
        controlChip.appendChild(icon);
        controlChip.appendChild(document.createTextNode('User Control'));
        controlChip.className = 'chip chip-user';
        if (returnControlBtn) returnControlBtn.classList.remove('d-none');
        if (message && handoffAlert && handoffMessage) {
            handoffAlert.classList.remove('d-none');
            handoffMessage.textContent = message;
        }
    } else {
        icon.textContent = 'auto_fix_high';
        controlChip.appendChild(icon);
        controlChip.appendChild(document.createTextNode('AI Control'));
        controlChip.className = 'chip chip-ai';
        if (returnControlBtn) returnControlBtn.classList.add('d-none');
        if (handoffAlert) handoffAlert.classList.add('d-none');
    }
}

// Auth Method Toggle Helpers
function setupAuthMethodControls(prefix) {
    const select = document.getElementById(`${prefix}-auth-type`);
    const passGroup = document.getElementById(`${prefix}-password-group`);
    const passInput = document.getElementById(`${prefix}-password`);
    const keyGroup = document.getElementById(`${prefix}-key-group`);
    const keyInput = document.getElementById(`${prefix}-private-key`);
    const keyFile = document.getElementById(`${prefix}-key-file`);
    const netbirdGroup = document.getElementById(`${prefix}-netbird-group`);
    const agentGroup = document.getElementById(`${prefix}-agent-group`);
    const strictGroup = document.getElementById(`${prefix}-strict-group`);

    const syncVisibility = () => {
        const mode = select.value;
        passGroup.classList.toggle('d-none', mode !== 'password');
        passInput.required = mode === 'password';

        keyGroup.classList.toggle('d-none', mode !== 'privateKey');
        keyInput.required = mode === 'privateKey';

        netbirdGroup.classList.toggle('d-none', mode !== 'netbird');
        agentGroup.classList.toggle('d-none', mode !== 'agent');
        strictGroup.classList.toggle('d-none', mode === 'netbird');
    };

    select.addEventListener('change', syncVisibility);

    if (keyFile) {
        keyFile.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                keyInput.value = String(reader.result || '');
            };
            reader.readAsText(file);
        });
    }

    syncVisibility();
    return { syncVisibility };
}

function collectAuthConfig(prefix) {
    const host = document.getElementById(`${prefix}-host`).value.trim();
    const port = parseInt(document.getElementById(`${prefix}-port`).value, 10) || 22;
    const userEl = document.getElementById(`${prefix}-username`) || document.getElementById(`${prefix}-user`);
    const username = userEl ? userEl.value.trim() : '';
    const authType = document.getElementById(`${prefix}-auth-type`).value;
    const strictHostKeyChecking = document.getElementById(`${prefix}-strict-host`).checked;

    const authConfig = {
        host,
        port,
        username,
        authType,
        useNetbird: authType === 'netbird',
        useAgent: authType === 'agent',
        strictHostKeyChecking
    };

    if (authType === 'password') {
        authConfig.password = document.getElementById(`${prefix}-password`).value;
    } else if (authType === 'privateKey') {
        authConfig.privateKey = document.getElementById(`${prefix}-private-key`).value;
        const passphrase = document.getElementById(`${prefix}-passphrase`).value;
        if (passphrase) authConfig.passphrase = passphrase;
    }

    return authConfig;
}

const modalAuthControls = setupAuthMethodControls('modal');
const manualAuthControls = setupAuthMethodControls('manual');

const manualConnectModal = new bootstrap.Modal(document.getElementById('manualConnectModal'));
const authModal = new bootstrap.Modal(document.getElementById('authModal'));
const localTerminalModal = new bootstrap.Modal(document.getElementById('localTerminalModal'));

document.getElementById('localTerminalModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('local-terminal-form').reset();
    updateLocalShellDropdowns();
});

document.getElementById('manualConnectModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('manual-connect-form').reset();
    manualAuthControls.syncVisibility();
});

document.getElementById('authModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('auth-form').reset();
    modalAuthControls.syncVisibility();
});

function setAuthModalMode(mode) {
    const isLocal = mode === 'local';
    document.getElementById('modal-request-type').value = isLocal ? 'local' : 'ssh';
    document.getElementById('modal-local-fields').classList.toggle('d-none', !isLocal);
    document.getElementById('modal-ssh-fields').classList.toggle('d-none', isLocal);

    document.getElementById('modal-host').required = !isLocal;
    document.getElementById('modal-port').required = !isLocal;
    document.getElementById('modal-username').required = !isLocal;
    if (isLocal) {
        document.getElementById('modal-password').required = false;
        document.getElementById('modal-private-key').required = false;
    } else {
        modalAuthControls.syncVisibility();
    }
}

function showAuthModal(request) {
    document.getElementById('modal-request-id').value = request.id;

    if (request.type === 'local') {
        setAuthModalMode('local');
        populateLocalShellSelect(document.getElementById('modal-local-shell'), request.shell);
        document.getElementById('modal-local-cwd').value = request.cwd || '';
        document.getElementById('modal-request-desc').textContent =
            `Authorize local ${request.shell} terminal${request.reason ? ` — "${request.reason}"` : ''}`;
    } else {
        setAuthModalMode('ssh');
        document.getElementById('modal-host').value = request.host;
        document.getElementById('modal-port').value = request.port || 22;
        document.getElementById('modal-username').value = request.username;
        document.getElementById('modal-request-desc').textContent =
            `Authorize ${request.useNetbird ? 'NetBird SSH' : 'SSH'} connection to ${request.username}@${request.host}${request.reason ? ` — "${request.reason}"` : ''}`;
        document.getElementById('modal-password').value = '';
        document.getElementById('modal-private-key').value = '';
        document.getElementById('modal-passphrase').value = '';
        document.getElementById('modal-auth-type').value = request.useNetbird ? 'netbird' : 'password';
        modalAuthControls.syncVisibility();
    }
    authModal.show();
}

document.getElementById('local-terminal-form').onsubmit = (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting...';

    const shell = document.getElementById('local-shell-select').value;
    const cwd = document.getElementById('local-cwd').value.trim() || undefined;
    const customName = document.getElementById('local-session-name').value.trim();
    const sessionName = customName || `Local (${shell})`;

    socket.emit('session:connect_local', { shell, cwd, name: sessionName }, (resp) => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;

        if (resp && resp.ok) {
            localTerminalModal.hide();
            document.getElementById('local-terminal-form').reset();
            updateLocalShellDropdowns();
            showToast('Success', `Started ${sessionName}`, 'success');
        } else {
            showToast('Failed to Start Shell', resp?.error || 'Unable to launch local terminal', 'danger');
        }
    });
};

document.getElementById('manual-connect-form').onsubmit = (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    const authConfig = collectAuthConfig('manual');
    const portSuffix = authConfig.port !== 22 ? `:${authConfig.port}` : '';
    const sessionName = `${authConfig.username}@${authConfig.host}${portSuffix}`;

    socket.emit('session:connect_manual', { authConfig, name: sessionName }, (resp) => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;

        if (resp && resp.ok) {
            manualConnectModal.hide();
            document.getElementById('manual-connect-form').reset();
            manualAuthControls.syncVisibility();
            showToast('Success', `Connected to ${sessionName}`, 'success');
        } else {
            showToast('Connection Failed', resp?.error || 'Unable to establish SSH connection', 'danger');
        }
    });
};

document.getElementById('auth-form').onsubmit = (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    const requestId = document.getElementById('modal-request-id').value;
    const reqType = document.getElementById('modal-request-type').value;

    let authConfig;
    let sessionName;
    if (reqType === 'local') {
        const shell = document.getElementById('modal-local-shell').value;
        const cwd = document.getElementById('modal-local-cwd').value.trim() || undefined;
        authConfig = { type: 'local', shell, cwd };
        sessionName = `Local (${shell})`;
    } else {
        authConfig = collectAuthConfig('modal');
        const portSuffix = authConfig.port !== 22 ? `:${authConfig.port}` : '';
        sessionName = `${authConfig.username}@${authConfig.host}${portSuffix}`;
    }

    socket.emit('session:connect', { requestId, authConfig, name: sessionName }, (resp) => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;

        if (resp && resp.ok) {
            authModal.hide();
            document.getElementById('auth-form').reset();
            modalAuthControls.syncVisibility();
            showToast('Success', `Connected to ${sessionName}`, 'success');
        } else {
            showToast('Authorization Failed', resp?.error || 'Unable to establish SSH connection', 'danger');
        }
    });
};

if (recordToggle) {
    recordToggle.onchange = () => {
        if (currentSessionId) {
            socket.emit('session:set_recording', { sessionId: currentSessionId, enabled: recordToggle.checked });
        }
    };
}

if (returnControlBtn) {
    returnControlBtn.onclick = () => {
        if (currentSessionId) {
            socket.emit('session:return_control', currentSessionId);
        }
    };
}

if (closeSessionBtn) {
    closeSessionBtn.onclick = async () => {
        if (currentSessionId && confirm('Are you sure you want to close this session?')) {
            try {
                const res = await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || 'Failed to close session');
                }
                await refreshSessions();
            } catch (err) {
                showToast('Error', err.message, 'danger');
            }
        }
    };
}
