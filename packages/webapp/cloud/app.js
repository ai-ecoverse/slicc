import {
  assembleBundle,
  validateModelHasAccount,
  assembleDelta,
  bundleDropWarnings,
} from './cone-config-client.js';

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
  const relayHost = new URL(config.imsRelayUrl).host;
  const isOnRelayOrigin = relayHost === window.location.host;
  const isLocalhost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const nonce = crypto.randomUUID();

  let redirectUri;
  let state;
  if (isOnRelayOrigin) {
    // Dashboard is on the relay host (production). Direct same-origin redirect.
    redirectUri = window.location.origin + config.imsReceivePath;
    state = nonce;
  } else if (isLocalhost) {
    // Local dev: bounce through the relay using source:'local'.
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
  } else {
    // Other deployed origin (staging / preview / etc): bounce through the relay
    // using source:'remote'. The relay validates the origin against an
    // allowlist before redirecting.
    redirectUri = config.imsRelayUrl;
    state = btoa(
      JSON.stringify({
        source: 'remote',
        origin: window.location.origin,
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
      btn.addEventListener('click', () => runConeAction(li, c.sandboxId, 'pause'));
      actions.appendChild(btn);
    }
    if (c.state === 'paused') {
      const btn = document.createElement('button');
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => runConeAction(li, c.sandboxId, 'resume'));
      actions.appendChild(btn);
      const manageBtn = document.createElement('button');
      manageBtn.textContent = 'Manage';
      manageBtn.addEventListener('click', () => showManagePanel(li, c.sandboxId));
      actions.appendChild(manageBtn);
    }
    const killBtn = document.createElement('button');
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', () => runConeAction(li, c.sandboxId, 'kill'));
    actions.appendChild(killBtn);

    li.appendChild(actions);
    if (busyRows.has(c.sandboxId)) {
      applyBusyStateToRow(li, busyRows.get(c.sandboxId));
    }
    list.appendChild(li);
  }

  const running = cones.filter((c) => c.state === 'running' || c.state === 'reserved').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  const capRunning = CONFIG.capRunning ?? 1;
  const capPaused = CONFIG.capPaused ?? 5;
  document.getElementById('cap-info').textContent =
    `${running} running · ${paused} paused (cap: ${capRunning}/${capPaused})`;

  const btn = document.getElementById('create-btn');
  const runningCapHit = running >= capRunning;
  const pausedCapHit = paused >= capPaused;
  btn.disabled = runningCapHit || pausedCapHit;
  if (runningCapHit) {
    btn.title = `Cap reached (${running}/${capRunning} running). Pause or kill another first.`;
  } else if (pausedCapHit) {
    btn.title = `Paused cap reached (${paused}/${capPaused}). Resume or kill a paused cone first.`;
  } else {
    btn.title = '';
  }
}

function renderCreateConfig() {
  const accountListEl = document.getElementById('account-list');
  const modelSelect = document.getElementById('cone-model');
  if (!accountListEl || !modelSelect) return;

  // Read accounts from localStorage
  const accounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');

  // Render account checkboxes
  accountListEl.replaceChildren();
  for (const acc of accounts) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = acc.providerId;
    checkbox.className = 'account-checkbox';
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(' ' + acc.providerId));
    accountListEl.appendChild(label);
    accountListEl.appendChild(document.createElement('br'));
  }

  // Populate model dropdown with a static set
  modelSelect.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Select model...';
  modelSelect.appendChild(defaultOption);

  const models = [
    { value: 'adobe:claude-opus-4-6', label: 'Adobe: Claude Opus 4.6' },
    { value: 'anthropic:claude-opus-4-6', label: 'Anthropic: Claude Opus 4.6' },
    { value: 'openai:gpt-5', label: 'OpenAI: GPT-5' },
  ];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.value;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
}

function addSecretRow() {
  const container = document.getElementById('secret-rows');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'secret-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 's-name';
  nameInput.placeholder = 'SECRET_NAME';
  nameInput.autocomplete = 'off';

  const valueInput = document.createElement('input');
  valueInput.type = 'password';
  valueInput.className = 's-value';
  valueInput.placeholder = 'value';
  valueInput.autocomplete = 'off';

  const domainsInput = document.createElement('input');
  domainsInput.type = 'text';
  domainsInput.className = 's-domains';
  domainsInput.placeholder = 'domains (comma-separated)';
  domainsInput.autocomplete = 'off';

  row.appendChild(nameInput);
  row.appendChild(document.createTextNode(' '));
  row.appendChild(valueInput);
  row.appendChild(document.createTextNode(' '));
  row.appendChild(domainsInput);

  container.appendChild(row);
}

