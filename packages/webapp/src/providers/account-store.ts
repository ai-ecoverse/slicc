/**
 * Provider account store — the DOM-free data layer for provider/account
 * configuration, extracted from `ui/provider-settings.ts` (issue #968).
 *
 * Worker-resident code (scoops, shell commands, built-in providers) consumes
 * these pure account/model accessors and resolvers. Keeping them out of the
 * settings dialog module means the ~1,000-line DOM dialog in
 * `ui/provider-settings.ts` is tree-shake-eligible from the kernel-worker
 * bundle instead of being dragged in for a handful of accessor functions.
 */

import type { Api } from '@earendil-works/pi-ai';
import {
  type OAuthExtraDomainsStore,
  readOAuthExtras as sharedReadOAuthExtras,
  writeOAuthExtras as sharedWriteOAuthExtras,
} from '@slicc/shared-ts';
import type { Model } from '../core/index.js';
import { createLogger, getModel, getModels, getProviders } from '../core/index.js';
import { resolveSecretTopology } from '../core/secret-topology.js';
import { callSecretsBridge } from '../core/secrets-bridge-client.js';
import { getPanelRpcClient, hasLocalDom } from '../kernel/panel-rpc.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { bedrockCampRegionFromBaseUrl, isBedrockCampCompatible } from './built-in/bedrock-camp.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  shouldIncludeProvider,
} from './index.js';
import type { CompatOverrides } from './types.js';

export type { ProviderConfig } from './index.js';

import type { ProviderConfig } from './index.js';

// Dynamic wrappers — pi-ai's getModel/getModels use strict generics
// that require KnownProvider literals, but the account store works
// with runtime strings from localStorage/user selection.
const getModelDynamic = getModel as (provider: string, modelId: string) => Model<Api>;

const getModelsDynamic = getModels as (provider: string) => Model<Api>[];

// Storage keys
export const ACCOUNTS_KEY = 'slicc_accounts';
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

// Provider ids that used to expose LLM models but no longer do — `selected-model`
// entries pointing at any of these are stale after the upgrade and must be
// cleared, otherwise `resolveCurrentModel()` falls through to its Anthropic
// default while `getApiKey()` still returns the unrelated OAuth token (e.g.
// GitHub PAT) and the next cone turn fails with an opaque auth error.
//
// We migrate eagerly on module load — `ensureModelSelected()` in layout.ts
// also catches the broader "stored selection no longer resolves" case, but
// it only runs on the page boot path; the worker context can `import` this
// module first and call `resolveCurrentModel()` before layout has booted.
const LEGACY_AUTH_ONLY_PROVIDERS = new Set(['github']);

/**
 * True when `providerId` is a pi-ai provider that the build config
 * (`packages/dev-tools/providers.build.json` → `shouldIncludeProvider`)
 * excludes — e.g. `amazon-bedrock`, whose pi browser stream is
 * unsupported. Registered built-in/external providers (e.g.
 * `bedrock-camp`, `adobe`) are not pi-ai providers and so are never
 * matched here; `bedrock-camp` still resolves its catalog via
 * `getModelsDynamic('amazon-bedrock')` untouched. Mirrors the pi-provider
 * filter in `getAvailableProviders()`. Never throws.
 */
function isBuildExcludedPiProvider(providerId: string): boolean {
  let piProviders: string[];
  try {
    piProviders = getProviders() as string[];
  } catch {
    return false;
  }
  return piProviders.includes(providerId) && !shouldIncludeProvider(providerId);
}

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
  /** True when the user has explicitly logged out; token fields are cleared but the row is retained. */
  loggedOut?: boolean;
}

// Delete legacy keys on first access
let LegacyCleaned = false;
function cleanLegacyKeys(): void {
  if (LegacyCleaned) return;
  LegacyCleaned = true;
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }
  migrateLegacyAuthOnlySelection();
}

/**
 * Clear `selected-model` when it points at a provider that used to expose
 * LLM models but no longer does — either a legacy auth-only provider
 * (currently: `github`, after the 3.13.0 Copilot split) or a pi-ai provider
 * excluded by the build config (e.g. `amazon-bedrock`, whose pi browser
 * stream is unsupported). In the latter case the stored account row is also
 * dropped so it can't resurface models or route the next cone turn through
 * the broken stream. Idempotent; never throws.
 *
 * Exported only for tests — the production path runs this through
 * `cleanLegacyKeys()` so the migration fires on the first call to
 * `getAccounts()` in both the panel and worker contexts.
 */
