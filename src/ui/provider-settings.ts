/**
 * Provider Settings — unified configuration for all pi-ai providers.
 * Replaces the old API Key dialog with a comprehensive provider selector,
 * provider-specific options, and dynamic model population.
 */

import { getProviders, getModels, getModel, createLogger } from '../core/index.js';
import type { Model } from '../core/index.js';
import type { Api } from '@mariozechner/pi-ai';
import { getThemePreference, setThemePreference } from './theme.js';
import type { ThemePreference } from './theme.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  shouldIncludeProvider,
} from '../providers/index.js';
import type { ProviderConfig } from '../providers/index.js';

export type { ProviderConfig } from '../providers/index.js';

// Dynamic wrappers — pi-ai's getModel/getModels use strict generics
// that require KnownProvider literals, but provider-settings works
// with runtime strings from localStorage/user selection.
const getModelDynamic = getModel as (
  provider: string,
  modelId: string
) => Model<Api>;

const getModelsDynamic = getModels as (
  provider: string
) => Model<Api>[];

// Storage keys
const ACCOUNTS_KEY = 'slicc_accounts';
const MODEL_KEY = 'selected-model';

// Legacy keys — deleted on load, no migration
const LEGACY_KEYS = [
  'slicc_provider',
  'slicc_api_key',
  'slicc_base_url',
  'anthropic_api_key',
  'api_provider',
  'azure_resource',
  'bedrock_region',
] as const;

// Account entry in the slicc_accounts array
export interface Account {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  // OAuth fields (used by OAuth providers)
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
}

// Delete legacy keys on first access
let _legacyCleaned = false;
function cleanLegacyKeys(): void {
  if (_legacyCleaned) return;
  _legacyCleaned = true;
  for (const key of LEGACY_KEYS) {
    try { localStorage.removeItem(key); } catch { /* noop */ }
  }
}

function _resetLegacyCleanup(): void {
  _legacyCleaned = false;
}

/** Test-only exports */
export const __test__ = { _resetLegacyCleanup };

// Provider configs are now loaded dynamically from src/providers/index.ts
// (built-in providers in src/providers/built-in/ + external providers in /providers/)

// Get all available providers — pi-ai providers (filtered by build config) + registered configs
export function getAvailableProviders(): string[] {
  const piProviders = (getProviders() as string[]).filter(shouldIncludeProvider);
  const registeredIds = getRegisteredProviderIds(); // external + built-in extensions, already filtered
  const merged = new Set([...piProviders, ...registeredIds]);
  return [...merged];
}

// Get provider config with fallback for unknown providers
export function getProviderConfig(providerId: string): ProviderConfig {
  return getRegisteredProviderConfig(providerId) || {
    id: providerId,
    name: providerId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
    description: `${providerId} provider`,
    requiresApiKey: true,
    requiresBaseUrl: false,
  };
}