async function showManagePanel(li, sandboxId) {
  try {
    const data = await api('/api/cloud/cone-config?sandboxId=' + encodeURIComponent(sandboxId), {
      method: 'GET',
    });
    const idx = data.coneConfigIndex;

    // Remove existing manage panel if any
    const existing = li.querySelector('.manage-panel');
    if (existing) {
      existing.remove();
      return;
    }

    const panel = document.createElement('div');
    panel.className = 'manage-panel';

    // Model display
    const modelLabel = document.createElement('div');
    modelLabel.textContent = 'Current model: ' + (idx?.model || 'none');
    panel.appendChild(modelLabel);

    // Model selector
    const modelSelect = document.createElement('select');
    modelSelect.className = 'manage-model-select';
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Keep current model';
    modelSelect.appendChild(defaultOption);
    const models = [
      { value: 'adobe:claude-opus-4-6', label: 'Adobe: Claude Opus 4.6' },
      { value: 'anthropic:claude-opus-4-6', label: 'Anthropic: Claude Opus 4.6' },
      { value: 'openai:gpt-5', label: 'OpenAI: GPT-5' },
    ];
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    }
    panel.appendChild(modelSelect);

    // Account list with delete toggles
    if (idx?.accountProviderIds?.length) {
      const accountsHeader = document.createElement('div');
      accountsHeader.textContent = 'Connected accounts:';
      accountsHeader.style.marginTop = '10px';
      accountsHeader.style.fontWeight = 'bold';
      panel.appendChild(accountsHeader);

      for (const providerId of idx.accountProviderIds) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'delete-account-checkbox';
        checkbox.dataset.providerId = providerId;
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(' Delete ' + providerId));
        panel.appendChild(label);
        panel.appendChild(document.createElement('br'));
      }
    }

    // Secrets list with delete toggles
    if (idx?.secretNames?.length) {
      const secretsHeader = document.createElement('div');
      secretsHeader.textContent = 'Secrets:';
      secretsHeader.style.marginTop = '10px';
      secretsHeader.style.fontWeight = 'bold';
      panel.appendChild(secretsHeader);

      for (const name of idx.secretNames) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'delete-secret-checkbox';
        checkbox.dataset.secretName = name;
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(' Delete ' + name));
        panel.appendChild(label);
        panel.appendChild(document.createElement('br'));
      }
    }

    // Add secret section
    const addSecretHeader = document.createElement('div');
    addSecretHeader.textContent = 'Add secret:';
    addSecretHeader.style.marginTop = '10px';
    addSecretHeader.style.fontWeight = 'bold';
    panel.appendChild(addSecretHeader);

    const addSecretContainer = document.createElement('div');
    addSecretContainer.className = 'add-secret-rows';
    panel.appendChild(addSecretContainer);

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Add secret row';
    addBtn.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'secret-row';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 's-name';
      nameInput.placeholder = 'SECRET_NAME';

      const valueInput = document.createElement('input');
      valueInput.type = 'password';
      valueInput.className = 's-value';
      valueInput.placeholder = 'value';

      const domainsInput = document.createElement('input');
      domainsInput.type = 'text';
      domainsInput.className = 's-domains';
      domainsInput.placeholder = 'domains';

      row.appendChild(nameInput);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(valueInput);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(domainsInput);
      addSecretContainer.appendChild(row);
    });
    panel.appendChild(addBtn);

    // Reconnect button
    const reconnectBtn = document.createElement('button');
    reconnectBtn.textContent = 'Reconnect / set model';
    reconnectBtn.style.marginTop = '10px';
    reconnectBtn.addEventListener('click', () => {
      window.open('/?connect=1', 'slicc-connect', 'width=520,height=720');
    });
    panel.appendChild(reconnectBtn);

    // Apply on resume button
    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply on resume';
    applyBtn.style.marginTop = '10px';
    applyBtn.addEventListener('click', async () => {
      try {
        const newModel = modelSelect.value || '';

        // Gather delete sets
        const deleteProviderIds = Array.from(
          panel.querySelectorAll('.delete-account-checkbox:checked')
        ).map((el) => el.dataset.providerId);

        const deleteSecretNames = Array.from(
          panel.querySelectorAll('.delete-secret-checkbox:checked')
        ).map((el) => el.dataset.secretName);

        // Gather new secret rows
        const upsertSecretRows = Array.from(
          panel.querySelectorAll('.add-secret-rows .secret-row')
        ).map((row) => ({
          name: row.querySelector('.s-name')?.value || '',
          value: row.querySelector('.s-value')?.value || '',
          domains: row.querySelector('.s-domains')?.value || '',
        }));

        // Read all accounts from localStorage and offer to re-send all of them
        const allAccounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');

        // For simplicity, we'll let the user re-send all currently connected accounts
        // In a more refined UX, we could show checkboxes for each account
        const upsertAccounts = allAccounts;

        // Same warn-don't-block surface as create: assembleDelta drops
        // credential-less accounts / domain-less secrets, so tell the user.
        const dropWarnings = bundleDropWarnings({
          selectedProviderIds: upsertAccounts.map((a) => a.providerId),
          allAccounts: upsertAccounts,
          secretRows: upsertSecretRows,
        });
        if (dropWarnings.length > 0) showToast(dropWarnings.join(' '));

        const coneConfigDelta = assembleDelta({
          model: newModel,
          upsertAccounts,
          upsertSecretRows,
          deleteProviderIds,
          deleteSecretNames,
        });

        await api('/api/cloud/resume', {
          method: 'POST',
          body: JSON.stringify({ sandboxId, coneConfigDelta }),
        });

        showToast('Configuration updated - will apply on next resume');
        panel.remove();
        await refreshList();
      } catch (e) {
        showToast('Apply failed: ' + e.message);
      }
    });
    panel.appendChild(applyBtn);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.style.marginTop = '10px';
    closeBtn.addEventListener('click', () => panel.remove());
    panel.appendChild(closeBtn);

    li.appendChild(panel);
  } catch (e) {
    showToast('Manage failed: ' + e.message);
  }
}