export function migrateLegacyAuthOnlySelection(): void {
  try {
    const raw = localStorage.getItem(MODEL_KEY);
    if (raw) {
      const sep = raw.indexOf(':');
      if (sep > 0) {
        const provider = raw.slice(0, sep);
        if (LEGACY_AUTH_ONLY_PROVIDERS.has(provider) || isBuildExcludedPiProvider(provider)) {
          localStorage.removeItem(MODEL_KEY);
        }
      }
    }
  } catch {
    /* localStorage may be unavailable in some contexts — leave the
       selection alone; layout.ts:ensureModelSelected() will catch
       the mismatch on the next boot. */
  }
  // Drop stored account rows for build-excluded pi-ai providers so a
  // previously-saved account (e.g. `amazon-bedrock`) can no longer surface
  // models or route chats through pi's browser-unsupported stream. Reads the
  // raw store directly to avoid recursing through getAccounts() → cleanLegacyKeys().
  try {
    const rawAccounts = localStorage.getItem(ACCOUNTS_KEY);
    if (!rawAccounts) return;
    const parsed = JSON.parse(rawAccounts);
    if (!Array.isArray(parsed)) return;
    const filtered = parsed.filter(
      (entry) =>
        !(
          entry != null &&
          typeof entry === 'object' &&
          typeof entry.providerId === 'string' &&
          isBuildExcludedPiProvider(entry.providerId)
        )
    );
    if (filtered.length !== parsed.length) {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(filtered));
    }
  } catch {
    /* leave accounts alone if storage is unavailable or the row is malformed. */
  }
}

function ResetLegacyCleanup(): void {
  LegacyCleaned = false;
}

/** Test-only exports */
export const __test__ = { _resetLegacyCleanup: ResetLegacyCleanup };

// Provider configs are now loaded dynamically from packages/webapp/src/providers/index.ts
// (built-in providers in packages/webapp/src/providers/built-in/ + external providers in /packages/webapp/providers/)

// Get all available providers — pi-ai providers (filtered by build config) + registered configs.
// Hidden providers (config.hidden) are participants in the registry but never
// surfaced to the user (see ProviderConfig.hidden — used by storage-slot
// providers like the GitHub Copilot token cache).
export function getAvailableProviders(): string[] {
  const piProviders = (getProviders() as string[]).filter(shouldIncludeProvider);
  const registeredIds = getRegisteredProviderIds(); // external + built-in extensions, already filtered
  const merged = new Set([...piProviders, ...registeredIds]);
  return [...merged].filter((id) => !getRegisteredProviderConfig(id)?.hidden);
}

/**
 * Whether a provider exposes any LLM models the user could actually pick.
 *
 * Used to keep auth-only providers (e.g. plain `github`, which exists solely
 * for git push/pull and the `oauth-token github` shell command) out of the
 * "Add Account" picker. Login-gated LLM providers like `github-copilot`
 * still pass because pi-ai's static registry advertises their catalog even
 * before the user authenticates.
 *
 * Checked sources, in order:
 *   1. `getProviderModels(id)` — covers providers that proxy another pi-ai
 *      registry (bedrock-camp → amazon-bedrock) and providers whose
 *      `getModelIds()` already resolves to a non-empty list.
 *   2. Pi-ai's static `getModels(id)` — catches providers that advertise a
 *      static catalog but resolve dynamic models only after login
 *      (github-copilot pre-login).
 *   3. The provider's `modelOverrides` declaration — explicit intent that
 *      models will be offered, even if both look-ups above are empty in
 *      the current state.
 */
export function providerOffersLlmModels(providerId: string): boolean {
  try {
    if (getProviderModels(providerId).length > 0) return true;
  } catch {
    /* fall through */
  }
  try {
    const piModels = (getModels as (id: string) => unknown[])(providerId);
    if (piModels.length > 0) return true;
  } catch {
    /* provider not registered with pi-ai */
  }
  const cfg = getRegisteredProviderConfig(providerId);
  if (cfg?.modelOverrides && Object.keys(cfg.modelOverrides).length > 0) return true;
  return false;
}

/**
 * Per-model variant of `providerOffersLlmModels`: does `providerId` advertise
 * `modelId` in any of the three catalog sources (provider models → pi-ai
 * static registry → `modelOverrides`)? Used by `getSelectedProvider()`'s
 * bare-id repair path so a WC-regressed `selected-model = "gpt-5"` resolves
 * to the account that actually offers `gpt-5`, not just the first LLM
 * account in storage.
 */
