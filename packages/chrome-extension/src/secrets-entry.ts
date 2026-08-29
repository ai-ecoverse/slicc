/**
 * DOM entry point for the Mount Secrets options page (`secrets.html`).
 *
 * Wires the pure logic in `./secrets-storage.ts` to the DOM. Bundled
 * into `dist/extension/secrets.js` via esbuild (see vite.config.ts).
 *
 * No `innerHTML` on dynamic data — every value flows through
 * `textContent` or `dataset` to keep the page out of any conceivable
 * XSS reach.
 */

import {
  addOAuthExtraDomain,
  clearOAuthExtras,
  readOAuthExtras,
  removeOAuthExtraDomain,
} from '@slicc/shared-ts';
import {
  deleteSecret,
  listSecrets,
  type SecretEntry,
  type StorageArea,
  saveCustomSecret,
  saveS3Profile,
} from './secrets-storage.js';

declare const chrome: {
  storage: { local: StorageArea };
  runtime: { getURL?: (path: string) => string };
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

interface ElProps {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
  on?: Record<string, EventListener>;
  [key: `style:${string}`]: string;
}

function applyElProps(node: HTMLElement, props: ElProps): void {
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v as string;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'text') node.textContent = v as string;
    else if (k === 'on') {
      for (const [evt, fn] of Object.entries(v as Record<string, EventListener>)) {
        node.addEventListener(evt, fn);
      }
    } else if (k.startsWith('style:')) {
      node.style.setProperty(k.slice(6), v as string);
    } else {
      node.setAttribute(k, v as string);
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) applyElProps(node, props);
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function showToast(msg: string, isError = false): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

/** Outer rejection handler for fire-and-forget async UI work. */
function reportAsyncError(err: unknown): void {
  showToast(`Failed: ${err}`, true);
}

function refreshList(): void {
  renderList().catch(reportAsyncError);
}

const storage: StorageArea = chrome.storage.local;

function createCopyNameButton(entry: SecretEntry): HTMLButtonElement {
  return el('button', {
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
  });
}

function createDeleteSecretButton(entry: SecretEntry): HTMLButtonElement {
  return el('button', {
    class: 'btn-danger',
    text: 'Delete',
    on: {
      click: async () => {
        if (!confirm(`Delete secret "${entry.name}"?`)) return;
        try {
          await deleteSecret(storage, entry.name);
          showToast(`Deleted ${entry.name}`);
          refreshList();
        } catch (err) {
          showToast(`Failed: ${err}`, true);
        }
      },
    },
  });
}

function createSecretRow(entry: SecretEntry): HTMLDivElement {
  return el(
    'div',
    { class: 'secret-row', dataset: { name: entry.name } },
    el(
      'div',
      { class: 'secret-meta' },
      el('div', { class: 'secret-name', text: entry.name }),
      el('div', { class: 'secret-domains', text: entry.domains.join(', ') })
    ),
    createCopyNameButton(entry),
    createDeleteSecretButton(entry)
  );
}

async function renderList(): Promise<void> {
  const container = $('list');
  container.replaceChildren();
  let entries: SecretEntry[];
  try {
    entries = await listSecrets(storage);
  } catch (err) {
    container.appendChild(el('div', { class: 'empty', text: `Failed to read storage: ${err}` }));
    return;
  }
  if (entries.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No secrets stored. Add one below.' }));
    return;
  }
  for (const entry of entries) {
    container.appendChild(createSecretRow(entry));
  }
}

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.pane;
      document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
        t.classList.toggle('active', t === tab);
      });
      document.querySelectorAll<HTMLDivElement>('.pane').forEach((p) => {
        p.classList.toggle('active', p.id === `pane-${target}`);
      });
    });
  });
}

function parseCommaDomains(raw: string): string[] | undefined {
  const domains = raw
    .trim()
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains : undefined;
}

async function onSaveS3(): Promise<void> {
  const result = await saveS3Profile(storage, {
    profile: ($('s3-profile') as HTMLInputElement).value.trim(),
    accessKey: ($('s3-key') as HTMLInputElement).value.trim(),
    secretKey: ($('s3-secret') as HTMLInputElement).value,
    region: ($('s3-region') as HTMLInputElement).value.trim() || undefined,
    endpoint: ($('s3-endpoint') as HTMLInputElement).value.trim() || undefined,
    pathStyle: ($('s3-pathstyle') as HTMLSelectElement).value === 'true',
    domains: parseCommaDomains(($('s3-domains') as HTMLInputElement).value),
  });
  if (!result.ok) {
    showToast(result.error ?? 'Failed', true);
    return;
  }
  const profileName = ($('s3-profile') as HTMLInputElement).value.trim();
  showToast(`Saved profile "${profileName}"`);
  clearS3Form();
  refreshList();
}