async function refreshList() {
  try {
    const data = await api('/api/cloud/list');
    renderCones(data.cones || []);
  } catch (e) {
    if (e.message !== 'unauthorized') showToast('List failed: ' + e.message);
  }
}

// Tracks which cones have an action in-flight so re-renders preserve the
// busy state. Maps sandboxId → action label ('Pausing…' / 'Resuming…' / 'Killing…').
const busyRows = new Map();

const ACTIONS = {
  pause: { label: 'Pausing…', path: '/api/cloud/pause', confirm: null },
  resume: { label: 'Resuming…', path: '/api/cloud/resume', confirm: null },
  kill: {
    label: 'Killing…',
    path: '/api/cloud/kill',
    confirm: 'Kill this cone? This cannot be undone.',
  },
};

function applyBusyStateToRow(li, label) {
  li.classList.add('cone--busy');
  for (const btn of li.querySelectorAll('button')) {
    btn.disabled = true;
  }
  let badge = li.querySelector('.cone-busy-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'cone-busy-badge';
    const statusEl = li.querySelector('.status');
    if (statusEl) statusEl.appendChild(badge);
  }
  badge.textContent = ' · ' + label;
}

async function runConeAction(li, sandboxId, kind) {
  const action = ACTIONS[kind];
  if (!action) return;
  if (action.confirm && !confirm(action.confirm)) return;
  busyRows.set(sandboxId, action.label);
  applyBusyStateToRow(li, action.label);
  try {
    await api(action.path, { method: 'POST', body: JSON.stringify({ sandboxId }) });
  } catch (e) {
    showToast(kind.charAt(0).toUpperCase() + kind.slice(1) + ' failed: ' + e.message);
  } finally {
    busyRows.delete(sandboxId);
    await refreshList();
  }
}

document.getElementById('sign-in-btn').addEventListener('click', async () => {
  try {
    await startImsPopup();
    setSignedIn();
    renderCreateConfig();
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
  const modelSelect = document.getElementById('cone-model');
  const name = nameInput.value.trim() || undefined;

  // Gather config
  const model = modelSelect?.value;
  if (!model) {
    showToast('Please select a model.');
    return;
  }

  const selectedProviderIds = Array.from(
    document.querySelectorAll('#account-list input:checked')
  ).map((el) => el.value);

  const allAccounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');

  const secretRows = Array.from(document.querySelectorAll('#secret-rows .secret-row')).map(
    (row) => ({
      name: row.querySelector('.s-name')?.value || '',
      value: row.querySelector('.s-value')?.value || '',
      domains: row.querySelector('.s-domains')?.value || '',
    })
  );

  // Validate model has account
  if (!validateModelHasAccount(model, selectedProviderIds, ['local'])) {
    showToast('Selected model needs a connected account for its provider.');
    return;
  }

  // Warn (don't block) about selected entries that will be dropped as unusable,
  // so a credential-less account or domain-less secret doesn't vanish silently.
  const warnings = bundleDropWarnings({ selectedProviderIds, allAccounts, secretRows });
  if (warnings.length > 0) showToast(warnings.join(' '));

  const coneConfig = assembleBundle({ model, selectedProviderIds, allAccounts, secretRows });

  const originalLabel = createBtn.textContent;
  createBtn.disabled = true;
  createBtn.textContent = 'Starting…';
  status.textContent = 'creating cone (this can take 30s)…';
  try {
    const result = await api('/api/cloud/start', {
      method: 'POST',
      body: JSON.stringify({ name, coneConfig }),
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
  if (getToken()) {
    refreshList();
    renderCreateConfig(); // Refresh accounts in case user connected a new provider
  }
});

document.getElementById('add-secret')?.addEventListener('click', addSecretRow);

document.getElementById('connect-btn')?.addEventListener('click', () => {
  window.open('/?connect=1', 'slicc-connect', 'width=520,height=720');
});

const signInBtn = document.getElementById('sign-in-btn');
signInBtn.disabled = true;
signInBtn.textContent = 'Loading…';
loadConfig()
  .then(() => {
    signInBtn.disabled = false;
    signInBtn.textContent = 'Sign in with Adobe';
    if (getToken()) {
      setSignedIn();
      renderCreateConfig();
      refreshList();
    } else {
      setSignedOut();
    }
  })
  .catch((e) => {
    signInBtn.textContent = 'Config error';
    showToast('Could not load IMS config: ' + e.message);
    setSignedOut();
  });