function providerOffersModelId(providerId: string, modelId: string): boolean {
  try {
    if (getProviderModels(providerId).some((m) => m.id === modelId)) return true;
  } catch {
    /* fall through */
  }
  try {
    const piModels = (getModels as (id: string) => { id: string }[])(providerId);
    if (piModels.some((m) => m.id === modelId)) return true;
  } catch {
    /* provider not registered with pi-ai */
  }
  const cfg = getRegisteredProviderConfig(providerId);
  if (cfg?.modelOverrides && Object.hasOwn(cfg.modelOverrides, modelId)) return true;
  return false;
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
  model: Record<string, unknown>,
  metadata: {
    context_window?: number;
    max_tokens?: number;
    reasoning?: boolean;
    input?: string[];
    compat?: CompatOverrides;
    thinkingLevelMap?: Record<string, string | null>;
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
  // Same per-level merge for thinkingLevelMap: pi-ai's stream functions read
  // `model.thinkingLevelMap[effort]` to translate the reasoning level, so a
  // provider override (e.g. Codex's `minimal` → `low`) must land on the model
  // rather than being silently dropped in favor of the base map.
  if (metadata.thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = {
      ...((model.thinkingLevelMap as Record<string, string | null> | undefined) ?? {}),
      ...metadata.thinkingLevelMap,
    };
  }
}

// Get models for a provider
export function getProviderModels(providerId: string): Model<Api>[] {
  try {
    // Bedrock CAMP uses Amazon Bedrock models with a custom API. Filter to
    // inference-profile-prefixed Claude 4.x whose region matches the
    // configured endpoint (eu.* against us-* 400s "invalid model
    // identifier"). pi-ai's amazon-bedrock registry now ships every Opus 4.7
    // profile variant; no manual extras list is needed.
    if (providerId === 'bedrock-camp') {
      const region = bedrockCampRegionFromBaseUrl(getBaseUrlForProvider('bedrock-camp'));
      return getModelsDynamic('amazon-bedrock')
        .filter((m) => isBedrockCampCompatible(m, region))
        .map((m) => ({
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
        let model: Record<string, unknown>;
        if (base) {
          model = { ...base, api: customApi, provider: providerId };
        } else {
          // Single source for the synthesized-model shape (api is known here
          // from proxy metadata, so pass it explicitly rather than inferring).
          model = buildProviderRoutedModel(providerId, pm.id, '', customApi) as unknown as Record<
            string,
            unknown
          >;
          if (pm.name) model.name = pm.name; // proxy display name; else keep the id
        }

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
        const model: Record<string, unknown> = { ...m, api: customApi, provider: providerId };
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
  maskedValue?: string;
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
    maskedValue: account.maskedValue,
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
    const config = getProviderConfig(account.providerId);
    // Hidden providers (e.g. internal Copilot token slot) participate in the
    // registry for token storage but must not surface in the picker even when
    // they have an active account.
    if (config.hidden) continue;
    // Build-excluded pi-ai providers (e.g. a previously-saved `amazon-bedrock`
    // account) must not surface models — pi's browser stream for them is
    // unsupported. Registered providers like `bedrock-camp` are unaffected.
    if (isBuildExcludedPiProvider(account.providerId)) continue;
    const models = pickerVisible(getProviderModels(account.providerId));
    if (models.length === 0) continue;
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

/**
 * User-configured extra OAuth-token domains, per-provider.
 *
 * The provider's hardcoded `oauthTokenDomains` defines the safe defaults.
 * Users can extend (not replace) that list per-provider via these helpers
 * — `saveOAuthAccount` merges defaults + extras + dedupes. To activate a
 * newly-added domain on an existing token, reload the page so
 * `oauth-bootstrap` re-pushes the replica with the merged list.
 *
 * Storage impl lives in `@slicc/shared-ts` so the chrome-extension options
 * page (`secrets-entry.ts`) and the side panel share a single parser. The
 * shared module accepts a `LocalStorageLike` for DI; we bind it to the
 * page's `localStorage`. The standalone kernel-worker reads the same key
 * via its Map-backed shim (`kernel-worker.ts:installLocalStorageShim`),
 * kept in sync by `installPageStorageSync`.
 */

export function getExtraOAuthDomains(providerId: string): string[] {
  return sharedReadOAuthExtras(localStorage)[providerId] ?? [];
}

export function setExtraOAuthDomains(providerId: string, domains: string[]): void {
  const store = sharedReadOAuthExtras(localStorage);
  const cleaned = domains.map((d) => d.trim()).filter((d) => d.length > 0);
  if (cleaned.length === 0) {
    delete store[providerId];
  } else {
    store[providerId] = cleaned;
  }
  sharedWriteOAuthExtras(localStorage, store);
}

/**
 * Worker-safe variant of `setExtraOAuthDomains`. In page context it
 * just calls the sync helper. In the kernel worker (no DOM, only a
 * Map-backed `localStorage` shim that doesn't echo back to the page —
 * see `kernel-worker.ts:installLocalStorageShim`) it routes the write
 * through `panel-rpc` so the page handler can mutate real
 * `window.localStorage`. The bridge response carries the full
 * post-write store; we mirror it into the worker shim before
 * resolving so a same-session `getExtraOAuthDomains` read sees the
 * new value without waiting for the cross-channel
 * `local-storage-set` forward to land.
 *
 * If the mirror-back itself throws (e.g., a future shim variant
 * rejecting writes), the durable page-side write has ALREADY
 * succeeded — degrade to a logged warning rather than propagating
 * up. The persistent state already holds the new value; surfacing
 * the throw would make `oauth-domain add` report failure on a write
 * that actually succeeded, with reload as the recovery path the
 * help text already promises.
 */
export async function setExtraOAuthDomainsAsync(
  providerId: string,
  domains: string[]
): Promise<void> {
  if (hasLocalDom()) {
    setExtraOAuthDomains(providerId, domains);
    return;
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error(
      'setExtraOAuthDomainsAsync: no DOM and no panel-rpc client — cannot persist to page localStorage'
    );
  }
  const { storeAfter } = await rpc.call('oauth-extras-set', { providerId, domains });
  try {
    sharedWriteOAuthExtras(localStorage, storeAfter);
  } catch (err) {
    log.warn('worker-shim mirror failed after successful page write — reload to refresh', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getAllExtraOAuthDomains(): OAuthExtraDomainsStore {
  return sharedReadOAuthExtras(localStorage);
}

function saveAccounts(accounts: Account[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
}

/**
 * Worker-safe variant of `saveAccounts`. In page context it's a direct
 * `localStorage.setItem`. In the kernel worker (no DOM, only the
 * Map-backed `localStorage` shim that doesn't echo back to the page —
 * see `kernel-worker.ts:installLocalStorageShim`) it routes the write
 * through `panel-rpc` so the page handler can mutate real
 * `window.localStorage`. The bridge response carries the stored JSON;
 * we mirror it into the worker shim before resolving so an immediate
 * `getAccounts()` read sees the new value without waiting for the
 * cross-channel `local-storage-set` forward to land.
 *
 * Without this routing, `saveOAuthAccount` calls originating in the
 * kernel worker (`mcp add`, MCP `onSilentRenew`) land only in the
 * worker shim and are lost on reload — issue #701.
 *
 * If the mirror-back itself throws, the durable page-side write has
 * already succeeded — log and continue rather than failing the caller
 * for a transient shim glitch.
 */
async function saveAccountsAsync(accounts: Account[]): Promise<void> {
  if (hasLocalDom()) {
    saveAccounts(accounts);
    return;
  }
  const rpc = getPanelRpcClient();
  if (!rpc) {
    throw new Error(
      'saveAccountsAsync: no DOM and no panel-rpc client — cannot persist to page localStorage'
    );
  }
  const accountsJson = JSON.stringify(accounts);
  const { storedJson } = await rpc.call('save-oauth-accounts', { accountsJson });
  try {
    localStorage.setItem(ACCOUNTS_KEY, storedJson);
  } catch (err) {
    log.warn('worker-shim mirror failed after successful page write — reload to refresh', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/**
 * Remove an OAuth token's replica (the `oauth.<id>.token` + `_DOMAINS` pair).
 *
 * #847 (remove-path twin): `removeAccount`/`logoutOAuthAccount` are reachable
 * from the offscreen shell (`mcp delete`, provider logout), which has
 * `chrome.runtime` but NOT `chrome.storage` — a direct
 * `chrome.storage.local.remove` throws there. Route the delete through the SW
 * `secrets.delete` message (whose `deleteSecret` removes both keys), mirroring
 * the write path. CLI deletes the node-server replica. Fail-open with a logged
 * breadcrumb (the local Account is wiped by the caller regardless).
 */
async function deleteOAuthReplica(providerId: string): Promise<void> {
  const topology = resolveSecretTopology();
  try {
    if (topology === 'extension-direct') {
      const resp = await new Promise<{ ok?: boolean; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'secrets.delete', name: `oauth.${providerId}.token` },
          (r: unknown) => {
            if (chrome.runtime.lastError) {
              log.error('SW secrets.delete transport failed', {
                providerId,
                error: chrome.runtime.lastError.message,
              });
            }
            resolve((r as { ok?: boolean; error?: string } | undefined) ?? {});
          }
        );
      });
      if (resp.error) {
        log.error('SW secrets.delete returned error', { providerId, error: resp.error });
      }
    } else if (topology === 'extension-delegate') {
      // Thin-extension hosted leader / kernel worker: route over the
      // secrets.crud Port bridge (mirrors the SW secrets.delete handler).
      const resp = await callSecretsBridge<{ ok?: boolean; error?: string } | undefined>(
        'secrets.delete',
        { name: `oauth.${providerId}.token` }
      );
      if (resp?.error) {
        log.error('Bridge secrets.delete returned error', { providerId, error: resp.error });
      }
    } else if (topology === 'connect') {
      // No node-server replica in connect mode — nothing to delete.
    } else {
      const r = await fetch(resolveApiUrl(`/api/secrets/oauth/${providerId}`), {
        method: 'DELETE',
        headers: apiHeaders(),
      });
      // 404 is benign (already deleted). Anything else non-2xx means the server
      // still has the OAuth token — surface so local clear ≠ server clear is visible.
      if (!r.ok && r.status !== 404) {
        log.warn('OAuth replica DELETE non-ok', { providerId, status: r.status });
      }
    }
  } catch (err) {
    log.error('OAuth replica removal failed', {
      providerId,
      topology,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function removeAccount(providerId: string): Promise<void> {
  // For OAuth providers, run the full logout sequence first (token revocation,
  // IdP session clear, and replica removal). removeAccount then finishes by
  // deleting the account entry entirely.
  const accountToRemove = getAccounts().find((a) => a.providerId === providerId);
  const configToRemove = getProviderConfig(providerId);
  if (accountToRemove && configToRemove?.isOAuth) {
    await logoutOAuthAccount(providerId);
  }

  // Clear the replica BEFORE wiping the local Account (SW-proxied in the
  // extension so it works from the offscreen shell — see deleteOAuthReplica).
  await deleteOAuthReplica(providerId);

  // Use the worker-safe async variant so `mcp delete` (which runs in
  // the kernel worker) writes through panel-rpc to real page
  // localStorage instead of just the worker shim Map. See #701.
  await saveAccountsAsync(getAccounts().filter((a) => a.providerId !== providerId));
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

/**
 * Logs out of an OAuth provider: revokes the token at the IdP API, opens the
 * IdP browser-session logout URL (if the provider defines one), clears local
 * token fields, and marks the account as loggedOut: true so the UI shows a
 * Login button instead.
 *
 * Does NOT remove the account row — use removeAccount for that. removeAccount
 * calls this internally for OAuth providers so delete also logs out.
 */
export async function logoutOAuthAccount(providerId: string): Promise<void> {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account) return;
  const providerConfig = getProviderConfig(providerId);
  if (!providerConfig?.isOAuth) return;

  // 1. Revoke the token at the IdP API
  if (providerConfig.onOAuthLogout) {
    try {
      await providerConfig.onOAuthLogout();
    } catch (err) {
      log.warn('onOAuthLogout failed', {
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Open IdP logout URL to clear browser session (Option B — see spec).
  //    Skipped gracefully when not defined or in non-window runtimes.
  if (providerConfig.getOAuthLogoutUrl) {
    const logoutUrl = providerConfig.getOAuthLogoutUrl(account);
    if (logoutUrl) {
      const { openIdpLogoutUrl } = await import('./oauth-service.js');
      await openIdpLogoutUrl(logoutUrl).catch((err) => {
        log.warn('IdP logout popup failed', {
          providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // 3. Clear token fields, retain display info, set loggedOut: true
  const updated = getAccounts().map((a): Account => {
    if (a.providerId !== providerId) return a;
    return {
      providerId: a.providerId,
      apiKey: '',
      baseUrl: a.baseUrl,
      userName: a.userName,
      userAvatar: a.userAvatar,
      loggedOut: true,
    };
  });
  await saveAccountsAsync(updated);

  // 4. Remove token replica from node-server / extension storage (SW-proxied
  //    in the extension so it works from the offscreen shell — see #847).
  await deleteOAuthReplica(providerId);
}

/**
 * Run the service-worker `secrets.mask-oauth-token` round-trip with a small
 * bounded retry. Opening a fresh side panel can cold-start the SW whose secrets
 * pipeline isn't warm yet, so the first round-trip (issued from the offscreen
 * shell, where `oauth-token` runs) can come back with no `maskedValue`
 * (issue #847). Retry a few times with a short backoff. Defense-in-depth: the
 * primary #847 cause was the offscreen `chrome.storage` gap, fixed by moving the
 * write into the SW (see `persistOAuthMaskViaServiceWorker`).
 *
 * @param send Issues one round-trip, resolving `{ maskedValue?, error? }`.
 * @param opts `attempts` (floored to >=1, default 3), `delayMs` (default 150),
 *   and an injectable `sleep`; no sleep after the final attempt.
 * @returns `{ maskedValue }` on success, else `{ lastError }` carrying the last
 *   SW-reported error (so the caller can log a non-empty give-up reason; may be
 *   undefined for a genuinely empty/cold reply). Never throws. Pure + injectable.
 */
export async function maskOAuthTokenWithRetry(
  send: () => Promise<{ maskedValue?: string; error?: string }>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ maskedValue?: string; lastError?: string }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: string | undefined;
  for (let i = 0; i < attempts; i++) {
    const resp = await send();
    if (resp.maskedValue) return { maskedValue: resp.maskedValue };
    if (resp.error) lastError = resp.error;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { lastError };
}

/**
 * Register an OAuth token's masked replica via the service worker and persist
 * the masked value on the account.
 *
 * #847: `saveOAuthAccount` is reachable from the offscreen `oauth-token` shell
 * (which has `chrome.runtime` but NOT `chrome.storage`) as well as the page-side
 * login button (which does have `chrome.storage`). Routing the write through the
 * SW — which owns `chrome.storage` — is the single path that works from BOTH, so
 * the token + domains travel IN the SW message and the SW does the write. The
 * remove path does the same via `deleteOAuthReplica`. Returns (after a
 * `log.error` breadcrumb with the SW reason) if masking never succeeds, and
 * no-ops if the account row is gone. Pure + injectable; unit-testable sans `chrome`.
 */
export async function persistOAuthMaskViaServiceWorker(
  opts: { providerId: string; accessToken: string; domains: string[] },
  deps: {
    sendMaskRequest: (payload: {
      providerId: string;
      accessToken: string;
      domains: string;
    }) => Promise<{ maskedValue?: string; error?: string }>;
    getAccounts: () => Account[];
    saveAccounts: (accounts: Account[]) => Promise<void>;
  },
  maskOpts?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<void> {
  const payload = {
    providerId: opts.providerId,
    accessToken: opts.accessToken,
    domains: opts.domains.join(','),
  };
  const { maskedValue, lastError } = await maskOAuthTokenWithRetry(
    () => deps.sendMaskRequest(payload),
    maskOpts
  );
  if (!maskedValue) {
    // Don't fail silently: the account stays unmasked and `oauth-token` will
    // report "no masked value". log.warn is dropped at the prod ERROR level, so
    // this give-up breadcrumb must be log.error to be visible at all (#847).
    // Carry the SW reason so the operator can tell a cold/empty reply apart from
    // a write failure or "entry missing after write" pipeline fault.
    log.error('OAuth mask give-up: no masked value after retries', {
      providerId: opts.providerId,
      reason: lastError ?? 'no error reported (cold SW or empty reply)',
    });
    return;
  }
  const accounts = deps.getAccounts();
  const acct = accounts.find((a) => a.providerId === opts.providerId);
  if (acct) {
    acct.maskedValue = maskedValue;
    await deps.saveAccounts(accounts);
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
  // Worker-safe save: `mcp add` and MCP `onSilentRenew` run in the
  // kernel worker where a direct `saveAccounts` would land in the
  // shim Map and be lost on reload (#701). The async helper routes
  // worker writes through `panel-rpc` to real page localStorage.
  await saveAccountsAsync(accounts);

  // Sync to replica (CLI: node-server /api/secrets/oauth-update; Extension: SW
  // message — the SW owns the chrome.storage write, see persistOAuthMaskViaServiceWorker)
  const cfg = getProviderConfig(opts.providerId);
  const defaults = cfg?.oauthTokenDomains ?? [];
  const extras = getExtraOAuthDomains(opts.providerId);
  // Merge + dedupe (case-insensitive, preserve provider-default order).
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const d of [...defaults, ...extras]) {
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    domains.push(d);
  }
  if (domains.length === 0) return;

  const topology = resolveSecretTopology();
  try {
    if (topology === 'extension-direct') {
      // #847: `oauth-token` runs in the offscreen document, which has
      // `chrome.runtime` but NOT `chrome.storage` — a direct
      // `chrome.storage.local.set` here throws "Cannot read properties of
      // undefined (reading 'local')", the catch swallows it, and the account is
      // left unmasked. Send the token + domains IN the message so the service
      // worker (which owns `chrome.storage`) writes them, then masks. The retry
      // also covers a genuinely cold SW that isn't ready on the first round-trip.
      const sendMaskRequest = (payload: {
        providerId: string;
        accessToken: string;
        domains: string;
      }) =>
        new Promise<{ maskedValue?: string; error?: string }>((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'secrets.mask-oauth-token', ...payload },
            (r: unknown) => {
              // Chrome sets `lastError` AND invokes the callback with
              // `undefined` when the SW is unreachable / message port closed /
              // listener crashed. Without explicit handling the empty
              // resolve looks identical to "SW returned no maskedValue".
              if (chrome.runtime.lastError) {
                log.error('SW mask-oauth-token transport failed', {
                  providerId: opts.providerId,
                  error: chrome.runtime.lastError.message,
                });
              }
              // The SW handler returns `{ maskedValue: undefined, error: '<msg>' }`
              // on storage-write / pipeline-build failure (see service-worker.ts
              // secrets.mask-oauth-token catch). Surface that — matching the CLI
              // branch's "OAuth replica POST non-ok" logging.
              const response =
                typeof r === 'object' && r !== null
                  ? (r as { maskedValue?: string; error?: string })
                  : undefined;
              if (response?.error) {
                log.warn('SW mask-oauth-token returned error', {
                  providerId: opts.providerId,
                  error: response.error,
                });
              }
              resolve(response ?? {});
            }
          );
        });
      await persistOAuthMaskViaServiceWorker(
        { providerId: opts.providerId, accessToken: opts.accessToken, domains },
        { sendMaskRequest, getAccounts, saveAccounts: saveAccountsAsync }
      );
    } else if (topology === 'extension-delegate') {
      // Thin-extension hosted leader / kernel worker: route the mask round-trip
      // over the secrets.crud Port bridge. The same #847 bounded retry applies
      // (a cold SW behind the bridge can come back with no maskedValue too).
      const sendMaskRequest = (payload: {
        providerId: string;
        accessToken: string;
        domains: string;
      }) =>
        callSecretsBridge<{ maskedValue?: string; error?: string } | undefined>(
          'secrets.mask-oauth-token',
          payload
        )
          .then((r) => {
            if (r?.error) {
              log.warn('Bridge mask-oauth-token returned error', {
                providerId: opts.providerId,
                error: r.error,
              });
            }
            return r ?? {};
          })
          .catch((err) => {
            log.error('Bridge mask-oauth-token transport failed', {
              providerId: opts.providerId,
              error: err instanceof Error ? err.message : String(err),
            });
            return {};
          });
      await persistOAuthMaskViaServiceWorker(
        { providerId: opts.providerId, accessToken: opts.accessToken, domains },
        { sendMaskRequest, getAccounts, saveAccounts: saveAccountsAsync }
      );
    } else if (topology === 'connect') {
      // Connect mode (provider-login popup on www.sliccy.ai): no node-server
      // replica store — the local Account save above is the only write.
    } else {
      const r = await fetch(resolveApiUrl('/api/secrets/oauth-update'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          providerId: opts.providerId,
          accessToken: opts.accessToken,
          domains,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        if (typeof data.maskedValue === 'string') {
          const accounts = getAccounts();
          const acct = accounts.find((a) => a.providerId === opts.providerId);
          if (acct) {
            acct.maskedValue = data.maskedValue;
            await saveAccountsAsync(accounts);
          }
        } else {
          // 2xx with no string maskedValue is the EXT7-triage silent-pass
          // defect: oauth-token / git-token-write later report "no masked
          // value" with no breadcrumb. Surface it; bootstrap retries on reload.
          log.warn('OAuth replica POST ok but missing maskedValue', {
            providerId: opts.providerId,
          });
        }
      } else {
        // Server reachable but rejected the push (auth, validation, 5xx).
        // The local Account is saved either way (fail-open per spec), but
        // without surfacing this the user gets a confusing "no masked
        // value" error from oauth-token / git-token-write later with no
        // breadcrumb. Bootstrap-on-init retries on the next page load.
        log.warn('OAuth replica POST non-ok', {
          providerId: opts.providerId,
          status: r.status,
        });
      }
    }
  } catch (err) {
    log.error('OAuth replica sync failed', {
      providerId: opts.providerId,
      topology,
      error: err instanceof Error ? err.message : String(err),
    });
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
  // Decide whether `modelId` is ALREADY prefixed by inspecting the
  // leading token, NOT by a bare `includes(':')` test. Bedrock model
  // ids legitimately carry a `:<version>` segment (e.g.
  // `eu.anthropic.claude-opus-4-5-20251101-v1:0`); the previous
  // `includes(':')` shortcut treated those as pre-prefixed, persisted
  // them as-is, and `getSelectedProvider()` then resolved the leading
  // token as the provider — leaving the cone routed at a phantom
  // `eu.anthropic.claude-opus-4-5-20251101-v1` provider.
  //
  // The leading token is treated as a provider prefix when either:
  //   1. It matches a known provider id (built-in extension, external
  //      provider, or a pi-ai registry entry), OR
  //   2. It looks like a provider id structurally — no `.` characters.
  //      Bedrock model fragments invariably contain dots
  //      (`anthropic.claude-…`, `eu.anthropic.claude-…`,
  //      `us.amazon.titan-…`); no shipped provider id does. The
  //      structural fallback keeps fixtures that call this function
  //      before `registerProviders()` has populated the registry from
  //      mis-routing a legitimate `adobe:claude-…` style payload.
  const idx = modelId.indexOf(':');
  if (idx > 0) {
    const leading = modelId.slice(0, idx);
    const known = new Set<string>([...getRegisteredProviderIds(), ...getAvailableProviders()]);
    const looksLikeBedrockFragment = leading.includes('.');
    if (known.has(leading) || !looksLikeBedrockFragment) {
      localStorage.setItem(MODEL_KEY, modelId);
      return;
    }
  }
  // Bare id, or a colon-bearing id whose leading token contains a dot
  // (Bedrock): attach the current provider prefix so downstream
  // resolvers don't mis-route.
  const provider = getSelectedProvider();
  localStorage.setItem(MODEL_KEY, `${provider}:${modelId}`);
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
  // No provider encoded (or empty prefix like ":gpt-5") — repair the bare id.
  // Priority order:
  //   1. The first LLM account whose catalog actually offers the bare
  //      `selected-model`. Without this check, a WC-regressed profile with
  //      `selected-model = "gpt-5"` and accounts ordered `github, anthropic,
  //      openai` would route through Anthropic; `resolveCurrentModel()`
  //      cannot find `gpt-5` there and degrades to the native Anthropic
  //      default, silently swapping the user's OpenAI selection.
  //   2. The first account that offers any LLM models. An auth-only account
  //      (e.g. `github` for git push/pull) would otherwise win the fallback
  //      and drag the cone into an unregistered `github-anthropic` api route.
  //   3. Collapse to `accounts[0]` / `'anthropic'` when nothing qualifies.
  const accounts = getAccounts();
  const selectedModelId = getSelectedModelId();
  if (selectedModelId) {
    const offering = accounts.find(
      (a) =>
        providerOffersLlmModels(a.providerId) &&
        providerOffersModelId(a.providerId, selectedModelId)
    );
    if (offering) return offering.providerId;
  }
  const llmAccount = accounts.find((a) => providerOffersLlmModels(a.providerId));
  if (llmAccount) return llmAccount.providerId;
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
// Clear all provider settings
export async function clearAllSettings(): Promise<void> {
  // Fan out the per-account replica clears in parallel — sequential `await`
  // makes a single slow proxy (e.g. node-server unreachable, hitting the
  // default fetch timeout) block every subsequent removal, so the UI hangs
  // for N×timeout seconds. allSettled because each remove already swallows
  // its own errors (fail-open) and a single transient failure shouldn't
  // gate the rest.
  const accounts = getAccounts();
  await Promise.allSettled(accounts.map((a) => removeAccount(a.providerId)));
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(MODEL_KEY);
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

/**
 * Cold-cache heuristic for the proxy API family of a model id pi-ai's registry
 * doesn't know. The real `api` comes from the provider's model metadata once
 * the list is fetched; until then we guess from the id so an OpenAI-flavored
 * model routes through the OpenAI API instead of Anthropic (which would fail at
 * the wire-format level). Conservative — only well-known OpenAI families map to
 * `openai`; everything else (incl. all current Adobe `claude-*` models) stays
 * `anthropic`. Self-corrects once the model list warms.
 */
function inferProviderApiType(modelId: string): 'anthropic' | 'openai' {
  return /^(?:gpt[-.]?|o[0-9]|chatgpt)/i.test(modelId) ? 'openai' : 'anthropic';
}

/**
 * Build a provider-routed model for a model id that pi-ai's registry does not
 * know. OAuth/custom providers (Adobe, etc.) proxy arbitrary model ids, so an
 * unknown id must still route through the provider rather than degrading to a
 * native Anthropic model — otherwise the provider's token (e.g. an Adobe IMS
 * token) is sent to api.anthropic.com and rejected with `401 invalid x-api-key`.
 *
 * `api` is passed by callers that already know it (e.g. `getProviderModels`,
 * from proxy metadata); when omitted (the cold-cache resolver path) it's
 * inferred from the id via `inferProviderApiType`. Context-window/max-tokens
 * are conservative defaults; the real metadata arrives once the list is fetched.
 */
function buildProviderRoutedModel(
  providerId: string,
  modelId: string,
  baseUrl: string | null,
  api?: Api
): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    api: api ?? (`${providerId}-${inferProviderApiType(modelId)}` as Api),
    baseUrl: baseUrl ?? '',
    contextWindow: 200000,
    maxTokens: 16384,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
  } as Model<Api>;
}

/**
 * The pi-ai registry a provider's models should be resolved against. OAuth
 * and Azure providers proxy Anthropic's catalog; bedrock-camp proxies
 * amazon-bedrock; everything else resolves against its own id.
 */
function resolveEffectiveProvider(providerId: string, providerConfig: ProviderConfig): string {
  if (providerConfig.isOAuth) return 'anthropic';
  if (providerId === 'azure-ai-foundry') return 'anthropic';
  if (providerId === 'bedrock-camp') return 'amazon-bedrock';
  return providerId;
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
  const providerConfig = getProviderConfig(providerId);

  try {
    const effectiveProvider = resolveEffectiveProvider(providerId, providerConfig);
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
  } catch (err) {
    // Common, benign case: the id is simply unknown to pi-ai. Keep at debug so
    // an *unexpected* throw (registry/override bug) leaves a breadcrumb instead
    // of resolving silently.
    log.debug('resolveModelById: pi-ai lookup miss, using provider fallback', {
      providerId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Unknown to pi-ai (threw or returned no id). For an OAuth/custom provider,
    // resolve the REQUESTED id through the provider — prefer its own model list,
    // else synthesize a provider-routed model. Never fall through to
    // resolveCurrentModel() (which resolves the *selected* model, not the
    // requested one) or to a native Anthropic model (which would leak the
    // OAuth token → 401 invalid x-api-key). See the cloud-cone regression.
    if (providerConfig.isOAuth) {
      const providerModel = getProviderModels(providerId).find((m) => m.id === modelId);
      if (providerModel) return baseUrl ? { ...providerModel, baseUrl } : providerModel;
      return buildProviderRoutedModel(providerId, modelId, baseUrl);
    }
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
    const effectiveProvider = resolveEffectiveProvider(providerId, providerConfig);
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
  } catch (err) {
    log.debug('resolveCurrentModel: pi-ai lookup miss, using provider fallback', {
      providerId,
      effectiveModelId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Model not in pi-ai registry — try provider's custom model list first
    const customModel = models.find((m) => m.id === effectiveModelId);
    if (customModel) {
      return baseUrl ? { ...customModel, baseUrl } : customModel;
    }
    // OAuth/custom providers proxy arbitrary model ids — route the unknown id
    // through the provider rather than returning a native Anthropic model,
    // which would send the provider's token (e.g. Adobe IMS) to
    // api.anthropic.com → 401 invalid x-api-key. See the cloud-cone regression.
    if (providerConfig.isOAuth) {
      return buildProviderRoutedModel(providerId, effectiveModelId, baseUrl);
    }
    // Last resort fallback
    return getModelDynamic('anthropic', 'claude-sonnet-4-0');
  }
}

/**
 * Resolve a shorthand keyword (e.g. "opus", "sonnet", "haiku", "gpt",
 * "gemini") to the best available model whose id or name contains the
 * keyword. "Best" = largest contextWindow, with numeric version segments
 * as tiebreaker for models sharing the same window size.
 *
 * The match is intentionally loose (any id/name containing the keyword
 * wins) so it works across providers without a hardcoded family list.
 *
 * Returns the concrete model id, or null if no model matches.
 */
export function resolveModelByShorthand(input: string): string | null {
  const keyword = input.toLowerCase();
  if (!keyword) return null;

  let bestId: string | null = null;
  let bestContextWindow = -1;

  for (const account of getAccounts()) {
    for (const model of getProviderModels(account.providerId)) {
      const idLower = model.id.toLowerCase();
      const nameLower = (model.name ?? '').toLowerCase();
      if (!idLower.includes(keyword) && !nameLower.includes(keyword)) continue;

      const contextWindow = model.contextWindow ?? 0;
      if (
        contextWindow > bestContextWindow ||
        (contextWindow === bestContextWindow && compareVersionSegments(model.id, bestId ?? '') > 0)
      ) {
        bestContextWindow = contextWindow;
        bestId = model.id;
      }
    }
  }

  return bestId;
}

/**
 * Compare two model ids by their trailing numeric segments. Handles
 * multi-digit versions correctly (e.g. "4-10" > "4-9").
 */
function compareVersionSegments(a: string, b: string): number {
  const segsA = a.match(/\d+/g)?.map(Number) ?? [];
  const segsB = b.match(/\d+/g)?.map(Number) ?? [];
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const diff = (segsA[i] ?? 0) - (segsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
