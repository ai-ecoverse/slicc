/**
 * Provider Settings — unified configuration for all pi-ai providers.
 * Replaces the old API Key dialog with a comprehensive provider selector,
 * provider-specific options, and dynamic model population.
 */

import { getProviders, getModels, getModel, createLogger } from '../core/index.js';
import type { Model } from '../core/index.js';
import type { Api } from '@earendil-works/pi-ai';
import { storeTrayJoinUrl, hasStoredTrayJoinUrl } from '../scoops/tray-runtime-config.js';
import { describeInvalidJoinUrl } from './tray-join-url.js';

export { describeInvalidJoinUrl };
import { getFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import type { RefreshTrayRuntimeMsg } from '../../../chrome-extension/src/messages.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  shouldIncludeProvider,
} from '../providers/index.js';
import type { ProviderConfig } from '../providers/index.js';
import type { CompatOverrides } from '../providers/types.js';
import {
  isBedrockCampCompatible,
  getBedrockCampExtraModels,
  bedrockCampRegionFromBaseUrl,
} from '../providers/built-in/bedrock-camp.js';
import { trackSettingsOpen } from './telemetry.js';

export type { ProviderConfig } from '../providers/index.js';

// Dynamic wrappers — pi-ai's getModel/getModels use strict generics
// that require KnownProvider literals, but provider-settings works
// with runtime strings from localStorage/user selection.
const getModelDynamic = getModel as (provider: string, modelId: string) => Model<Api>;

const getModelsDynamic = getModels as (provider: string) => Model<Api>[];

function isExtensionRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

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
  deployment?: string;
  apiVersion?: string;
  // OAuth fields (used by OAuth providers)
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  userAvatar?: string;
  maskedValue?: string;
}

// Delete legacy keys on first access
let _legacyCleaned = false;
function cleanLegacyKeys(): void {
  if (_legacyCleaned) return;
  _legacyCleaned = true;
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }
}

function _resetLegacyCleanup(): void {
  _legacyCleaned = false;
}

/** Test-only exports */
export const __test__ = { _resetLegacyCleanup };

// Provider configs are now loaded dynamically from packages/webapp/src/providers/index.ts
// (built-in providers in packages/webapp/src/providers/built-in/ + external providers in /packages/webapp/providers/)

// Get all available providers — pi-ai providers (filtered by build config) + registered configs
export function getAvailableProviders(): string[] {
  const piProviders = (getProviders() as string[]).filter(shouldIncludeProvider);
  const registeredIds = getRegisteredProviderIds(); // external + built-in extensions, already filtered
  const merged = new Set([...piProviders, ...registeredIds]);
  return [...merged];
}

// Get provider config with fallback for unknown providers
export function getProviderConfig(providerId: string): ProviderConfig {
  return (
    getRegisteredProviderConfig(providerId) || {
      id: providerId,
      name: providerId
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      description: `${providerId} provider`,
      requiresApiKey: true,
      requiresBaseUrl: false,
    }
  );
}

/** Apply ModelMetadata overrides to a model object (mutates in place). */
function applyModelMetadata(
  model: Record<string, any>,
  metadata: {
    context_window?: number;
    max_tokens?: number;
    reasoning?: boolean;
    input?: string[];
    compat?: CompatOverrides;
  }
): void {
  if (metadata.context_window !== undefined) model.contextWindow = metadata.context_window;
  if (metadata.max_tokens !== undefined) model.maxTokens = metadata.max_tokens;
  if (metadata.reasoning !== undefined) model.reasoning = metadata.reasoning;
  if (metadata.input !== undefined) model.input = metadata.input;
  // Merge compat onto whatever pi-ai's base model already declared (or any
  // compat from a prior modelOverrides layer). Each successive layer can
  // override individual flags without clobbering siblings. Cast to a generic
  // record on both sides because pi-ai's compat shapes are disjoint interfaces
  // (no shared index signature) but in practice providers may set fields from
  // any of them — pi-ai reads by property name and ignores unknown fields.
  if (metadata.compat !== undefined) {
    model.compat = {
      ...((model.compat as Record<string, unknown> | undefined) ?? {}),
      ...(metadata.compat as Record<string, unknown>),
    };
  }
}

