/**
 * Provider Settings — unified configuration for all pi-ai providers.
 * Replaces the old API Key dialog with a comprehensive provider selector,
 * provider-specific options, and dynamic model population.
 */

import { getProviders, getModels, getModel } from '../core/index.js';
import type { Model } from '../core/index.js';
import type { Api } from '@mariozechner/pi-ai';

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

// Provider metadata with display names and required fields
interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  requiresBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  baseUrlDescription?: string;
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  'anthropic': {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models via Anthropic API',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    requiresBaseUrl: false,
  },
  'openai': {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT and Codex models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    requiresBaseUrl: false,
  },
  'openrouter': {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '200+ models from multiple providers',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    requiresBaseUrl: false,
  },
  'groq': {
    id: 'groq',
    name: 'Groq',
    description: 'Fast inference for open models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'gsk_...',
    apiKeyEnvVar: 'GROQ_API_KEY',
    requiresBaseUrl: false,
  },
  'google': {
    id: 'google',
    name: 'Google AI',
    description: 'Gemini models via Google AI Studio',
    requiresApiKey: true,
    apiKeyPlaceholder: 'AI...',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    requiresBaseUrl: false,
  },
  'google-vertex': {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    description: 'Gemini and Claude on Vertex',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Access token',
    apiKeyEnvVar: 'GOOGLE_APPLICATION_CREDENTIALS',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://us-central1-aiplatform.googleapis.com',
    baseUrlDescription: 'Vertex AI endpoint URL',
  },
  'amazon-bedrock': {
    id: 'amazon-bedrock',
    name: 'AWS Bedrock',
    description: 'Claude, Llama, and more on AWS',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Session token or credentials',
    apiKeyEnvVar: 'AWS_SESSION_TOKEN',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    baseUrlDescription: 'Bedrock runtime endpoint (region-specific)',
  },
  'bedrock-camp': {
    id: 'bedrock-camp',
    name: 'AWS Bedrock (CAMP)',
    description: 'Claude on AWS Bedrock via Adobe CAMP Bearer token',
    requiresApiKey: true,
    apiKeyPlaceholder: 'ABSK...',
    apiKeyEnvVar: 'BEDROCK_CAMP_API_KEY',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://bedrock-runtime.us-west-2.amazonaws.com',
    baseUrlDescription: 'Bedrock runtime endpoint from CAMP portal',
  },
  'azure-ai-foundry': {
    id: 'azure-ai-foundry',
    name: 'Azure (Claude)',
    description: 'Claude models via Azure AI Foundry',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Azure API key',
    apiKeyEnvVar: 'AZURE_API_KEY',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://your-resource.services.ai.azure.com/anthropic',
    baseUrlDescription: 'Azure AI Foundry endpoint — must end with /anthropic',
  },
  'azure-openai-responses': {
    id: 'azure-openai-responses',
    name: 'Azure (OpenAI/GPT)',
    description: 'GPT and Codex models on Azure OpenAI',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Azure API key',
    apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://your-resource.openai.azure.com',
    baseUrlDescription: 'Azure OpenAI endpoint URL',
  },
  'mistral': {
    id: 'mistral',
    name: 'Mistral',
    description: 'Mistral AI models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Mistral API key',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    requiresBaseUrl: false,
  },
  'xai': {
    id: 'xai',
    name: 'xAI',
    description: 'Grok models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'xAI API key',
    apiKeyEnvVar: 'XAI_API_KEY',
    requiresBaseUrl: false,
  },
  'cerebras': {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Fast inference on Cerebras hardware',
    requiresApiKey: true,
    apiKeyPlaceholder: 'Cerebras API key',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    requiresBaseUrl: false,
  },
  'huggingface': {
    id: 'huggingface',
    name: 'HuggingFace',
    description: 'Inference API models',
    requiresApiKey: true,
    apiKeyPlaceholder: 'hf_...',
    apiKeyEnvVar: 'HF_TOKEN',
    requiresBaseUrl: false,
  },
};

