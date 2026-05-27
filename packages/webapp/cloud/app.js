const TOKEN_KEY = 'cloud-ims-token';
const TOKEN_EXP_KEY = 'cloud-ims-token-exp';

let CONFIG = null;
async function loadConfig() {
  if (CONFIG) return CONFIG;
  const res = await fetch('/api/cloud/config');
  if (!res.ok) throw new Error('config fetch failed: ' + res.status);
  CONFIG = await res.json();
  return CONFIG;
}

function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const exp = parseInt(localStorage.getItem(TOKEN_EXP_KEY) || '0', 10);
  if (!token || exp < Date.now()) return null;
  return token;
}

function setToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(
    TOKEN_EXP_KEY,
    String(Date.now() + (parseInt(expiresInSec, 10) || 0) * 1000)
  );
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
}

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function setSignedIn() {
  document.getElementById('signed-out').classList.add('hidden');
  document.getElementById('signed-in').classList.remove('hidden');
  document.getElementById('user-box').classList.remove('hidden');
  document.getElementById('user-label').textContent = 'signed in';
}

function setSignedOut() {
  document.getElementById('signed-out').classList.remove('hidden');
  document.getElementById('signed-in').classList.add('hidden');
  document.getElementById('user-box').classList.add('hidden');
}

async function startImsPopup() {
  const config = await loadConfig();
  const isOnRelayOrigin = new URL(config.imsRelayUrl).host === window.location.host;
  const nonce = crypto.randomUUID();

  let redirectUri;
  let state;
  if (isOnRelayOrigin) {
    // Production: dashboard is on the same origin as the relay. Direct redirect.
    redirectUri = window.location.origin + config.imsReceivePath;
    state = nonce;
  } else {
    // Dev (localhost or other origin): bounce via sliccy.ai/auth/callback.
    // The relay reads state, decodes { source, port, path, nonce }, and
    // redirects to http://localhost:<port>/auth/cloud-callback?nonce=<nonce>#<original-hash>.
    redirectUri = config.imsRelayUrl;
    const port = Number(window.location.port) || (window.location.protocol === 'https:' ? 443 : 80);
    state = btoa(
      JSON.stringify({
        source: 'local',
        port,
        path: config.imsReceivePath,
        nonce,
      })
    );
  }

  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: config.imsClientId,
      scope: config.imsScope,
      response_type: 'token',
      redirect_uri: redirectUri,
      state,
    });
    const popup = window.open(
      `${config.imsAuthorizeUrl}?${params}`,
      'sliccy-cloud-ims',
      'width=480,height=640'
    );
    if (!popup) return reject(new Error('popup blocked'));

    function onMessage(ev) {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === 'sliccy.cloud.imsToken') {
        window.removeEventListener('message', onMessage);
        setToken(ev.data.token, ev.data.expiresIn);
        resolve();
      } else if (ev.data?.type === 'sliccy.cloud.imsError') {
        window.removeEventListener('message', onMessage);
        reject(new Error(ev.data.error));
      }
    }
    window.addEventListener('message', onMessage);
  });
}

async function api(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('not authenticated');
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    setSignedOut();
    showToast('Session expired — please sign in again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'unknown', message: res.statusText }));
    throw Object.assign(new Error(body.message || 'error'), { code: body.error });
  }
  return res.json();
}

