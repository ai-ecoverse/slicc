/**
 * Mount Secrets options page.
 *
 * Runs in the extension's options-page context (full chrome.* API access).
 * Reads/writes chrome.storage.local directly using the same schema as
 * the in-shell `secret` command:
 *   <name>           → string value
 *   <name>_DOMAINS   → comma-separated patterns
 *
 * The agent's tool execution contexts (bash WASM, sandbox iframes) have no
 * chrome.* APIs, so these values stay isolated from the agent the same way
 * `~/.slicc/secrets.env` does in CLI mode.
 *
 * No HTML templating — every dynamic value goes through textContent or
 * dataset to keep the page out of any conceivable XSS reach.
 */

const DOMAINS_SUFFIX = '_DOMAINS';

// ----------------- chrome.storage helpers -----------------

async function listSecrets() {
  const all = await chrome.storage.local.get(null);
  const entries = [];
  for (const key of Object.keys(all)) {
    if (key.endsWith(DOMAINS_SUFFIX)) continue;
    if (typeof all[key] !== 'string') continue;
    const domainsKey = key + DOMAINS_SUFFIX;
    const raw = all[domainsKey];
    if (typeof raw !== 'string') continue;
    const domains = raw
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length === 0) continue;
    entries.push({ name: key, domains });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

async function setSecret(name, value, domains) {
  await chrome.storage.local.set({
    [name]: value,
    [name + DOMAINS_SUFFIX]: domains.join(','),
  });
}

async function deleteSecret(name) {
  await chrome.storage.local.remove([name, name + DOMAINS_SUFFIX]);
}

// ----------------- DOM helpers -----------------

const $ = (id) => document.getElementById(id);

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'text') node.textContent = v;
      else if (k === 'on') {
        for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
      } else if (k.startsWith('style:')) node.style.setProperty(k.slice(6), v);
      else node.setAttribute(k, v);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function showToast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

async function renderList() {
  const container = $('list');
  container.replaceChildren();
  let entries;
  try {
    entries = await listSecrets();
  } catch (err) {
    container.appendChild(el('div', { class: 'empty', text: `Failed to read storage: ${err}` }));
    return;
  }
  if (entries.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No secrets stored. Add one below.' }));
    return;
  }
  for (const entry of entries) {
    const row = el(
      'div',
      { class: 'secret-row', dataset: { name: entry.name } },
      el(
        'div',
        { class: 'secret-meta' },
        el('div', { class: 'secret-name', text: entry.name }),
        el('div', { class: 'secret-domains', text: entry.domains.join(', ') })
      ),
      el('button', {
        class: 'btn-secondary btn',
        text: 'Copy name',
        'style:font-size': '11px',
        'style:padding': '4px 8px',
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(entry.name);
              showToast(`Copied "${entry.name}"`);
            } catch {
              showToast('Clipboard failed', true);
            }
          },
        },
      }),
      el('button', {
        class: 'btn-danger',
        text: 'Delete',
        on: {
          click: async () => {
            if (!confirm(`Delete secret "${entry.name}"?`)) return;
            try {
              await deleteSecret(entry.name);
              showToast(`Deleted ${entry.name}`);
              renderList();
            } catch (err) {
              showToast(`Failed: ${err}`, true);
            }
          },
        },
      })
    );
    container.appendChild(row);
  }
}

// ----------------- Tabs -----------------

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.pane;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document
        .querySelectorAll('.pane')
        .forEach((p) => p.classList.toggle('active', p.id === `pane-${target}`));
    });
  });
}

// ----------------- S3 profile form -----------------

const PROFILE_RE = /^[a-zA-Z0-9._-]+$/;

function deriveS3Domains(endpoint) {
  if (!endpoint) return ['*.amazonaws.com'];
  try {
    const url = new URL(endpoint);
    // Wildcard the bucket subdomain: account.r2.cloudflarestorage.com →
    // *.r2.cloudflarestorage.com.
    const parts = url.host.split('.');
    if (parts.length >= 3) {
      return [`*.${parts.slice(1).join('.')}`];
    }
    return [url.host];
  } catch {
    return ['*.amazonaws.com'];
  }
}

async function saveS3Profile() {
  const profile = $('s3-profile').value.trim();
  const accessKey = $('s3-key').value.trim();
  const secretKey = $('s3-secret').value;
  const region = $('s3-region').value.trim();
  const endpoint = $('s3-endpoint').value.trim();
  const pathStyle = $('s3-pathstyle').value;
  const domainsRaw = $('s3-domains').value.trim();

  if (!profile || !PROFILE_RE.test(profile)) {
    showToast('Profile name must be alphanumeric / dot / underscore / hyphen', true);
    return;
  }
  if (!accessKey) {
    showToast('Access Key ID is required', true);
    return;
  }
  if (!secretKey) {
    showToast('Secret Access Key is required', true);
    return;
  }

  const domains = domainsRaw
    ? domainsRaw
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean)
    : deriveS3Domains(endpoint);
  if (domains.length === 0) {
    showToast('At least one domain pattern is required', true);
    return;
  }

  try {
    await setSecret(`s3.${profile}.access_key_id`, accessKey, domains);
    await setSecret(`s3.${profile}.secret_access_key`, secretKey, domains);
    if (region) await setSecret(`s3.${profile}.region`, region, domains);
    if (endpoint) await setSecret(`s3.${profile}.endpoint`, endpoint, domains);
    if (pathStyle === 'true') {
      await setSecret(`s3.${profile}.path_style`, 'true', domains);
    } else {
      // Make sure stale path_style from a previous save doesn't linger.
      await deleteSecret(`s3.${profile}.path_style`);
    }
    showToast(`Saved profile "${profile}"`);
    clearS3Form();
    renderList();
  } catch (err) {
    showToast(`Failed: ${err instanceof Error ? err.message : err}`, true);
  }
}

function clearS3Form() {
  $('s3-profile').value = '';
  $('s3-key').value = '';
  $('s3-secret').value = '';
  $('s3-region').value = '';
  $('s3-endpoint').value = '';
  $('s3-pathstyle').value = '';
  $('s3-domains').value = '';
}

// ----------------- Custom secret form -----------------

async function saveCustomSecret() {
  const name = $('c-name').value.trim();
  const value = $('c-value').value;
  const domainsRaw = $('c-domains').value.trim();

  if (!name) {
    showToast('Name is required', true);
    return;
  }
  if (!value) {
    showToast('Value is required', true);
    return;
  }
  const domains = domainsRaw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length === 0) {
    showToast('At least one domain pattern is required', true);
    return;
  }

  try {
    await setSecret(name, value, domains);
    showToast(`Saved "${name}"`);
    clearCustomForm();
    renderList();
  } catch (err) {
    showToast(`Failed: ${err instanceof Error ? err.message : err}`, true);
  }
}

function clearCustomForm() {
  $('c-name').value = '';
  $('c-value').value = '';
  $('c-domains').value = '';
}

// ----------------- Init -----------------

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  renderList();
  $('refreshBtn').addEventListener('click', renderList);
  $('s3-save').addEventListener('click', saveS3Profile);
  $('s3-clear').addEventListener('click', clearS3Form);
  $('c-save').addEventListener('click', saveCustomSecret);
  $('c-clear').addEventListener('click', clearCustomForm);
});
