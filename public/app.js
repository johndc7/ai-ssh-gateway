const socket = io();
const terminalContainer = document.getElementById('terminal-container');
const sessionList = document.getElementById('session-list');
const pendingList = document.getElementById('pending-requests');
const activeSessionName = document.getElementById('active-session-name');
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

let terminals = {}; // sessionId -> { term, fitAddon, container }
let currentSessionId = null;
let sessions = [];
let pendingRequests = [];

// Toast Notifications
function showToast(title, message, type = 'info') {
    const toastContainer = document.getElementById('toast-container');
    const toastEl = document.createElement('div');
    toastEl.className = `toast align-items-center text-bg-${type} border-0 mb-2`;
    toastEl.setAttribute('role', 'alert');
    toastEl.setAttribute('aria-live', 'assertive');
    toastEl.setAttribute('aria-atomic', 'true');
    
    toastEl.innerHTML = `
        <div class="d-flex">
            <div class="toast-body">
                <strong>${title}</strong><br/>
                ${message}
            </div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
    `;
    
    toastContainer.appendChild(toastEl);
    const toast = new bootstrap.Toast(toastEl, { autohide: true, delay: 5000 });
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

    term.onData(data => {
        const session = sessions.find(s => s.id === sessionId);
        if (session && session.status === 'ai_control' && autoTakeToggle.checked) {
            takeControlManually(sessionId);
        }
        socket.emit('terminal:input', { sessionId, data });
    });

    term.onResize(({ cols, rows }) => {
        socket.emit('terminal:resize', { sessionId, cols, rows });
    });

    terminals[sessionId] = { term, fitAddon, container };

    fetch(`/api/sessions/${sessionId}/history`)
        .then(res => res.text())
        .then(history => {
            if (history) term.write(history);
            setTimeout(() => {
                if (currentSessionId === sessionId) {
                    fitAddon.fit();
                }
            }, 50);
        });

    return terminals[sessionId];
}

window.addEventListener('resize', () => {
    if (currentSessionId && terminals[currentSessionId]) {
        terminals[currentSessionId].fitAddon.fit();
    }
});