function timeAgo(iso) {
  if (!iso) return 'just now';
  const d = new Date(iso);
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} hr ago`;
}

// Safe DOM building — every value goes through textContent or attribute setters.
// No innerHTML, no template-literal HTML.
function renderCones(cones) {
  const list = document.getElementById('cone-list');
  list.replaceChildren();

  for (const c of cones) {
    const li = document.createElement('li');
    li.className = `cone ${c.state}`;

    const left = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = 'state-dot';
    left.appendChild(dot);
    const name = document.createElement('strong');
    name.textContent = c.name || c.sandboxId;
    left.appendChild(name);
    left.appendChild(document.createTextNode(' '));
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = `${c.state} · ${timeAgo(c.lastSeen)}`;
    left.appendChild(status);
    li.appendChild(left);

    const actions = document.createElement('div');
    actions.className = 'cone-actions';

    if (c.state === 'running' && c.joinUrl) {
      const open = document.createElement('a');
      open.href = c.joinUrl;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.title =
        'This link grants follower access — only share with people you trust to see this cone.';
      open.textContent = 'Open ↗';
      actions.appendChild(open);
    }
    if (c.state === 'running') {
      const btn = document.createElement('button');
      btn.textContent = 'Pause';
      btn.addEventListener('click', () => pauseCone(c.sandboxId));
      actions.appendChild(btn);
    }
    if (c.state === 'paused') {
      const btn = document.createElement('button');
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => resumeCone(c.sandboxId));
      actions.appendChild(btn);
    }
    const killBtn = document.createElement('button');
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', () => killConeAction(c.sandboxId));
    actions.appendChild(killBtn);

    li.appendChild(actions);
    list.appendChild(li);
  }

  const running = cones.filter((c) => c.state === 'running').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  document.getElementById('cap-info').textContent =
    `${running} running · ${paused} paused (cap: 1/5)`;

  const btn = document.getElementById('create-btn');
  btn.disabled = running >= 1;
  btn.title = btn.disabled
    ? `Cap reached (${running}/1 running). Pause or kill another first.`
    : '';
}

async function refreshList() {
  try {
    const data = await api('/api/cloud/list');
    renderCones(data.cones || []);
  } catch (e) {
    if (e.message !== 'unauthorized') showToast('List failed: ' + e.message);
  }
}

async function pauseCone(sandboxId) {
  try {
    await api('/api/cloud/pause', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Pause failed: ' + e.message);
  }
}

async function resumeCone(sandboxId) {
  try {
    await api('/api/cloud/resume', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Resume failed: ' + e.message);
  }
}

async function killConeAction(sandboxId) {
  if (!confirm('Kill this cone? This cannot be undone.')) return;
  try {
    await api('/api/cloud/kill', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Kill failed: ' + e.message);
  }
}

document.getElementById('sign-in-btn').addEventListener('click', async () => {
  try {
    await startImsPopup();
    setSignedIn();
    await refreshList();
  } catch (err) {
    showToast('Sign-in failed: ' + err.message);
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  const token = getToken();
  if (token) {
    try {
      await fetch('/api/cloud/sign-out', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* best-effort */
    }
  }
  clearToken();
  setSignedOut();
});

const createBtn = document.getElementById('create-btn');
createBtn.addEventListener('click', async () => {
  if (createBtn.disabled) return; // already in flight
  const nameInput = document.getElementById('cone-name');
  const status = document.getElementById('create-status');
  const name = nameInput.value.trim() || undefined;
  const originalLabel = createBtn.textContent;
  createBtn.disabled = true;
  createBtn.textContent = 'Starting…';
  status.textContent = 'creating cone (this can take 30s)…';
  try {
    const result = await api('/api/cloud/start', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    status.textContent = 'ready';
    nameInput.value = '';
    await refreshList();
    if (result.joinUrl) {
      window.open(result.joinUrl, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    showToast('Create failed: ' + e.message);
    status.textContent = '';
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = originalLabel;
    setTimeout(() => (status.textContent = ''), 3000);
  }
});

window.addEventListener('focus', () => {
  if (getToken()) refreshList();
});

if (getToken()) {
  setSignedIn();
  refreshList();
} else {
  setSignedOut();
}

const signInBtn = document.getElementById('sign-in-btn');
signInBtn.disabled = true;
signInBtn.textContent = 'Loading…';
loadConfig()
  .then(() => {
    signInBtn.disabled = false;
    signInBtn.textContent = 'Sign in with Adobe';
  })
  .catch((e) => {
    signInBtn.textContent = 'Config error';
    showToast('Could not load IMS config: ' + e.message);
  });