function clearS3Form(): void {
  ['s3-profile', 's3-key', 's3-secret', 's3-region', 's3-endpoint', 's3-domains'].forEach((id) => {
    ($(id) as HTMLInputElement).value = '';
  });
  ($('s3-pathstyle') as HTMLSelectElement).value = '';
}

async function onSaveCustom(): Promise<void> {
  const result = await saveCustomSecret(storage, {
    name: ($('c-name') as HTMLInputElement).value.trim(),
    value: ($('c-value') as HTMLInputElement).value,
    domains: parseCommaDomains(($('c-domains') as HTMLInputElement).value) ?? [],
  });
  if (!result.ok) {
    showToast(result.error ?? 'Failed', true);
    return;
  }
  const name = ($('c-name') as HTMLInputElement).value.trim();
  showToast(`Saved "${name}"`);
  clearCustomForm();
  refreshList();
}

function clearCustomForm(): void {
  ['c-name', 'c-value', 'c-domains'].forEach((id) => {
    ($(id) as HTMLInputElement).value = '';
  });
}

function createOAuthClearButton(providerId: string): HTMLButtonElement {
  return el('button', {
    class: 'btn-danger',
    text: 'Clear',
    on: {
      click: () => {
        if (!confirm(`Clear all extras for "${providerId}"?`)) return;
        clearOAuthExtras(localStorage, providerId);
        showToast(`Cleared extras for ${providerId}`);
        renderOAuthExtras();
      },
    },
  });
}

function createOAuthDomainRemoveButton(providerId: string, domain: string): HTMLButtonElement {
  return el('button', {
    class: 'btn-secondary btn',
    text: 'Remove',
    'style:font-size': '11px',
    'style:padding': '4px 8px',
    on: {
      click: () => {
        const r = removeOAuthExtraDomain(localStorage, providerId, domain);
        if (r.removed) showToast(`Removed ${domain} from ${providerId}`);
        renderOAuthExtras();
      },
    },
  });
}

function appendOAuthProviderSection(
  container: HTMLElement,
  providerId: string,
  domains: string[]
): void {
  container.appendChild(
    el(
      'div',
      { class: 'secret-row', dataset: { provider: providerId } },
      el(
        'div',
        { class: 'secret-meta' },
        el('div', { class: 'secret-name', text: providerId }),
        el('div', { class: 'secret-domains', text: domains.join(', ') })
      ),
      createOAuthClearButton(providerId)
    )
  );
  for (const domain of domains) {
    container.appendChild(
      el(
        'div',
        { class: 'secret-row', 'style:padding-left': '24px' },
        el('div', { class: 'secret-meta' }, el('div', { class: 'secret-domains', text: domain })),
        createOAuthDomainRemoveButton(providerId, domain)
      )
    );
  }
}

function renderOAuthExtras(): void {
  const container = $('od-list');
  container.replaceChildren();
  const store = readOAuthExtras(localStorage);
  const providers = Object.keys(store).sort();
  if (providers.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No extras configured.' }));
    return;
  }
  for (const providerId of providers) {
    const domains = store[providerId] ?? [];
    if (domains.length === 0) continue;
    appendOAuthProviderSection(container, providerId, domains);
  }
}

function onAddOAuthExtra(): void {
  const provider = ($('od-provider') as HTMLInputElement).value.trim();
  const domain = ($('od-domain') as HTMLInputElement).value.trim();
  if (!provider) {
    showToast('Provider is required', true);
    return;
  }
  if (!domain) {
    showToast('Domain is required', true);
    return;
  }
  const r = addOAuthExtraDomain(localStorage, provider, domain);
  if (!r.added) {
    showToast(
      r.reason === 'duplicate' ? `Already in ${provider} extras` : (r.reason ?? 'Failed'),
      true
    );
    return;
  }
  showToast(`Added ${domain} to ${provider}`);
  ($('od-domain') as HTMLInputElement).value = '';
  renderOAuthExtras();
}

document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  refreshList();
  renderOAuthExtras();
  $('refreshBtn').addEventListener('click', () => {
    refreshList();
    renderOAuthExtras();
  });
  $('s3-save').addEventListener('click', () => {
    onSaveS3().catch(reportAsyncError);
  });
  $('s3-clear').addEventListener('click', clearS3Form);
  $('c-save').addEventListener('click', () => {
    onSaveCustom().catch(reportAsyncError);
  });
  $('c-clear').addEventListener('click', clearCustomForm);
  $('od-add').addEventListener('click', onAddOAuthExtra);
});
