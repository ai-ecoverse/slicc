import {
  assembleBundle,
  assembleDelta,
  assembleResumeDelta,
  bundleDropWarnings,
  MODEL_CATALOG_KEY,
  modelsForConnected,
  parseModelCatalog,
  providerLabel,
  validateModelHasAccount,
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
  ensureAdobeDefaultAccount();
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
    redirectUri = window.location.origin + config.imsReceivePath;
    state = nonce;
  } else if (isLocalhost) {
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
      btn.addEventListener('click', () => {
        runConeAction(li, c.sandboxId, 'pause').catch(() => {});
      });
      actions.appendChild(btn);
    }
    if (c.state === 'paused') {
      const btn = document.createElement('button');
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => {
        runConeAction(li, c.sandboxId, 'resume').catch(() => {});
      });
      actions.appendChild(btn);
      const manageBtn = document.createElement('button');
      manageBtn.textContent = 'Manage';
      manageBtn.addEventListener('click', () => {
        showManagePanel(li, c.sandboxId).catch(() => {});
      });
      actions.appendChild(manageBtn);
    }
    const killBtn = document.createElement('button');
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', () => {
      runConeAction(li, c.sandboxId, 'kill').catch(() => {});
    });
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

function readAccounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readCatalog() {
  return parseModelCatalog(localStorage.getItem(MODEL_CATALOG_KEY));
}

function removeDashboardAccount(providerId) {
  if (providerId === ADOBE_PROVIDER_ID) {
    try {
      localStorage.setItem(ADOBE_OPTOUT_KEY, '1');
    } catch {}
  }
  const accounts = readAccounts().filter((a) => a.providerId !== providerId);
  try {
    localStorage.setItem('slicc_accounts', JSON.stringify(accounts));
  } catch {}
  renderCreateConfig();
}

const ADOBE_PROVIDER_ID = 'adobe';

const ADOBE_OPTOUT_KEY = 'slicc_cloud_adobe_optout';

function ensureAdobeDefaultAccount(force = false) {
  const token = getToken();
  if (!token) return;
  if (force) {
    try {
      localStorage.removeItem(ADOBE_OPTOUT_KEY);
    } catch {}
  } else if (localStorage.getItem(ADOBE_OPTOUT_KEY)) {
    return;
  }
  const expMs = parseInt(localStorage.getItem(TOKEN_EXP_KEY) || '0', 10) || undefined;
  const accounts = readAccounts();
  const adobe = accounts.find((a) => a.providerId === ADOBE_PROVIDER_ID);
  if (adobe) {
    adobe.accessToken = token;
    if (expMs) adobe.tokenExpiresAt = expMs;
    if (!adobe.kind) adobe.kind = 'oauth';
  } else if (force || accounts.length === 0) {
    accounts.push({
      providerId: ADOBE_PROVIDER_ID,
      kind: 'oauth',
      accessToken: token,
      ...(expMs ? { tokenExpiresAt: expMs } : {}),
    });
  } else {
    return;
  }
  try {
    localStorage.setItem('slicc_accounts', JSON.stringify(accounts));
  } catch {}
}

function effectiveCatalog() {
  const catalog = readCatalog();
  const adobeModels = (
    CONFIG && Array.isArray(CONFIG.adobeModels) ? CONFIG.adobeModels : []
  ).filter((m) => m?.id);
  if (adobeModels.length === 0) return catalog;
  const others = catalog.filter((g) => g.providerId !== ADOBE_PROVIDER_ID);
  return [
    {
      providerId: ADOBE_PROVIDER_ID,
      providerName: 'Adobe',
      models: adobeModels.map((m) => ({ id: m.id, name: m.name || m.id })),
    },
    ...others,
  ];
}

function populateModelSelect(selectEl, groups, current, placeholder) {
  selectEl.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  selectEl.appendChild(first);

  let count = 0;
  for (const group of groups) {
    const og = document.createElement('optgroup');
    og.label = group.providerName;
    for (const model of group.models) {
      const opt = document.createElement('option');
      opt.value = `${group.providerId}:${model.id}`;
      opt.textContent = model.name;
      og.appendChild(opt);
      count++;
    }
    selectEl.appendChild(og);
  }
  if (current && groups.some((g) => g.models.some((m) => `${g.providerId}:${m.id}` === current))) {
    selectEl.value = current;
  }
  return count > 0;
}

function accountBadge(acc) {
  if (acc.accessToken) return { text: acc.userName || 'Logged in', warn: false };
  if (acc.apiKey) return { text: 'API key', warn: false };
  return { text: 'No credential', warn: true };
}