// Get models for a provider
export function getProviderModels(providerId: string): Model<Api>[] {
  try {
    // Bedrock CAMP uses Amazon Bedrock models with custom API
    if (providerId === 'bedrock-camp') {
      const bedrockModels = getModelsDynamic('amazon-bedrock');
      return bedrockModels.map(m => ({ ...m, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' }));
    }
    // Providers that use Anthropic's model registry with custom API
    const providerConfig = getProviderConfig(providerId);
    if (providerConfig.isOAuth) {
      // OAuth providers use Anthropic models with custom API routing
      const anthropicModels = getModelsDynamic('anthropic');
      const customApi = `${providerId}-anthropic` as Api;
      return anthropicModels.map(m => ({ ...m, api: customApi, provider: providerId }));
    }
    const effectiveProvider = providerId === 'azure-ai-foundry' ? 'anthropic' : providerId;
    return getModelsDynamic(effectiveProvider);
  } catch (err) {
    log.error('Failed to load models', { providerId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// --- OAuth account info (used by oauth-token shell command) ---

export function getOAuthAccountInfo(providerId: string): {
  token: string;
  expiresAt?: number;
  userName?: string;
  expired: boolean;
} | null {
  const account = getAccounts().find(a => a.providerId === providerId);
  if (!account?.accessToken) return null;
  const expired = !!account.tokenExpiresAt && Date.now() > account.tokenExpiresAt - 60000;
  return { token: account.accessToken, expiresAt: account.tokenExpiresAt, userName: account.userName, expired };
}

// --- Build-time provider defaults from providers.json ---

export interface ProviderDefault {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

// Vite resolves this at build time. Returns {} if providers.json doesn't exist.
const providerFiles = import.meta.glob('/providers.json', {
  eager: true,
  import: 'default',
}) as Record<string, ProviderDefault[]>;

const providerDefaults: ProviderDefault[] = providerFiles['/providers.json'] ?? [];

const log = createLogger('provider-settings');

/**
 * Auto-configure provider accounts from providers.json (bundled at build time).
 * Only populates if no accounts exist yet — never overwrites manual config.
 * The first entry's model becomes the selected model.
 *
 * Copy providers.example.json to providers.json and fill in your API keys.
 */
export function applyProviderDefaults(
  defaults: ProviderDefault[] = providerDefaults,
): void {
  if (defaults.length === 0 || getAccounts().length > 0) return;

  const knownProviders = new Set(getAvailableProviders());

  for (const entry of defaults) {
    if (!entry.providerId || !entry.apiKey) continue;
    if (!knownProviders.has(entry.providerId)) {
      log.warn(`Unknown provider "${entry.providerId}" in providers.json — skipping`);
      continue;
    }
    addAccount(entry.providerId, entry.apiKey, entry.baseUrl);
  }

  const first = defaults.find(
    e => e.providerId && e.apiKey && knownProviders.has(e.providerId),
  );
  if (first?.model && !localStorage.getItem(MODEL_KEY)) {
    localStorage.setItem(MODEL_KEY, `${first.providerId}:${first.model}`);
  }
}

// --- All models across configured accounts ---

export interface GroupedModels {
  providerId: string;
  providerName: string;
  models: Model<Api>[];
}

/** Get models from all configured provider accounts, grouped by provider. */
export function getAllAvailableModels(): GroupedModels[] {
  const accounts = getAccounts();
  if (accounts.length === 0) return [];
  const seen = new Map<string, GroupedModels>();
  for (const account of accounts) {
    if (seen.has(account.providerId)) continue;
    const models = getProviderModels(account.providerId);
    if (models.length === 0) continue;
    const config = getProviderConfig(account.providerId);
    const group: GroupedModels = {
      providerId: account.providerId,
      providerName: config.name,
      models,
    };
    seen.set(account.providerId, group);
  }
  return [...seen.values()];
}

// --- Account storage ---

export function getAccounts(): Account[] {
  cleanLegacyKeys();
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Account =>
        entry != null &&
        typeof entry === 'object' &&
        typeof entry.providerId === 'string' &&
        typeof entry.apiKey === 'string',
    );
  } catch {
    return [];
  }
}

function saveAccounts(accounts: Account[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function addAccount(providerId: string, apiKey: string, baseUrl?: string): void {
  const accounts = getAccounts().filter(a => a.providerId !== providerId);
  const entry: Account = { providerId, apiKey };
  if (baseUrl) entry.baseUrl = baseUrl;
  accounts.push(entry);
  saveAccounts(accounts);
}

export function removeAccount(providerId: string): void {
  saveAccounts(getAccounts().filter(a => a.providerId !== providerId));
}

/** Save an OAuth account (used by external providers after token exchange). */
export function saveOAuthAccount(opts: {
  providerId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
}): void {
  const accounts = getAccounts().filter(a => a.providerId !== opts.providerId);
  accounts.push({
    providerId: opts.providerId,
    apiKey: '', // OAuth providers don't use API keys
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    tokenExpiresAt: opts.tokenExpiresAt,
    userName: opts.userName,
  });
  saveAccounts(accounts);
}

export function getApiKeyForProvider(providerId: string): string | null {
  const account = getAccounts().find(a => a.providerId === providerId);
  if (!account) return null;
  // OAuth providers use accessToken instead of apiKey
  return account.accessToken || account.apiKey || null;
}

export function getBaseUrlForProvider(providerId: string): string | null {
  return getAccounts().find(a => a.providerId === providerId)?.baseUrl ?? null;
}

// --- Selected model (format: "providerId:modelId") ---

export function getSelectedModelId(): string {
  const raw = localStorage.getItem(MODEL_KEY) || '';
  // Strip provider prefix if present
  const idx = raw.indexOf(':');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

export function setSelectedModelId(modelId: string): void {
  // If modelId already has provider prefix, store as-is
  if (modelId.includes(':')) {
    localStorage.setItem(MODEL_KEY, modelId);
  } else {
    // Store with provider prefix from current selection
    const provider = getSelectedProvider();
    localStorage.setItem(MODEL_KEY, `${provider}:${modelId}`);
  }
}

/** Get the raw selected-model value (providerId:modelId) */
function getRawSelectedModel(): string {
  return localStorage.getItem(MODEL_KEY) || '';
}

// --- Provider derived from selected model ---

export function getSelectedProvider(): string {
  const raw = getRawSelectedModel();
  const idx = raw.indexOf(':');
  if (idx > 0) return raw.slice(0, idx);
  // No provider encoded (or empty prefix like ":gpt-5") — fall back
  const accounts = getAccounts();
  if (accounts.length > 0) return accounts[0].providerId;
  return 'anthropic';
}

export function setSelectedProvider(provider: string): void {
  const modelId = getSelectedModelId();
  localStorage.setItem(MODEL_KEY, `${provider}:${modelId}`);
}

export function clearSelectedProvider(): void {
  const modelId = getSelectedModelId();
  // Remove provider prefix, keep just model
  localStorage.setItem(MODEL_KEY, modelId);
}

// --- Backward-compatible accessors (used by scoop-context.ts, layout.ts, main.ts) ---

export function getApiKey(): string | null {
  const provider = getSelectedProvider();
  return getApiKeyForProvider(provider);
}

export function setApiKey(key: string): void {
  const provider = getSelectedProvider();
  const baseUrl = getBaseUrlForProvider(provider);
  addAccount(provider, key, baseUrl ?? undefined);
}

export function clearApiKey(): void {
  const provider = getSelectedProvider();
  removeAccount(provider);
}

export function getBaseUrl(): string | null {
  const provider = getSelectedProvider();
  return getBaseUrlForProvider(provider);
}

export function setBaseUrl(url: string): void {
  const provider = getSelectedProvider();
  const apiKey = getApiKeyForProvider(provider);
  if (apiKey) {
    addAccount(provider, apiKey, url || undefined);
  }
}

export function clearBaseUrl(): void {
  const provider = getSelectedProvider();
  const apiKey = getApiKeyForProvider(provider);
  if (apiKey) {
    addAccount(provider, apiKey);
  }
}

// --- Export accounts as providers.json ---

/** Build a ProviderDefault[] from current accounts (pure, testable). */
export function exportProviders(): ProviderDefault[] {
  const accounts = getAccounts();
  const selectedProvider = getSelectedProvider();
  const selectedModel = getSelectedModelId();

  return accounts.map((account) => {
    const entry: ProviderDefault = {
      providerId: account.providerId,
      apiKey: account.apiKey,
    };
    if (account.baseUrl) entry.baseUrl = account.baseUrl;
    if (account.providerId === selectedProvider && selectedModel) {
      entry.model = selectedModel;
    }
    return entry;
  });
}

/** Trigger a browser download of the current accounts as providers.json. */
export function downloadProviders(): void {
  const json = JSON.stringify(exportProviders(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'providers.json';
  a.click();
  URL.revokeObjectURL(url);
}

// Clear all provider settings
export function clearAllSettings(): void {
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(MODEL_KEY);
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

/**
 * Resolve a specific model by ID, using the current provider's
 * baseUrl and API routing. Falls back to resolveCurrentModel() if
 * modelId is not provided.
 */
export function resolveModelById(modelId?: string): Model<Api> {
  if (!modelId) return resolveCurrentModel();

  const providerId = getSelectedProvider();
  const baseUrl = getBaseUrlForProvider(providerId);

  try {
    const providerConfig = getProviderConfig(providerId);
    const effectiveProvider = providerConfig.isOAuth ? 'anthropic'
      : providerId === 'azure-ai-foundry' ? 'anthropic'
      : providerId === 'bedrock-camp' ? 'amazon-bedrock'
      : providerId;
    let model = getModelDynamic(effectiveProvider, modelId);

    if (providerConfig.isOAuth) {
      model = { ...model, api: `${providerId}-anthropic` as Api, provider: providerId };
    } else if (providerId === 'bedrock-camp') {
      model = { ...model, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' };
    }
    if (baseUrl) {
      model = { ...model, baseUrl };
    }
    return model;
  } catch {
    return resolveCurrentModel();
  }
}

export function resolveCurrentModel(): Model<Api> {
  const providerId = getSelectedProvider();
  const modelId = getSelectedModelId();
  const baseUrl = getBaseUrlForProvider(providerId);

  // Get default model if none selected
  const models = getProviderModels(providerId);
  const effectiveModelId = modelId || models[0]?.id || 'claude-sonnet-4-20250514';

  try {
    const providerConfig = getProviderConfig(providerId);
    const effectiveProvider = providerConfig.isOAuth ? 'anthropic'
      : providerId === 'azure-ai-foundry' ? 'anthropic'
      : providerId === 'bedrock-camp' ? 'amazon-bedrock'
      : providerId;
    let model = getModelDynamic(effectiveProvider, effectiveModelId);

    // Override api and provider for custom routing
    if (providerConfig.isOAuth) {
      model = { ...model, api: `${providerId}-anthropic` as Api, provider: providerId };
    } else if (providerId === 'bedrock-camp') {
      model = { ...model, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' };
    }

    // Override baseUrl if custom one is set
    if (baseUrl) {
      model = { ...model, baseUrl };
    }

    return model;
  } catch {
    // Fallback to anthropic
    return getModelDynamic('anthropic', 'claude-sonnet-4-20250514');
  }
}

/** Mask an API key for display: show first 4 and last 4 chars */
function maskApiKey(key: string): string {
  if (key.length <= 10) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/** Create an S2-style outline SVG icon (matches layout.ts pattern). */
function svgIcon(paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const ICON_PATHS = {
  pen: [
    'M14.3 3.3a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L7.7 14.8l-3.2.7.7-3.2z',
  ],
  trash: [
    'M4 6h12',
    'M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2',
    'M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6',
  ],
};

/**
 * Show the Accounts management dialog.
 * Returns a promise that resolves to `true` if accounts were modified,
 * `false` if the user closed without changes (so callers can skip reload).
 */
export function showProviderSettings(): Promise<boolean> {
  return new Promise((resolve) => {
    const accountsBefore = localStorage.getItem(ACCOUNTS_KEY) ?? '';

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.cssText = 'max-width: 480px; width: 90vw; padding: 32px;';

    // Decide initial view: list if accounts exist, add-form if empty
    if (getAccounts().length > 0) {
      renderAccountsList();
    } else {
      renderAccountForm();
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // ── Accounts list view ──────────────────────────────────────────
    function renderAccountsList() {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Accounts';
      dialog.appendChild(title);

      const currentAccounts = getAccounts();

      const iconBtnStyle =
          'background: transparent; border: 1px solid var(--s2-border-subtle); ' +
          'color: var(--s2-content-secondary); border-radius: var(--s2-radius-s); ' +
          'padding: 6px; cursor: pointer; display: flex; align-items: center; ' +
          'justify-content: center; transition: color 0.15s, border-color 0.15s;';

      if (currentAccounts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dialog__desc';
        empty.textContent = 'No accounts configured.';
        dialog.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.style.cssText = 'margin-bottom: 16px;';

        for (const account of currentAccounts) {
          const config = getProviderConfig(account.providerId);
          const row = document.createElement('div');
          row.style.cssText =
            'display: flex; align-items: center; justify-content: space-between; ' +
            'padding: 10px 12px; background: var(--s2-bg-layer-2); border-radius: var(--s2-radius-default); ' +
            'margin-bottom: 8px; border: 1px solid var(--s2-border-subtle);';

          const info = document.createElement('div');
          info.style.cssText = 'flex: 1; min-width: 0;';

          const name = document.createElement('div');
          name.style.cssText = 'font-size: 14px; font-weight: 600; color: var(--s2-content-default);';
          name.textContent = config.name;
          info.appendChild(name);

          const detail = document.createElement('div');
          detail.style.cssText = 'font-size: 11px; color: var(--s2-content-disabled); font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          if (account.userName) {
            detail.textContent = account.userName;
          } else if (account.accessToken) {
            detail.textContent = 'Logged in';
          } else {
            detail.textContent = maskApiKey(account.apiKey);
          }
          if (account.baseUrl) {
            detail.textContent += ' \u2022 ' + account.baseUrl;
          }
          info.appendChild(detail);

          row.appendChild(info);

          const actions = document.createElement('div');
          actions.style.cssText =
            'display: flex; gap: 4px; margin-left: 12px; flex-shrink: 0;';

          const editBtn = document.createElement('button');
          editBtn.style.cssText = iconBtnStyle;
          editBtn.setAttribute('aria-label', 'Edit account');
          editBtn.appendChild(svgIcon(ICON_PATHS.pen));
          editBtn.addEventListener('mouseenter', () => {
            editBtn.style.color = 'var(--s2-accent)';
            editBtn.style.borderColor = 'var(--s2-accent)';
          });
          editBtn.addEventListener('mouseleave', () => {
            editBtn.style.color = 'var(--s2-content-secondary)';
            editBtn.style.borderColor = 'var(--s2-border-subtle)';
          });
          editBtn.addEventListener('click', () => {
            renderAccountForm(account);
          });
          actions.appendChild(editBtn);

          const deleteBtn = document.createElement('button');
          deleteBtn.style.cssText = iconBtnStyle;
          deleteBtn.setAttribute('aria-label', 'Remove account');
          deleteBtn.appendChild(svgIcon(ICON_PATHS.trash));
          deleteBtn.addEventListener('mouseenter', () => {
            deleteBtn.style.color = 'var(--s2-negative)';
            deleteBtn.style.borderColor = 'var(--s2-negative)';
          });
          deleteBtn.addEventListener('mouseleave', () => {
            deleteBtn.style.color = 'var(--s2-content-secondary)';
            deleteBtn.style.borderColor = 'var(--s2-border-subtle)';
          });
          deleteBtn.addEventListener('click', () => {
            removeAccount(account.providerId);
            renderAccountsList();
          });
          actions.appendChild(deleteBtn);

          row.appendChild(actions);

          list.appendChild(row);
        }
        dialog.appendChild(list);
      }

      // Action buttons row
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display: flex; gap: 8px;';

      const addBtn = document.createElement('button');
      addBtn.className = 'dialog__btn';
      addBtn.style.flex = '1';
      addBtn.textContent = 'Add Account';
      addBtn.addEventListener('click', () => renderAccountForm());
      btnRow.appendChild(addBtn);

      const exportBtn = document.createElement('button');
      exportBtn.className = 'dialog__btn dialog__btn--secondary';
      exportBtn.style.flex = '1';
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', () => downloadProviders());
      btnRow.appendChild(exportBtn);

      dialog.appendChild(btnRow);

      // ── Theme section ───────────────────────────────────────────
      const themeSep = document.createElement('hr');
      themeSep.style.cssText =
        'border: none; border-top: 1px solid var(--s2-border-subtle); margin: 16px 0;';
      dialog.appendChild(themeSep);

      const themeLabel = document.createElement('div');
      themeLabel.className = 'dialog__desc';
      themeLabel.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
      themeLabel.textContent = 'Theme';
      dialog.appendChild(themeLabel);

      const themeGroup = document.createElement('div');
      themeGroup.setAttribute('role', 'radiogroup');
      themeGroup.setAttribute('aria-label', 'Theme');
      themeGroup.style.cssText =
        'display: flex; gap: 0; margin-bottom: 16px; ' +
        'border-radius: var(--s2-radius-default); overflow: hidden; ' +
        'border: 1px solid var(--s2-border-subtle);';

      const themeOptions: [ThemePreference, string][] = [
        ['system', 'System'],
        ['light', 'Light'],
        ['dark', 'Dark'],
      ];
      const themeBtns: HTMLButtonElement[] = [];

      for (const [value, label] of themeOptions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', String(value === getThemePreference()));
        btn.textContent = label;
        btn.dataset.theme = value;
        btn.style.cssText =
          'flex: 1; padding: 8px 0; border: none; ' +
          'font-size: 13px; font-weight: 600; cursor: pointer; ' +
          'transition: background var(--s2-transition-default), ' +
          'color var(--s2-transition-default);';
        themeBtns.push(btn);
        themeGroup.appendChild(btn);
      }

      function styleThemeBtns() {
        const cs = getComputedStyle(document.documentElement);
        for (const btn of themeBtns) {
          const active = btn.dataset.theme === getThemePreference();
          btn.setAttribute('aria-checked', String(active));
          btn.style.background = active
            ? cs.getPropertyValue('--s2-accent').trim()
            : cs.getPropertyValue('--s2-bg-layer-2').trim();
          btn.style.color = active
            ? '#fff'
            : cs.getPropertyValue('--s2-content-secondary').trim();
        }
      }
      styleThemeBtns();

      for (const btn of themeBtns) {
        btn.addEventListener('click', () => {
          setThemePreference(btn.dataset.theme as ThemePreference);
          styleThemeBtns();
        });
      }

      dialog.appendChild(themeGroup);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog__btn dialog__btn--secondary';
      closeBtn.style.marginTop = '8px';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => {
        overlay.remove();
        resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
      });
      dialog.appendChild(closeBtn);
    }

    // ── Account form view (add or edit) ─────────────────────────────
    function renderAccountForm(editing?: Account) {
      dialog.innerHTML = '';
      const isEdit = !!editing;

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = isEdit ? 'Edit Account' : 'Add Account';
      dialog.appendChild(title);

      // Provider selector
      const providerLabel = document.createElement('div');
      providerLabel.className = 'dialog__desc';
      providerLabel.textContent = 'Provider:';
      dialog.appendChild(providerLabel);

      const providerSelect = document.createElement('select');
      providerSelect.className = 'dialog__input';
      providerSelect.style.marginBottom = '8px';

      if (isEdit) {
        // Locked to the existing provider
        const config = getProviderConfig(editing.providerId);
        const opt = document.createElement('option');
        opt.value = editing.providerId;
        opt.textContent = config.name;
        providerSelect.appendChild(opt);
        providerSelect.disabled = true;
        providerSelect.style.opacity = '0.7';
      } else {
        const providers = getAvailableProviders();
        const existingProviders = new Set(getAccounts().map(a => a.providerId));
        const sorted = [...providers].sort((a, b) => {
          const nameA = getProviderConfig(a).name;
          const nameB = getProviderConfig(b).name;
          return nameA.localeCompare(nameB);
        });
        for (const providerId of sorted) {
          if (existingProviders.has(providerId)) continue;
          const config = getProviderConfig(providerId);
          const opt = document.createElement('option');
          opt.value = providerId;
          opt.textContent = config.name;
          providerSelect.appendChild(opt);
        }
      }
      dialog.appendChild(providerSelect);

      // Provider description
      const providerDesc = document.createElement('div');
      providerDesc.className = 'dialog__desc';
      providerDesc.style.cssText = 'font-size: 12px; color: var(--s2-content-tertiary); margin-bottom: 16px; margin-top: -4px;';
      dialog.appendChild(providerDesc);

      // OAuth login section (shown for isOAuth providers)
      const oauthSection = document.createElement('div');
      oauthSection.style.cssText = 'margin-bottom: 16px; display: none;';

      const oauthLoginBtn = document.createElement('button');
      oauthLoginBtn.className = 'dialog__btn';
      oauthLoginBtn.textContent = 'Login';
      oauthLoginBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
      oauthSection.appendChild(oauthLoginBtn);

      const oauthStatus = document.createElement('div');
      oauthStatus.className = 'dialog__desc';
      oauthStatus.style.cssText = 'font-size: 12px; color: var(--s2-content-secondary); text-align: center;';
      oauthSection.appendChild(oauthStatus);

      // OAuth login handler — calls the provider's onOAuthLogin callback with a generic launcher
      oauthLoginBtn.addEventListener('click', async () => {
        const pid = providerSelect.value;
        if (!pid) return;
        const providerConfig = getProviderConfig(pid);
        if (!providerConfig.onOAuthLogin) return;
        oauthStatus.textContent = 'Opening login window...';
        try {
          const { createOAuthLauncher } = await import('../providers/oauth-service.js');
          const launcher = createOAuthLauncher();
          await providerConfig.onOAuthLogin(launcher, renderAccountsList);
        } catch (err) {
          log.error('OAuth login failed', { providerId: pid, error: err instanceof Error ? err.message : String(err) });
          oauthStatus.textContent = `Login failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      });

      // Show logged-in user if editing an OAuth account
      if (isEdit && editing.userName) {
        oauthStatus.textContent = `Logged in as ${editing.userName}`;
        oauthLoginBtn.textContent = 'Re-login';
      }

      dialog.appendChild(oauthSection);

      // API Key section
      const apiKeySection = document.createElement('div');

      const apiKeyLabel = document.createElement('div');
      apiKeyLabel.className = 'dialog__desc';
      apiKeySection.appendChild(apiKeyLabel);

      const apiKeyInput = document.createElement('input');
      apiKeyInput.className = 'dialog__input';
      apiKeyInput.type = 'password';
      apiKeyInput.autocomplete = 'off';
      apiKeyInput.spellcheck = false;
      if (isEdit) apiKeyInput.value = editing.apiKey;
      apiKeySection.appendChild(apiKeyInput);

      dialog.appendChild(apiKeySection);

      // Base URL section
      const baseUrlSection = document.createElement('div');

      const baseUrlLabel = document.createElement('div');
      baseUrlLabel.className = 'dialog__desc';
      baseUrlLabel.textContent = 'Base URL:';
      baseUrlSection.appendChild(baseUrlLabel);

      const baseUrlInput = document.createElement('input');
      baseUrlInput.className = 'dialog__input';
      baseUrlInput.type = 'text';
      baseUrlInput.autocomplete = 'off';
      baseUrlInput.spellcheck = false;
      if (isEdit && editing.baseUrl) baseUrlInput.value = editing.baseUrl;
      baseUrlSection.appendChild(baseUrlInput);

      const baseUrlDesc = document.createElement('div');
      baseUrlDesc.className = 'dialog__desc';
      baseUrlDesc.style.cssText = 'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      baseUrlSection.appendChild(baseUrlDesc);

      dialog.appendChild(baseUrlSection);

      // Error message area
      const errorEl = document.createElement('div');
      errorEl.style.cssText = 'color: var(--slicc-cone); font-size: 12px; margin-bottom: 8px; display: none;';
      dialog.appendChild(errorEl);

      // Save button (created before updateFormFields so it can be toggled)
      const saveBtn = document.createElement('button');
      saveBtn.className = 'dialog__btn';
      saveBtn.textContent = isEdit ? 'Save' : 'Add';

      function updateFormFields() {
        const pid = providerSelect.value;
        if (!pid) return;
        const providerConfig = getProviderConfig(pid);

        providerDesc.textContent = providerConfig.description;

        // OAuth providers show login button instead of API key input
        if (providerConfig.isOAuth) {
          oauthSection.style.display = '';
          apiKeySection.style.display = 'none';
          baseUrlSection.style.display = 'none';
          oauthLoginBtn.textContent = `Login with ${providerConfig.name}`;
          saveBtn.style.display = 'none';
        } else {
          oauthSection.style.display = 'none';
          apiKeyLabel.textContent = `API Key${providerConfig.apiKeyEnvVar ? ` (${providerConfig.apiKeyEnvVar})` : ''}:`;
          apiKeyInput.placeholder = providerConfig.apiKeyPlaceholder || 'API key';
          apiKeySection.style.display = providerConfig.requiresApiKey ? '' : 'none';
          baseUrlInput.placeholder = providerConfig.baseUrlPlaceholder || 'https://...';
          baseUrlDesc.textContent = providerConfig.baseUrlDescription || '';
          baseUrlSection.style.display = providerConfig.requiresBaseUrl ? '' : 'none';
          saveBtn.style.display = '';
        }
      }

      providerSelect.addEventListener('change', () => {
        errorEl.style.display = 'none';
        updateFormFields();
      });
      updateFormFields();

      function validateAndSave() {
        const pid = providerSelect.value;
        if (!pid) return;
        const config = getProviderConfig(pid);

        if (config.requiresApiKey && apiKeyInput.value.trim().length < 5) {
          errorEl.textContent = 'API key is required (at least 5 characters).';
          errorEl.style.display = '';
          apiKeyInput.focus();
          return;
        }

        if (config.requiresBaseUrl && !baseUrlInput.value.trim()) {
          errorEl.textContent = 'Base URL is required for this provider.';
          errorEl.style.display = '';
          baseUrlInput.focus();
          return;
        }

        addAccount(
          pid,
          apiKeyInput.value.trim(),
          baseUrlInput.value.trim() || undefined,
        );

        renderAccountsList();
      }

      saveBtn.addEventListener('click', validateAndSave);

      const handleEnter = (e: KeyboardEvent) => {
        if (e.key === 'Enter') validateAndSave();
      };
      apiKeyInput.addEventListener('keydown', handleEnter);
      baseUrlInput.addEventListener('keydown', handleEnter);

      dialog.appendChild(saveBtn);

      // Back button (only shown when accounts already exist)
      const hasAccounts = getAccounts().length > 0;
      if (hasAccounts) {
        const backBtn = document.createElement('button');
        backBtn.className = 'dialog__btn dialog__btn--secondary';
        backBtn.style.marginTop = '8px';
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', () => {
          renderAccountsList();
        });
        dialog.appendChild(backBtn);
      }

      requestAnimationFrame(() => {
        const pid = providerSelect.value;
        if (!pid) return;
        const config = getProviderConfig(pid);
        if (config.requiresApiKey) {
          apiKeyInput.focus();
        } else if (config.requiresBaseUrl) {
          baseUrlInput.focus();
        }
      });
    }
  });
}