// Get all available providers — pi-ai providers + custom providers (e.g., azure-ai-foundry)
export function getAvailableProviders(): string[] {
  const piProviders = getProviders();
  const customProviders = Object.keys(PROVIDER_CONFIGS).filter(id => !(piProviders as string[]).includes(id));
  return [...piProviders, ...customProviders];
}

// Get provider config with fallback for unknown providers
export function getProviderConfig(providerId: string): ProviderConfig {
  return PROVIDER_CONFIGS[providerId] || {
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
    // Azure AI Foundry uses Anthropic's Claude models
    // Bedrock CAMP uses Amazon Bedrock models with custom API
    if (providerId === 'bedrock-camp') {
      const bedrockModels = getModelsDynamic('amazon-bedrock');
      return bedrockModels.map(m => ({ ...m, api: 'bedrock-camp-converse' as any, provider: 'bedrock-camp' }));
    }
    const effectiveProvider = providerId === 'azure-ai-foundry' ? 'anthropic' : providerId;
    return getModelsDynamic(effectiveProvider);
  } catch {
    return [];
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

export function getApiKeyForProvider(providerId: string): string | null {
  return getAccounts().find(a => a.providerId === providerId)?.apiKey ?? null;
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

// Clear all provider settings
export function clearAllSettings(): void {
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(MODEL_KEY);
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

// Resolve the current model with provider-specific baseUrl override
export function resolveCurrentModel(): Model<Api> {
  const providerId = getSelectedProvider();
  const modelId = getSelectedModelId();
  const baseUrl = getBaseUrlForProvider(providerId);

  // Get default model if none selected
  const models = getProviderModels(providerId);
  const effectiveModelId = modelId || models[0]?.id || 'claude-sonnet-4-20250514';

  try {
    // Azure AI Foundry uses Anthropic's model registry
    // Bedrock CAMP uses Amazon Bedrock's model registry with custom API
    const effectiveProvider = providerId === 'azure-ai-foundry' ? 'anthropic'
      : providerId === 'bedrock-camp' ? 'amazon-bedrock'
      : providerId;
    let model = getModelDynamic(effectiveProvider, effectiveModelId);

    // Bedrock CAMP: override api and provider to route through custom stream function
    if (providerId === 'bedrock-camp') {
      model = { ...model, api: 'bedrock-camp-converse' as any, provider: 'bedrock-camp' };
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

/**
 * Show the Accounts management dialog.
 * Returns a promise that resolves when the user closes the dialog.
 */
export function showProviderSettings(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.cssText = 'max-width: 480px; width: 90vw;';

    // Decide initial view: list if accounts exist, add-form if empty
    if (getAccounts().length > 0) {
      renderAccountsList();
    } else {
      renderAddAccountForm();
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
            'padding: 10px 12px; background: #1a1a2e; border-radius: 6px; ' +
            'margin-bottom: 8px; border: 1px solid #3a3a5a;';

          const info = document.createElement('div');
          info.style.cssText = 'flex: 1; min-width: 0;';

          const name = document.createElement('div');
          name.style.cssText = 'font-size: 14px; font-weight: 600; color: #e0e0e0;';
          name.textContent = config.name;
          info.appendChild(name);

          const detail = document.createElement('div');
          detail.style.cssText = 'font-size: 11px; color: #888; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          detail.textContent = maskApiKey(account.apiKey);
          if (account.baseUrl) {
            detail.textContent += ' \u2022 ' + account.baseUrl;
          }
          info.appendChild(detail);

          row.appendChild(info);

          const deleteBtn = document.createElement('button');
          deleteBtn.style.cssText =
            'background: transparent; border: 1px solid #633; color: #e94560; ' +
            'border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; ' +
            'margin-left: 12px; flex-shrink: 0;';
          deleteBtn.textContent = 'Remove';
          deleteBtn.addEventListener('click', () => {
            removeAccount(account.providerId);
            renderAccountsList();
          });
          row.appendChild(deleteBtn);

          list.appendChild(row);
        }
        dialog.appendChild(list);
      }

      // Add Account button
      const addBtn = document.createElement('button');
      addBtn.className = 'dialog__btn';
      addBtn.textContent = 'Add Account';
      addBtn.addEventListener('click', () => renderAddAccountForm());
      dialog.appendChild(addBtn);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog__btn';
      closeBtn.style.cssText = 'margin-top: 8px; background: transparent; border: 1px solid #444;';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', () => {
        overlay.remove();
        resolve();
      });
      dialog.appendChild(closeBtn);
    }

    // ── Add account form view ───────────────────────────────────────
    function renderAddAccountForm() {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Add Account';
      dialog.appendChild(title);

      // Provider selector
      const providerLabel = document.createElement('div');
      providerLabel.className = 'dialog__desc';
      providerLabel.textContent = 'Provider:';
      dialog.appendChild(providerLabel);

      const providerSelect = document.createElement('select');
      providerSelect.className = 'dialog__input';
      providerSelect.style.marginBottom = '8px';

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
      dialog.appendChild(providerSelect);

      // Provider description
      const providerDesc = document.createElement('div');
      providerDesc.className = 'dialog__desc';
      providerDesc.style.cssText = 'font-size: 12px; color: #888; margin-bottom: 16px; margin-top: -4px;';
      dialog.appendChild(providerDesc);

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
      baseUrlSection.appendChild(baseUrlInput);

      const baseUrlDesc = document.createElement('div');
      baseUrlDesc.className = 'dialog__desc';
      baseUrlDesc.style.cssText = 'font-size: 11px; color: #666; margin-top: -12px; margin-bottom: 16px;';
      baseUrlSection.appendChild(baseUrlDesc);

      dialog.appendChild(baseUrlSection);

      // Error message area
      const errorEl = document.createElement('div');
      errorEl.style.cssText = 'color: #e94560; font-size: 12px; margin-bottom: 8px; display: none;';
      dialog.appendChild(errorEl);

      function updateFormFields() {
        const pid = providerSelect.value;
        if (!pid) return;
        const config = getProviderConfig(pid);

        providerDesc.textContent = config.description;

        apiKeyLabel.textContent = `API Key${config.apiKeyEnvVar ? ` (${config.apiKeyEnvVar})` : ''}:`;
        apiKeyInput.placeholder = config.apiKeyPlaceholder || 'API key';
        apiKeySection.style.display = config.requiresApiKey ? '' : 'none';

        baseUrlInput.placeholder = config.baseUrlPlaceholder || 'https://...';
        baseUrlDesc.textContent = config.baseUrlDescription || '';
        baseUrlSection.style.display = config.requiresBaseUrl ? '' : 'none';
      }

      providerSelect.addEventListener('change', () => {
        errorEl.style.display = 'none';
        updateFormFields();
      });
      updateFormFields();

      // Add button
      const saveBtn = document.createElement('button');
      saveBtn.className = 'dialog__btn';
      saveBtn.textContent = 'Add';

      function validateAndAdd() {
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
          config.requiresBaseUrl ? baseUrlInput.value.trim() : undefined,
        );

        renderAccountsList();
      }

      saveBtn.addEventListener('click', validateAndAdd);

      const handleEnter = (e: KeyboardEvent) => {
        if (e.key === 'Enter') validateAndAdd();
      };
      apiKeyInput.addEventListener('keydown', handleEnter);
      baseUrlInput.addEventListener('keydown', handleEnter);

      dialog.appendChild(saveBtn);

      // Back button (only shown when accounts already exist)
      const hasAccounts = getAccounts().length > 0;
      if (hasAccounts) {
        const backBtn = document.createElement('button');
        backBtn.className = 'dialog__btn';
        backBtn.style.cssText = 'margin-top: 8px; background: transparent; border: 1px solid #444;';
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