function renderCreateConfig() {
  const card = document.getElementById('create-card');
  const accountListEl = document.getElementById('account-list');
  const connectBtn = document.getElementById('connect-btn');
  const modelSelect = document.getElementById('cone-model');
  if (!card || !accountListEl || !modelSelect) return;

  const accounts = readAccounts();
  const hasProviders = accounts.length > 0;
  card.classList.toggle('has-providers', hasProviders);
  if (connectBtn) connectBtn.textContent = hasProviders ? 'Manage providers' : 'Connect a provider';

  const catalog = effectiveCatalog();
  accountListEl.replaceChildren();
  for (const acc of accounts) {
    const row = document.createElement('div');
    row.className = 'account-row';
    const name = document.createElement('span');
    name.className = 'account-row__name';
    name.textContent = providerLabel(acc.providerId, catalog);
    row.appendChild(name);
    const badge = accountBadge(acc);
    const badgeEl = document.createElement('span');
    badgeEl.className = 'account-row__badge' + (badge.warn ? ' account-row__badge--warn' : '');
    badgeEl.textContent = badge.text;
    row.appendChild(badgeEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'account-row__remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeDashboardAccount(acc.providerId));
    row.appendChild(removeBtn);

    accountListEl.appendChild(row);
  }

  const hasAdobe = accounts.some((a) => a.providerId === ADOBE_PROVIDER_ID);
  const addAdobeBtn = document.getElementById('add-adobe-btn');
  if (addAdobeBtn) addAdobeBtn.classList.toggle('hidden', hasAdobe || !getToken());

  const groups = modelsForConnected(catalog, accounts);
  const hadModels = populateModelSelect(
    modelSelect,
    groups,
    modelSelect.value,
    groups.length === 0 ? 'Open Connect to load models' : 'Select model…'
  );
  modelSelect.disabled = !hadModels;
}

function makeSecretRow() {
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

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'secret-row__remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove secret';
  removeBtn.addEventListener('click', () => row.remove());

  row.append(nameInput, valueInput, domainsInput, removeBtn);
  return row;
}

function addSecretRow() {
  const container = document.getElementById('secret-rows');
  if (container) container.appendChild(makeSecretRow());
}

function appendManagePanelSectionHeader(panel, text) {
  const header = document.createElement('div');
  header.textContent = text;
  header.style.marginTop = '10px';
  header.style.fontWeight = 'bold';
  panel.appendChild(header);
}

function appendManagePanelDeleteCheckboxes(panel, { className, datasetKey, items, labelPrefix }) {
  if (!items?.length) return;
  for (const item of items) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = className;
    checkbox.dataset[datasetKey] = item;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${labelPrefix} ${item}`));
    panel.appendChild(label);
    panel.appendChild(document.createElement('br'));
  }
}

function createManagePanelModelSelect(idx) {
  const modelLabel = document.createElement('div');
  modelLabel.textContent = 'Current model: ' + (idx?.model || 'none');

  const modelSelect = document.createElement('select');
  modelSelect.className = 'manage-model-select';
  populateModelSelect(
    modelSelect,
    modelsForConnected(effectiveCatalog(), readAccounts()),
    '',
    'Keep current model'
  );

  const section = document.createElement('div');
  section.append(modelLabel, modelSelect);
  return { section, modelSelect };
}

function appendManagePanelDeleteSections(panel, idx) {
  if (idx?.accountProviderIds?.length) {
    appendManagePanelSectionHeader(panel, 'Connected accounts:');
    appendManagePanelDeleteCheckboxes(panel, {
      className: 'delete-account-checkbox',
      datasetKey: 'providerId',
      items: idx.accountProviderIds,
      labelPrefix: 'Delete',
    });
  }
  if (idx?.secretNames?.length) {
    appendManagePanelSectionHeader(panel, 'Secrets:');
    appendManagePanelDeleteCheckboxes(panel, {
      className: 'delete-secret-checkbox',
      datasetKey: 'secretName',
      items: idx.secretNames,
      labelPrefix: 'Delete',
    });
  }
}

function appendManagePanelAddSecretSection(panel) {
  appendManagePanelSectionHeader(panel, 'Add secret:');
  const addSecretContainer = document.createElement('div');
  addSecretContainer.className = 'add-secret-rows';
  panel.appendChild(addSecretContainer);

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add secret row';
  addBtn.addEventListener('click', () => addSecretContainer.appendChild(makeSecretRow()));
  panel.appendChild(addBtn);
}

async function applyManagePanelChanges(panel, modelSelect, sandboxId) {
  const newModel = modelSelect.value || '';

  const deleteProviderIds = Array.from(
    panel.querySelectorAll('.delete-account-checkbox:checked')
  ).map((el) => el.dataset.providerId);
  const deleteSecretNames = Array.from(
    panel.querySelectorAll('.delete-secret-checkbox:checked')
  ).map((el) => el.dataset.secretName);
  const upsertSecretRows = Array.from(panel.querySelectorAll('.add-secret-rows .secret-row')).map(
    (row) => ({
      name: row.querySelector('.s-name')?.value || '',
      value: row.querySelector('.s-value')?.value || '',
      domains: row.querySelector('.s-domains')?.value || '',
    })
  );

  const allAccounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
  const upsertAccounts = allAccounts;

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
}

function appendManagePanelActionButtons(panel, { modelSelect, sandboxId }) {
  const reconnectBtn = document.createElement('button');
  reconnectBtn.textContent = 'Reconnect / set model';
  reconnectBtn.style.marginTop = '10px';
  reconnectBtn.addEventListener('click', () => {
    window.open('/?connect=1', 'slicc-connect', 'width=520,height=720');
  });
  panel.appendChild(reconnectBtn);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply on resume';
  applyBtn.style.marginTop = '10px';
  applyBtn.addEventListener('click', () => {
    applyManagePanelChanges(panel, modelSelect, sandboxId).catch((e) => {
      showToast('Apply failed: ' + e.message);
    });
  });
  panel.appendChild(applyBtn);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.marginTop = '10px';
  closeBtn.addEventListener('click', () => panel.remove());
  panel.appendChild(closeBtn);
}

function buildManagePanel(idx, sandboxId) {
  const panel = document.createElement('div');
  panel.className = 'manage-panel';

  const { section: modelSection, modelSelect } = createManagePanelModelSelect(idx);
  panel.appendChild(modelSection);
  appendManagePanelDeleteSections(panel, idx);
  appendManagePanelAddSecretSection(panel);
  appendManagePanelActionButtons(panel, { modelSelect, sandboxId });

  return panel;
}

async function showManagePanel(li, sandboxId) {
  try {
    const data = await api('/api/cloud/cone-config?sandboxId=' + encodeURIComponent(sandboxId), {
      method: 'GET',
    });
    const idx = data.coneConfigIndex;

    const existing = li.querySelector('.manage-panel');
    if (existing) {
      existing.remove();
      return;
    }

    li.appendChild(buildManagePanel(idx, sandboxId));
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
    const body = { sandboxId };
    if (kind === 'resume') {
      const coneConfigDelta = assembleResumeDelta(readAccounts());
      if (Object.keys(coneConfigDelta).length > 0) body.coneConfigDelta = coneConfigDelta;
    }
    await api(action.path, { method: 'POST', body: JSON.stringify(body) });
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
    } catch {}
  }
  clearToken();
  setSignedOut();
});

const createBtn = document.getElementById('create-btn');
createBtn.addEventListener('click', async () => {
  if (createBtn.disabled) return;
  const nameInput = document.getElementById('cone-name');
  const status = document.getElementById('create-status');
  const modelSelect = document.getElementById('cone-model');
  const name = nameInput.value.trim() || undefined;

  const model = modelSelect?.value;
  if (!model) {
    showToast('Please select a model.');
    return;
  }

  const allAccounts = readAccounts();
  if (allAccounts.length === 0) {
    showToast('Connect a provider before creating a cone.');
    return;
  }
  const selectedProviderIds = allAccounts.map((a) => a.providerId);

  const secretRows = Array.from(document.querySelectorAll('#secret-rows .secret-row')).map(
    (row) => ({
      name: row.querySelector('.s-name')?.value || '',
      value: row.querySelector('.s-value')?.value || '',
      domains: row.querySelector('.s-domains')?.value || '',
    })
  );

  if (!validateModelHasAccount(model, selectedProviderIds, ['local'])) {
    showToast('Selected model needs a connected account for its provider.');
    return;
  }

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
    refreshList().catch(() => {});
    renderCreateConfig();
  }
});

document.getElementById('add-secret')?.addEventListener('click', addSecretRow);

document.getElementById('add-adobe-btn')?.addEventListener('click', () => {
  ensureAdobeDefaultAccount(true);
  renderCreateConfig();
});

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
      refreshList().catch(() => {});
    } else {
      setSignedOut();
    }
  })
  .catch((e) => {
    signInBtn.textContent = 'Config error';
    showToast('Could not load IMS config: ' + e.message);
    setSignedOut();
  });