function takeControlManually(sessionId) {
    if (!sessionId) return;
    fetch(`/api/sessions/${sessionId}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'User typing detected - switched to manual control' })
    });
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
    showToast('Connection Error', 'Failed to connect to gateway server.', 'danger');
});

socket.on('session:request', (request) => {
    pendingRequests.push(request);
    renderPending();
    showToast('New Connection Request', `Incoming request from ${request.username}@${request.host}`, 'info');
});

socket.on('session:started', (session) => {
    refreshSessions().then(() => {
        switchSession(session.id);
    });
});

socket.on('terminal:data', ({ sessionId, data }) => {
    const termObj = terminals[sessionId];
    if (termObj) {
        termObj.term.write(data);
    }
});

socket.on('session:ai_activity', ({ sessionId }) => {
    if (autoSwitchToggle && autoSwitchToggle.checked && currentSessionId !== sessionId) {
        switchSession(sessionId);
    }
});

socket.on('session:status', ({ status, message }) => {
    const session = sessions.find(s => s.id === currentSessionId);
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
        Object.keys(terminals).forEach(id => {
            if (!sessions.find(s => s.id === id)) {
                terminals[id].container.remove();
                terminals[id].term.dispose();
                delete terminals[id];
            }
        });
    });
});

// UI Actions
async function refreshSessions() {
    try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const data = await res.json();
        sessions = data.active;
        pendingRequests = data.pending;
        renderSessions();
        renderPending();
        
        sessions.forEach(s => {
            socket.emit('session:join', s.id);
            getOrCreateTerminal(s.id);
        });

        if (sessions.length > 0) {
            if (!currentSessionId || !sessions.find(s => s.id === currentSessionId)) {
                switchSession(sessions[0].id);
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
    sessionList.innerHTML = '';
    sessions.forEach(s => {
        const item = document.createElement('a');
        item.className = `list-group-item list-group-item-action d-flex align-items-center ${s.id === currentSessionId ? 'active' : ''}`;
        item.href = '#';
        item.setAttribute('role', 'button');
        item.innerHTML = `
            <span class="material-icons size-16 me-2" aria-hidden="true">${s.status === 'ai_control' ? 'auto_fix_high' : 'person'}</span>
            <div class="text-truncate flex-grow-1">${s.name}</div>
        `;
        item.onclick = (e) => {
            e.preventDefault();
            switchSession(s.id);
        };
        sessionList.appendChild(item);
    });
}

function renderPending() {
    if (pendingRequests.length === 0) {
        pendingList.innerHTML = '<p class="text-muted small ps-2">No pending requests.</p>';
        return;
    }
    pendingList.innerHTML = '';
    pendingRequests.forEach(r => {
        const div = document.createElement('div');
        div.className = 'card bg-dark-2 border-primary border-opacity-25 mb-2 mx-1 shadow-sm';
        div.innerHTML = `
            <div class="card-body p-2">
                <div class="d-flex align-items-center mb-1">
                    <span class="material-icons size-16 text-primary me-1" aria-hidden="true">person_add</span>
                    <h6 class="card-title mb-0 small fw-bold">${r.username}@${r.host}</h6>
                </div>
                <p class="card-text mb-2 text-secondary font-size-075rem">${r.reason || 'No reason provided'}</p>
                <button class="btn btn-primary btn-sm w-100 py-1 font-size-07rem" onclick="showAuthModal('${r.id}', '${r.host}', '${r.username}')" aria-label="Approve connection to ${r.host}">Approve</button>
            </div>
        `;
        pendingList.appendChild(div);
    });
}

function switchSession(id) {
    currentSessionId = id;
    const session = sessions.find(s => s.id === id);
    if (!session) return;

    activeSessionName.textContent = session.name;
    terminalHeader.classList.remove('d-none');
    terminalContainer.classList.remove('d-none');
    emptyState.classList.add('d-none');
    
    Object.values(terminals).forEach(t => t.container.classList.add('d-none'));
    
    const termObj = getOrCreateTerminal(id);
    termObj.container.classList.remove('d-none');
    
    socket.emit('session:join', id);
    
    updateUIForStatus(session.status, session.handoffMessage);
    if (recordToggle) recordToggle.checked = session.isRecording !== false;
    
    renderSessions();
    setTimeout(() => {
        termObj.fitAddon.fit();
    }, 10);
}

function updateUIForStatus(status, message) {
    if (status === 'user_control') {
        controlChip.innerHTML = '<span class="material-icons me-1 size-14" aria-hidden="true">person</span> User Control';
        controlChip.className = 'chip chip-user';
        if (returnControlBtn) returnControlBtn.classList.remove('d-none');
        if (message && handoffAlert && handoffMessage) {
            handoffAlert.classList.remove('d-none');
            handoffMessage.textContent = message;
        }
    } else {
        controlChip.innerHTML = '<span class="material-icons me-1 size-14" aria-hidden="true">auto_fix_high</span> AI Control';
        controlChip.className = 'chip chip-ai';
        if (returnControlBtn) returnControlBtn.classList.add('d-none');
        if (handoffAlert) handoffAlert.classList.add('d-none');
    }
}

// Event Listeners
const manualConnectModal = new bootstrap.Modal(document.getElementById('manualConnectModal'));
const authModal = new bootstrap.Modal(document.getElementById('authModal'));

document.getElementById('manual-connect-form').onsubmit = (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    const host = document.getElementById('manual-host').value;
    const user = document.getElementById('manual-user').value;
    const pass = document.getElementById('manual-password').value;
    const sessionName = `${user}@${host}`;
    
    fetch('/api/sessions/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, username: user, reason: 'Manual Connection' })
    }).then(res => {
        if (!res.ok) throw new Error('Failed to request session');
        return res.json();
    }).then(req => {
        socket.emit('session:connect', {
            requestId: req.id,
            authConfig: { host, username: user, password: pass },
            name: sessionName
        });
        
        const onStarted = (session) => {
            if (session.name === sessionName) {
                manualConnectModal.hide();
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
                document.getElementById('manual-connect-form').reset();
                showToast('Success', `Connected to ${sessionName}`, 'success');
                socket.off('session:started', onStarted);
            }
        };
        socket.on('session:started', onStarted);

        setTimeout(() => {
            if (submitBtn.disabled) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
                showToast('Warning', 'Connection request sent, but no confirmation received.', 'warning');
                socket.off('session:started', onStarted);
            }
        }, 10000);
    }).catch(err => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        showToast('Error', err.message, 'danger');
    });
};

document.getElementById('authModal').addEventListener('hidden.bs.modal', () => {
    document.getElementById('auth-form').reset();
});

window.showAuthModal = (id, host, username) => {
    document.getElementById('modal-request-id').value = id;
    document.getElementById('modal-host').value = host;
    document.getElementById('modal-username').value = username;
    document.getElementById('modal-request-desc').textContent = `Authorize connection to ${username}@${host}`;
    document.getElementById('modal-password').value = '';
    authModal.show();
};

document.getElementById('auth-form').onsubmit = (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connecting...';

    const requestId = document.getElementById('modal-request-id').value;
    const host = document.getElementById('modal-host').value;
    const username = document.getElementById('modal-username').value;
    const password = document.getElementById('modal-password').value;
    const sessionName = `${username}@${host}`;
    
    socket.emit('session:connect', {
        requestId,
        authConfig: { host, username, password },
        name: sessionName
    });
    
    const onStarted = (session) => {
        if (session.name === sessionName) {
            authModal.hide();
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            document.getElementById('auth-form').reset();
            showToast('Success', `Connected to ${sessionName}`, 'success');
            socket.off('session:started', onStarted);
        }
    };
    socket.on('session:started', onStarted);

    setTimeout(() => {
        if (submitBtn.disabled) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
            showToast('Warning', 'Connection request sent, but no confirmation received.', 'warning');
            socket.off('session:started', onStarted);
        }
    }, 10000);
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
    closeSessionBtn.onclick = () => {
        if (currentSessionId && confirm('Are you sure you want to close this session?')) {
            fetch(`/api/sessions/${currentSessionId}`, { method: 'DELETE' });
        }
    };
}