// Get models for a provider
export function getProviderModels(providerId: string): Model<Api>[] {
  try {
    // Bedrock CAMP uses Amazon Bedrock models with custom API.
    // Filter to inference-profile-prefixed Claude 4.x whose region matches
    // the configured endpoint (eu.* against us-* 400s "invalid model
    // identifier"), and inject models missing from pi-ai's registry (e.g.
    // opus-4.7). Dedupe by ID so extras auto-drop when pi-ai ships them.
    if (providerId === 'bedrock-camp') {
      const region = bedrockCampRegionFromBaseUrl(getBaseUrlForProvider('bedrock-camp'));
      const bedrockModels = getModelsDynamic('amazon-bedrock').filter((m) =>
        isBedrockCampCompatible(m, region)
      );
      const existingIds = new Set(bedrockModels.map((m) => m.id));
      const extras = getBedrockCampExtraModels().filter(
        (m) => isBedrockCampCompatible(m, region) && !existingIds.has(m.id)
      );
      return [...bedrockModels, ...extras].map((m) => ({
        ...m,
        api: 'bedrock-camp-converse' as Api,
        provider: 'bedrock-camp',
      }));
    }
    // Providers that use Anthropic's model registry with custom API
    const providerConfig = getProviderConfig(providerId);
    if (providerConfig.getModelIds) {
      // Provider specifies its own model list — resolve against all pi-ai registries
      let modelIds: ReturnType<NonNullable<ProviderConfig['getModelIds']>>;
      try {
        modelIds = providerConfig.getModelIds();
      } catch (err) {
        log.error('Provider getModelIds callback failed', {
          providerId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      // Build a lookup across all pi-ai providers so we find base models
      // regardless of their origin (Anthropic, Cerebras, OpenAI, etc.)
      const modelMap = new Map<string, Model<Api>>();
      for (const p of getProviders() as string[]) {
        try {
          for (const m of getModelsDynamic(p)) modelMap.set(m.id, m);
        } catch {
          /* provider may not have models */
        }
      }
      return modelIds.map((pm) => {
        // Determine API type from metadata: 'openai' or 'anthropic' (default)
        const apiType = pm.api === 'openai' ? 'openai' : 'anthropic';
        const customApi = `${providerId}-${apiType}` as Api;
        const base = modelMap.get(pm.id);
        const model: Record<string, any> = base
          ? { ...base, api: customApi, provider: providerId }
          : {
              id: pm.id,
              name: pm.name ?? pm.id,
              provider: providerId,
              api: customApi,
              baseUrl: '',
              contextWindow: 200000,
              maxTokens: 16384,
              input: ['text', 'image'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              inputCost: 0,
              outputCost: 0,
              cacheReadCost: 0,
              cacheWriteCost: 0,
              reasoning: true,
            };

        // Apply modelOverrides (layer 2) then getModelIds metadata (layer 3).
        // pm is a superset of ModelMetadata (adds id/name) — applyModelMetadata
        // reads only the fields it knows about and ignores extras.
        const overrides = providerConfig.modelOverrides?.[pm.id];
        if (overrides) applyModelMetadata(model, overrides);
        applyModelMetadata(model, pm);

        return model as unknown as Model<Api>;
      });
    }
    if (providerConfig.isOAuth) {
      // OAuth providers use Anthropic models with custom API routing
      const anthropicModels = getModelsDynamic('anthropic');
      const customApi = `${providerId}-anthropic` as Api;
      return anthropicModels.map((m) => {
        const model: Record<string, any> = { ...m, api: customApi, provider: providerId };
        const overrides = providerConfig.modelOverrides?.[m.id];
        if (overrides) applyModelMetadata(model, overrides);
        return model as unknown as Model<Api>;
      });
    }
    const effectiveProvider = providerId === 'azure-ai-foundry' ? 'anthropic' : providerId;
    return getModelsDynamic(effectiveProvider);
  } catch (err) {
    log.error('Failed to load models', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// --- OAuth account info (used by oauth-token shell command) ---

export function getOAuthAccountInfo(providerId: string): {
  token: string;
  expiresAt?: number;
  userName?: string;
  userAvatar?: string;
  expired: boolean;
} | null {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account?.accessToken) return null;
  const expired = !!account.tokenExpiresAt && Date.now() > account.tokenExpiresAt - 60000;
  return {
    token: account.accessToken,
    expiresAt: account.tokenExpiresAt,
    userName: account.userName,
    userAvatar: account.userAvatar,
    expired,
  };
}

// --- Build-time provider defaults from packages/webapp/providers.json ---

export interface ProviderDefault {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

// Vite resolves this at build time. Returns {} if packages/webapp/providers.json doesn't exist.
const providerFiles = import.meta.glob('/packages/webapp/providers.json', {
  eager: true,
  import: 'default',
}) as Record<string, ProviderDefault[]>;

const providerDefaults: ProviderDefault[] = providerFiles['/packages/webapp/providers.json'] ?? [];

const log = createLogger('provider-settings');

/**
 * Auto-configure provider accounts from packages/webapp/providers.json (bundled at build time).
 * Only populates if no accounts exist yet — never overwrites manual config.
 * The first entry's model becomes the selected model.
 *
 * Copy packages/dev-tools/providers.example.json to packages/webapp/providers.json and fill in your API keys.
 */
export function applyProviderDefaults(defaults: ProviderDefault[] = providerDefaults): void {
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

  const first = defaults.find((e) => e.providerId && e.apiKey && knownProviders.has(e.providerId));
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

/**
 * Patterns of model IDs hidden from human-facing pickers (chat header
 * dropdown, connect-llm wizard list, settings dialog). Programmatic
 * surfaces — `scoop_scoop`, the `agent` shell command, the `models`
 * shell command — keep the full list, so the cone can still spawn a
 * Haiku scoop for cheap throwaway work.
 *
 * Why Haiku: it routinely produces sub-optimal cone-level reasoning
 * for SLICC's task surface. Letting users pick it as the default
 * makes the product feel broken even though the model is performing
 * to spec.
 */
const PICKER_HIDDEN_MODEL_PATTERNS: RegExp[] = [/haiku/i];

/** True if the model ID should be hidden from human-facing pickers. */
export function isModelHiddenFromPicker(modelId: string): boolean {
  return PICKER_HIDDEN_MODEL_PATTERNS.some((re) => re.test(modelId));
}

/** Filter helper used by every UI surface that lists models. */
function pickerVisible<T extends { id: string }>(models: T[]): T[] {
  return models.filter((m) => !isModelHiddenFromPicker(m.id));
}

/** Get models from all configured provider accounts, grouped by provider. */
export function getAllAvailableModels(): GroupedModels[] {
  const accounts = getAccounts();
  if (accounts.length === 0) return [];
  const seen = new Map<string, GroupedModels>();
  for (const account of accounts) {
    if (seen.has(account.providerId)) continue;
    const models = pickerVisible(getProviderModels(account.providerId));
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
        typeof entry.apiKey === 'string'
    );
  } catch {
    return [];
  }
}

function saveAccounts(accounts: Account[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

export function addAccount(
  providerId: string,
  apiKey: string,
  baseUrl?: string,
  deployment?: string,
  apiVersion?: string
): void {
  const accounts = getAccounts().filter((a) => a.providerId !== providerId);
  const entry: Account = { providerId, apiKey };
  if (baseUrl) entry.baseUrl = baseUrl;
  if (deployment) entry.deployment = deployment;
  if (apiVersion) entry.apiVersion = apiVersion;
  accounts.push(entry);
  saveAccounts(accounts);
}

export async function removeAccount(providerId: string): Promise<void> {
  // Clear the replica BEFORE wiping the local Account
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  try {
    if (isExtension) {
      await chrome.storage.local.remove([
        `oauth.${providerId}.token`,
        `oauth.${providerId}.token_DOMAINS`,
      ]);
    } else {
      await fetch(`/api/secrets/oauth/${providerId}`, { method: 'DELETE' });
    }
  } catch (err) {
    console.error('OAuth replica removal failed:', err);
  }

  saveAccounts(getAccounts().filter((a) => a.providerId !== providerId));
  // Clear the stored `selected-model` if it pointed at the deleted
  // account. Without this, header dropdowns and the next message
  // continue to resolve `getSelectedProvider()` to the removed
  // provider — which then surfaces as
  // "No API key configured for provider …" the next time the user
  // sends a chat. The follow-up `ensureModelSelected` call in
  // layout.ts re-picks a default from the surviving accounts.
  const raw = localStorage.getItem(MODEL_KEY) ?? '';
  const sep = raw.indexOf(':');
  if (sep > 0 && raw.slice(0, sep) === providerId) {
    localStorage.removeItem(MODEL_KEY);
  }
}

/** Save an OAuth account (used by external providers after token exchange). */
export async function saveOAuthAccount(opts: {
  providerId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  userAvatar?: string;
  baseUrl?: string;
}): Promise<void> {
  const existing = getAccounts().find((a) => a.providerId === opts.providerId);
  const accounts = getAccounts().filter((a) => a.providerId !== opts.providerId);
  accounts.push({
    providerId: opts.providerId,
    apiKey: '', // OAuth providers don't use API keys
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    tokenExpiresAt: opts.tokenExpiresAt,
    userName: opts.userName,
    userAvatar: opts.userAvatar,
    baseUrl: opts.baseUrl ?? existing?.baseUrl,
  });
  saveAccounts(accounts);

  // Sync to replica (CLI: node-server /api/secrets/oauth-update; Extension: SW via chrome.storage.local + runtime.sendMessage)
  const cfg = getProviderConfig(opts.providerId);
  const domains = cfg?.oauthTokenDomains ?? [];
  if (domains.length === 0) return;

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  try {
    if (isExtension) {
      await chrome.storage.local.set({
        [`oauth.${opts.providerId}.token`]: opts.accessToken,
        [`oauth.${opts.providerId}.token_DOMAINS`]: domains.join(','),
      });
      const resp = await new Promise<{ maskedValue?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'secrets.mask-oauth-token', providerId: opts.providerId },
          (r: any) => resolve(r ?? {})
        );
      });
      if (resp.maskedValue) {
        const accounts = getAccounts();
        const acct = accounts.find((a) => a.providerId === opts.providerId);
        if (acct) {
          acct.maskedValue = resp.maskedValue;
          saveAccounts(accounts);
        }
      }
    } else {
      const r = await fetch('/api/secrets/oauth-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: opts.providerId,
          accessToken: opts.accessToken,
          domains,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        const accounts = getAccounts();
        const acct = accounts.find((a) => a.providerId === opts.providerId);
        if (acct && typeof data.maskedValue === 'string') {
          acct.maskedValue = data.maskedValue;
          saveAccounts(accounts);
        }
      }
    }
  } catch (err) {
    console.error('OAuth replica sync failed:', err);
  }
}

/** Fallback returned by getApiKeyForProvider for providers with
 *  `optionalApiKey: true` when the user hasn't stored one. Local LLM
 *  servers ignore the value but pi-ai's openai-completions stream and
 *  the scoop init guard require something non-null. */
const OPTIONAL_API_KEY_PLACEHOLDER = 'local';

/** What the user actually typed (or the OAuth flow stored). Returns null
 *  when the account has no key — does NOT inject the optional-provider
 *  placeholder. Use this from code that needs to round-trip the user's
 *  intent (e.g. `local-llm discover` upserting back into Settings); use
 *  {@link getApiKeyForProvider} from code that needs a non-null value to
 *  pass downstream (scoop init, pi-ai's stream). */
export function getRawApiKeyForProvider(providerId: string): string | null {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account) return null;
  // OAuth providers use accessToken instead of apiKey
  return account.accessToken || account.apiKey || null;
}

export function getApiKeyForProvider(providerId: string): string | null {
  const account = getAccounts().find((a) => a.providerId === providerId);
  // No account configured at all — return null so the scoop init guard
  // defers agent creation until the user sets the provider up.
  if (!account) return null;
  const stored = account.accessToken || account.apiKey;
  if (stored) return stored;
  // Account exists but the user left the key blank: providers that mark
  // the key optional get a placeholder so the scoop init guard and pi-ai's
  // stream don't fail. NOTE: the literal 'local' placeholder must match
  // local-llm.ts's PLACEHOLDER_API_KEY — they're independent guards at
  // different layers but must agree.
  if (getProviderConfig(providerId).optionalApiKey) {
    return OPTIONAL_API_KEY_PLACEHOLDER;
  }
  return null;
}

export function getBaseUrlForProvider(providerId: string): string | null {
  return getAccounts().find((a) => a.providerId === providerId)?.baseUrl ?? null;
}

export function getDeploymentForProvider(providerId: string): string | null {
  return getAccounts().find((a) => a.providerId === providerId)?.deployment ?? null;
}

export function getApiVersionForProvider(providerId: string): string | null {
  return getAccounts().find((a) => a.providerId === providerId)?.apiVersion ?? null;
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

export async function clearApiKey(): Promise<void> {
  const provider = getSelectedProvider();
  await removeAccount(provider);
}

export function getBaseUrl(): string | null {
  const provider = getSelectedProvider();
  return getBaseUrlForProvider(provider);
}

export function setBaseUrl(url: string): void {
  const provider = getSelectedProvider();
  // Use the raw stored key — passing through getApiKeyForProvider would
  // resolve the optionalApiKey placeholder ('local') and durably persist
  // it as the user's apiKey, shadowing the placeholder fallback.
  const apiKey = getRawApiKeyForProvider(provider);
  if (apiKey) {
    addAccount(provider, apiKey, url || undefined);
  }
}

export function clearBaseUrl(): void {
  const provider = getSelectedProvider();
  const apiKey = getRawApiKeyForProvider(provider);
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
export async function clearAllSettings(): Promise<void> {
  const accounts = getAccounts();
  for (const a of accounts) {
    await removeAccount(a.providerId);
  }
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
    const effectiveProvider = providerConfig.isOAuth
      ? 'anthropic'
      : providerId === 'azure-ai-foundry'
        ? 'anthropic'
        : providerId === 'bedrock-camp'
          ? 'amazon-bedrock'
          : providerId;
    const model = getModelDynamic(effectiveProvider, modelId);
    if (!model?.id) throw new Error(`Model ${modelId} not found`);
    let resolved: Model<Api> = model;

    if (providerConfig.isOAuth) {
      const providerModels = getProviderModels(providerId);
      const providerModel = providerModels.find((m) => m.id === modelId);
      if (providerModel) {
        // Prefer providerModel — it's already built by getProviderModels
        // with the correct api, provider, and any compat overrides applied
        // via applyModelMetadata (e.g. Adobe Haiku's
        // supportsEagerToolInputStreaming: false). The previous pattern of
        // cherry-picking only `api` here silently dropped compat.
        resolved = providerModel;
      } else {
        resolved = { ...resolved, api: `${providerId}-anthropic` as Api, provider: providerId };
      }
    } else if (providerId === 'bedrock-camp') {
      resolved = { ...resolved, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' };
    }
    if (baseUrl) {
      resolved = { ...resolved, baseUrl };
    }
    return resolved;
  } catch {
    return resolveCurrentModel();
  }
}

export function resolveCurrentModel(): Model<Api> {
  const providerId = getSelectedProvider();
  const modelId = getSelectedModelId();
  const baseUrl = getBaseUrlForProvider(providerId);

  // Get default model if none selected — check provider's defaultModelId preference
  const models = getProviderModels(providerId);
  const providerConfig = getProviderConfig(providerId);
  const preferredId = providerConfig.defaultModelId
    ? models.find((m) => m.id.toLowerCase().includes(providerConfig.defaultModelId!.toLowerCase()))
        ?.id
    : undefined;
  const effectiveModelId = modelId || preferredId || models[0]?.id || 'claude-sonnet-4-6';

  try {
    const providerConfig = getProviderConfig(providerId);
    const effectiveProvider = providerConfig.isOAuth
      ? 'anthropic'
      : providerId === 'azure-ai-foundry'
        ? 'anthropic'
        : providerId === 'bedrock-camp'
          ? 'amazon-bedrock'
          : providerId;
    const model = getModelDynamic(effectiveProvider, effectiveModelId);
    if (!model?.id)
      throw new Error(`Model ${effectiveModelId} not found in ${effectiveProvider} registry`);
    let resolved: Model<Api> = model;

    // Override api and provider for custom routing
    if (providerConfig.isOAuth) {
      // Prefer the providerModel built by getProviderModels — it carries
      // the correct api plus any compat overrides (e.g. Adobe Haiku's
      // supportsEagerToolInputStreaming: false). Cherry-picking only `api`
      // here would silently drop compat. See resolveModelById for the
      // matching change.
      const providerModel = models.find((m) => m.id === effectiveModelId);
      if (providerModel) {
        resolved = providerModel;
      } else {
        resolved = { ...resolved, api: `${providerId}-anthropic` as Api, provider: providerId };
      }
    } else if (providerId === 'bedrock-camp') {
      resolved = { ...resolved, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' };
    }

    // Override baseUrl if custom one is set
    if (baseUrl) {
      resolved = { ...resolved, baseUrl };
    }

    return resolved;
  } catch {
    // Model not in pi-ai registry — try provider's custom model list first
    const customModel = models.find((m) => m.id === effectiveModelId);
    if (customModel) {
      return baseUrl ? { ...customModel, baseUrl } : customModel;
    }
    // Last resort fallback
    return getModelDynamic('anthropic', 'claude-sonnet-4-0');
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
  pen: ['M14.3 3.3a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L7.7 14.8l-3.2.7.7-3.2z'],
  trash: [
    'M4 6h12',
    'M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2',
    'M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6',
  ],
};

export interface ShowProviderSettingsOptions {
  /** When true, start with the "Join a tray" form instead of the account form (when no accounts exist). */
  preferTrayJoin?: boolean;
  /** When set, show a simplified "Join this tray" confirmation with the URL pre-filled (no paste needed). */
  autoJoinUrl?: string;
}

/**
 * Show the Accounts management dialog.
 * Returns a promise that resolves to `true` if accounts were modified,
 * `false` if the user closed without changes (so callers can skip reload).
 */
export function showProviderSettings(options?: ShowProviderSettingsOptions): Promise<boolean> {
  trackSettingsOpen('button');
  return new Promise((resolve) => {
    const accountsBefore = localStorage.getItem(ACCOUNTS_KEY) ?? '';

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.cssText = 'max-width: 480px; width: 90vw; padding: 32px;';

    // Decide initial view: list if accounts exist, tray-join or add-form if empty
    if (getAccounts().length > 0) {
      renderAccountsList();
    } else if (options?.autoJoinUrl) {
      renderAutoJoinConfirmation(options.autoJoinUrl);
    } else if (options?.preferTrayJoin) {
      renderJoinTrayForm();
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
          name.style.cssText =
            'font-size: 14px; font-weight: 600; color: var(--s2-content-default);';
          name.textContent = config.name;
          info.appendChild(name);

          const detail = document.createElement('div');
          detail.style.cssText =
            'font-size: 11px; color: var(--s2-content-disabled); font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
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
          actions.style.cssText = 'display: flex; gap: 4px; margin-left: 12px; flex-shrink: 0;';

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
          deleteBtn.addEventListener('click', async () => {
            await removeAccount(account.providerId);
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
      addBtn.className =
        currentAccounts.length > 0 ? 'dialog__btn dialog__btn--secondary' : 'dialog__btn';
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

      // ── Tray section ────────────────────────────────────────────
      const traySep = document.createElement('hr');
      traySep.style.cssText =
        'border: none; border-top: 1px solid var(--s2-border-subtle); margin: 16px 0;';
      dialog.appendChild(traySep);

      const trayLabel = document.createElement('div');
      trayLabel.className = 'dialog__desc';
      trayLabel.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
      trayLabel.textContent = 'Tray';
      dialog.appendChild(trayLabel);

      const followerStatus = getFollowerTrayRuntimeStatus();
      const isFollowerActive = followerStatus.state !== 'inactive';
      const hasJoinUrl = hasStoredTrayJoinUrl(window.localStorage);

      if (isFollowerActive || hasJoinUrl) {
        const trayStatus = document.createElement('div');
        trayStatus.style.cssText =
          'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px;';
        const stateLabel = isFollowerActive ? followerStatus.state : 'configured';
        trayStatus.textContent = `Follower: ${stateLabel}`;
        if (followerStatus.error) {
          trayStatus.textContent += ` — ${followerStatus.error}`;
          trayStatus.style.color = 'var(--slicc-cone)';
        }
        dialog.appendChild(trayStatus);
      }

      const joinTrayBtn = document.createElement('button');
      joinTrayBtn.className = 'dialog__btn dialog__btn--secondary';
      joinTrayBtn.textContent =
        isFollowerActive || hasJoinUrl
          ? 'Reconnect to other browser'
          : 'Connect to another browser';
      joinTrayBtn.addEventListener('click', () => renderJoinTrayForm());
      dialog.appendChild(joinTrayBtn);

      // Separator before Get Started
      const closeSep = document.createElement('hr');
      closeSep.style.cssText =
        'border: none; border-top: 1px solid var(--s2-border-subtle); margin: 16px 0;';
      dialog.appendChild(closeSep);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog__btn';
      closeBtn.textContent = 'Get Started';
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
        const existingProviders = new Set(getAccounts().map((a) => a.providerId));
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
      providerDesc.style.cssText =
        'font-size: 12px; color: var(--s2-content-tertiary); margin-bottom: 16px; margin-top: -4px;';
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
      oauthStatus.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); text-align: center;';
      oauthSection.appendChild(oauthStatus);

      // OAuth login handler — calls the provider's onOAuthLogin callback with a generic launcher
      oauthLoginBtn.addEventListener('click', async () => {
        const pid = providerSelect.value;
        if (!pid) return;
        const providerConfig = getProviderConfig(pid);
        if (!providerConfig.onOAuthLogin) return;

        // Validate base URL if required
        const hadAccountBefore = getAccounts().some((a) => a.providerId === pid);
        const existingBaseUrl = getBaseUrlForProvider(pid);
        if (providerConfig.requiresBaseUrl && !baseUrlInput.value.trim() && !existingBaseUrl) {
          oauthStatus.textContent = 'Base URL is required.';
          oauthStatus.style.color = 'var(--slicc-cone)';
          baseUrlInput.focus();
          return;
        }
        // Save baseUrl before login so the provider's onOAuthLogin can read it
        if (providerConfig.requiresBaseUrl && baseUrlInput.value.trim()) {
          addAccount(pid, '', baseUrlInput.value.trim());
        }
        oauthStatus.textContent = 'Opening login window...';
        try {
          const { createOAuthLauncher } = await import('../providers/oauth-service.js');
          const launcher = createOAuthLauncher();
          await providerConfig.onOAuthLogin(launcher, renderAccountsList);
        } catch (err) {
          // Clean up pre-login baseUrl placeholder if no account existed before
          if (!hadAccountBefore) {
            try {
              await removeAccount(pid);
            } catch {
              /* best-effort cleanup */
            }
          }
          log.error('OAuth login failed', {
            providerId: pid,
            error: err instanceof Error ? err.message : String(err),
          });
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
      baseUrlDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      baseUrlSection.appendChild(baseUrlDesc);

      dialog.appendChild(baseUrlSection);

      // Deployment section (shown for providers with requiresDeployment)
      const deploymentSection = document.createElement('div');
      deploymentSection.style.display = 'none';

      const deploymentLabel = document.createElement('div');
      deploymentLabel.className = 'dialog__desc';
      deploymentLabel.textContent = 'Deployment:';
      deploymentSection.appendChild(deploymentLabel);

      const deploymentInput = document.createElement('input');
      deploymentInput.className = 'dialog__input';
      deploymentInput.type = 'text';
      deploymentInput.autocomplete = 'off';
      deploymentInput.spellcheck = false;
      if (isEdit && editing.deployment) deploymentInput.value = editing.deployment;
      deploymentSection.appendChild(deploymentInput);

      const deploymentDesc = document.createElement('div');
      deploymentDesc.className = 'dialog__desc';
      deploymentDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      deploymentSection.appendChild(deploymentDesc);

      dialog.appendChild(deploymentSection);

      // API version section (shown for providers with requiresApiVersion)
      const apiVersionSection = document.createElement('div');
      apiVersionSection.style.display = 'none';

      const apiVersionLabel = document.createElement('div');
      apiVersionLabel.className = 'dialog__desc';
      apiVersionLabel.textContent = 'API Version:';
      apiVersionSection.appendChild(apiVersionLabel);

      const apiVersionInput = document.createElement('input');
      apiVersionInput.className = 'dialog__input';
      apiVersionInput.type = 'text';
      apiVersionInput.autocomplete = 'off';
      apiVersionInput.spellcheck = false;
      if (isEdit && editing.apiVersion) apiVersionInput.value = editing.apiVersion;
      apiVersionSection.appendChild(apiVersionInput);

      const apiVersionDesc = document.createElement('div');
      apiVersionDesc.className = 'dialog__desc';
      apiVersionDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      apiVersionSection.appendChild(apiVersionDesc);

      dialog.appendChild(apiVersionSection);

      // Error message area
      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'color: var(--slicc-cone); font-size: 12px; margin-bottom: 8px; display: none;';
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
          baseUrlSection.style.display = providerConfig.requiresBaseUrl ? '' : 'none';
          if (providerConfig.requiresBaseUrl) {
            baseUrlInput.placeholder = providerConfig.baseUrlPlaceholder || 'https://...';
            baseUrlDesc.textContent = providerConfig.baseUrlDescription || '';
          }
          oauthLoginBtn.textContent = `Login with ${providerConfig.name}`;
          saveBtn.style.display = 'none';
        } else {
          oauthSection.style.display = 'none';
          const keyLabel = providerConfig.requiresApiKey ? 'API Key' : 'API Key (optional)';
          apiKeyLabel.textContent = `${keyLabel}${providerConfig.apiKeyEnvVar ? ` (${providerConfig.apiKeyEnvVar})` : ''}:`;
          apiKeyInput.placeholder = providerConfig.apiKeyPlaceholder || 'API key';
          const showApiKey = providerConfig.requiresApiKey || providerConfig.optionalApiKey;
          apiKeySection.style.display = showApiKey ? '' : 'none';
          baseUrlInput.placeholder = providerConfig.baseUrlPlaceholder || 'https://...';
          baseUrlDesc.textContent = providerConfig.baseUrlDescription || '';
          baseUrlSection.style.display = providerConfig.requiresBaseUrl ? '' : 'none';
          saveBtn.style.display = '';
        }

        // Deployment field
        if (providerConfig.requiresDeployment) {
          deploymentSection.style.display = '';
          deploymentInput.placeholder = providerConfig.deploymentPlaceholder || 'deployment-name';
          deploymentDesc.textContent = providerConfig.deploymentDescription || '';
        } else {
          deploymentSection.style.display = 'none';
        }

        // API version field
        if (providerConfig.requiresApiVersion) {
          apiVersionSection.style.display = '';
          if (!apiVersionInput.value && providerConfig.apiVersionDefault) {
            apiVersionInput.value = providerConfig.apiVersionDefault;
          }
          apiVersionInput.placeholder = providerConfig.apiVersionDefault || 'api-version';
          apiVersionDesc.textContent = providerConfig.apiVersionDescription || '';
        } else {
          apiVersionSection.style.display = 'none';
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

        if (config.requiresDeployment && !deploymentInput.value.trim()) {
          errorEl.textContent = 'Deployment name is required for this provider.';
          errorEl.style.display = '';
          deploymentInput.focus();
          return;
        }

        addAccount(
          pid,
          apiKeyInput.value.trim(),
          baseUrlInput.value.trim() || undefined,
          deploymentInput.value.trim() || undefined,
          apiVersionInput.value.trim() || undefined
        );

        renderAccountsList();
      }

      saveBtn.addEventListener('click', validateAndSave);

      const handleEnter = (e: KeyboardEvent) => {
        if (e.key === 'Enter') validateAndSave();
      };
      apiKeyInput.addEventListener('keydown', handleEnter);
      baseUrlInput.addEventListener('keydown', handleEnter);
      deploymentInput.addEventListener('keydown', handleEnter);
      apiVersionInput.addEventListener('keydown', handleEnter);

      dialog.appendChild(saveBtn);

      // Back button (only shown when accounts already exist)
      const hasAccounts = getAccounts().length > 0;
      if (!isEdit && !hasAccounts) {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'dialog__btn dialog__btn--secondary';
        joinBtn.style.marginTop = '8px';
        joinBtn.textContent = 'Connect to another browser';
        joinBtn.addEventListener('click', () => {
          renderJoinTrayForm();
        });
        dialog.appendChild(joinBtn);
      } else if (hasAccounts) {
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

    function renderAutoJoinConfirmation(joinUrl: string) {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Connect this browser?';
      dialog.appendChild(title);

      const desc = document.createElement('div');
      desc.className = 'dialog__desc';
      desc.style.marginBottom = '12px';
      desc.textContent =
        'You\u2019ve been invited to mirror another SLICC browser. Click below to start syncing.';
      dialog.appendChild(desc);

      // Show truncated URL for context
      const urlDisplay = document.createElement('div');
      urlDisplay.className = 'dialog__desc';
      urlDisplay.style.cssText =
        'font-family: monospace; font-size: 11px; color: var(--s2-content-secondary); word-break: break-all; margin-bottom: 16px; padding: 8px; background: var(--s2-bg-secondary); border-radius: 4px;';
      const displayUrl =
        joinUrl.length > 80 ? joinUrl.slice(0, 40) + '\u2026' + joinUrl.slice(-37) : joinUrl;
      urlDisplay.textContent = displayUrl;
      dialog.appendChild(urlDisplay);

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px; display: none;';
      dialog.appendChild(statusEl);

      const joinBtn = document.createElement('button');
      joinBtn.className = 'dialog__btn';
      joinBtn.textContent = 'Connect';
      joinBtn.addEventListener('click', () => {
        const stored = storeTrayJoinUrl(window.localStorage, joinUrl);
        if (!stored) {
          statusEl.textContent = 'Invalid sync URL.';
          statusEl.style.display = '';
          statusEl.style.color = 'var(--slicc-cone)';
          return;
        }

        if (isExtensionRuntime()) {
          const payload: RefreshTrayRuntimeMsg = {
            type: 'refresh-tray-runtime',
            joinUrl: stored.joinUrl,
            workerBaseUrl: stored.workerBaseUrl,
          };
          void chrome.runtime.sendMessage({ source: 'panel' as const, payload }).catch(() => {});
        } else {
          window.dispatchEvent(
            new CustomEvent('slicc:tray-join', {
              detail: { joinUrl: stored.joinUrl },
            })
          );
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
      });
      dialog.appendChild(joinBtn);

      const altBtn = document.createElement('button');
      altBtn.className = 'dialog__btn dialog__btn--secondary';
      altBtn.style.marginTop = '8px';
      altBtn.textContent = 'Set up an account instead';
      altBtn.addEventListener('click', () => {
        renderAccountForm();
      });
      dialog.appendChild(altBtn);
    }

    function renderJoinTrayForm() {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Connect to another browser';
      dialog.appendChild(title);

      const desc = document.createElement('div');
      desc.className = 'dialog__desc';
      desc.style.marginBottom = '12px';
      desc.textContent = 'Paste a multi-browser sync URL to mirror another SLICC browser.';
      dialog.appendChild(desc);

      const hint = document.createElement('details');
      hint.style.cssText =
        'margin-bottom: 12px; font-size: 12px; color: var(--s2-content-secondary);';
      const hintSummary = document.createElement('summary');
      hintSummary.style.cssText =
        'cursor: pointer; user-select: none; color: var(--s2-content-secondary);';
      hintSummary.textContent = 'How do I get the sync URL?';
      hint.appendChild(hintSummary);
      const hintBody = document.createElement('div');
      hintBody.style.cssText =
        'margin-top: 8px; padding: 10px 12px; background: var(--s2-bg-layer-2); border-radius: var(--s2-radius-default); border: 1px solid var(--s2-border-subtle); line-height: 1.5;';
      const hintList = document.createElement('ol');
      hintList.style.cssText = 'margin: 0; padding-left: 20px;';
      const steps = [
        'On the other SLICC, click the avatar (top right).',
        'Choose \u201cEnable multi-browser sync\u201d \u2014 the URL is copied automatically.',
        'Paste it below. Both browsers must be on the same SLICC version.',
      ];
      for (const step of steps) {
        const li = document.createElement('li');
        li.textContent = step;
        hintList.appendChild(li);
      }
      hintBody.appendChild(hintList);
      hint.appendChild(hintBody);
      dialog.appendChild(hint);

      const trayUrlLabel = document.createElement('div');
      trayUrlLabel.className = 'dialog__desc';
      trayUrlLabel.textContent = 'Sync URL:';
      dialog.appendChild(trayUrlLabel);

      const trayUrlInput = document.createElement('input');
      trayUrlInput.className = 'dialog__input';
      trayUrlInput.type = 'text';
      trayUrlInput.autocomplete = 'off';
      trayUrlInput.spellcheck = false;
      trayUrlInput.placeholder = 'https://www.sliccy.ai/join/<token>';
      dialog.appendChild(trayUrlInput);

      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'color: var(--slicc-cone); font-size: 12px; margin-bottom: 8px; display: none;';
      dialog.appendChild(errorEl);

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px; display: none;';

      const joinBtn = document.createElement('button');
      joinBtn.className = 'dialog__btn';
      joinBtn.textContent = 'Connect';
      joinBtn.addEventListener('click', () => {
        const raw = trayUrlInput.value.trim();
        if (!raw) {
          errorEl.textContent = 'Paste a sync URL to continue.';
          errorEl.style.display = '';
          trayUrlInput.focus();
          return;
        }
        const stored = storeTrayJoinUrl(window.localStorage, raw);
        if (!stored) {
          errorEl.textContent = describeInvalidJoinUrl(raw);
          errorEl.style.display = '';
          trayUrlInput.focus();
          return;
        }

        if (isExtensionRuntime()) {
          const payload: RefreshTrayRuntimeMsg = {
            type: 'refresh-tray-runtime',
            joinUrl: stored.joinUrl,
            workerBaseUrl: stored.workerBaseUrl,
          };
          void chrome.runtime.sendMessage({ source: 'panel' as const, payload }).catch(() => {
            // Offscreen may not be ready yet; mainExtension will reconnect shortly.
          });
        } else {
          window.dispatchEvent(
            new CustomEvent('slicc:tray-join', {
              detail: { joinUrl: stored.joinUrl },
            })
          );
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
      });
      dialog.appendChild(joinBtn);
      dialog.appendChild(statusEl);

      const backBtn = document.createElement('button');
      backBtn.className = 'dialog__btn dialog__btn--secondary';
      backBtn.style.marginTop = '8px';
      backBtn.textContent = 'Back';
      backBtn.addEventListener('click', () => {
        renderAccountForm();
      });
      dialog.appendChild(backBtn);

      trayUrlInput.addEventListener('input', () => {
        errorEl.style.display = 'none';
      });
      trayUrlInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') joinBtn.click();
      });

      requestAnimationFrame(() => trayUrlInput.focus());
    }
  });
}
