/**
 * Provider Settings — unified configuration for all pi-ai providers.
 * Replaces the old API Key dialog with a comprehensive provider selector,
 * provider-specific options, and dynamic model population.
 */

import type { Api } from '@earendil-works/pi-ai';
import type { Model } from '../core/index.js';
import { createLogger, getModel, getModels, getProviders } from '../core/index.js';
import { hasStoredTrayJoinUrl, storeTrayJoinUrl } from '../scoops/tray-runtime-config.js';
import { describeInvalidJoinUrl } from './tray-join-url.js';

export { describeInvalidJoinUrl };

import type { RefreshTrayRuntimeMsg } from '../../../chrome-extension/src/messages.js';
import {
  bedrockCampRegionFromBaseUrl,
  isBedrockCampCompatible,
} from '../providers/built-in/bedrock-camp.js';
import type { ProviderConfig } from '../providers/index.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  shouldIncludeProvider,
} from '../providers/index.js';
import type { CompatOverrides, DeviceCodePrompter } from '../providers/types.js';
import { getFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { copyTextToClipboard } from './clipboard.js';
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

/**
 * Dispatch the `slicc:tray-join` CustomEvent and wire a one-shot
 * `slicc:tray-join-failed` listener that surfaces the half-state
 * failure in the dialog's status element. Returns a cancel function
 * so the caller can detach the listener proactively if the dialog
 * closes before the event arrives.
 *
 * Each dispatch is stamped with a fresh `requestId` carried in the
 * `slicc:tray-join` event's `detail` and echoed back on the failure
 * event — the listener filters by `requestId` so a double-Connect
 * doesn't bleed errors between attempts. If the user clicks
 * "Connect" twice rapidly each click has its own correlation id.
 *
 * If `statusEl` is detached from the DOM by the time the failure
 * event arrives, we log at `error` level so the half-state isn't
 * invisible — the UX swallowing path matters because the next chat
 * send in a half-state could route to the wrong agent.
 */
/** Exposed for unit testing — not part of the public module surface. */
export function _testOnly_dispatchTrayJoinWithFailureFeedback(
  joinUrl: string,
  statusEl: HTMLElement
): () => void {
  return dispatchTrayJoinWithFailureFeedback(joinUrl, statusEl);
}

function dispatchTrayJoinWithFailureFeedback(joinUrl: string, statusEl: HTMLElement): () => void {
  const requestId = `tray-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let removed = false;
  let autoCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const remove = () => {
    if (removed) return;
    removed = true;
    // Clear the auto-cleanup timer so a proactive cancel() releases
    // the closure (joinUrl, statusEl, onFailure) instead of pinning
    // it for up to 10s after the dialog dismisses.
    if (autoCleanupTimer !== undefined) clearTimeout(autoCleanupTimer);
    window.removeEventListener('slicc:tray-join-failed', onFailure);
  };
  const onFailure = (e: Event) => {
    const detail = (e as CustomEvent<{ joinUrl: string; error: string; requestId?: string }>)
      .detail;
    // Filter by requestId so a double-Connect attempt doesn't receive
    // the other attempt's failure. Older `slicc:tray-join` dispatchers
    // (pre-R12) don't echo the requestId — we accept those too (legacy
    // path) so the listener still works during a rolling upgrade of
    // the codebase.
    if (detail.requestId !== undefined && detail.requestId !== requestId) return;
    remove();
    if (!statusEl.isConnected) {
      // Dialog dismissed before the failure event arrived — the user
      // sees no error UX. Surface to logs at error so the half-state
      // is at least auditable.
      log.error('Tray-join failure arrived after dialog dismissed (UX swallowed half-state)', {
        joinUrl,
        error: detail.error,
        requestId,
      });
      return;
    }
    // Cancel the optimistic dismiss so the user can read the error.
    const dismissTimerStr = statusEl.dataset.dismissTimer;
    if (dismissTimerStr) {
      const dismissTimer = Number(dismissTimerStr);
      if (Number.isFinite(dismissTimer)) clearTimeout(dismissTimer);
      delete statusEl.dataset.dismissTimer;
    }
    statusEl.textContent = `Sync failed: ${detail.error}. Reload the page and try again.`;
    statusEl.style.color = 'var(--slicc-cone)';
  };
  window.addEventListener('slicc:tray-join-failed', onFailure);
  // Auto-cleanup the listener after 10s — much longer than the 800ms
  // optimistic dismiss, but short enough that a stale listener doesn't
  // outlive the dialog if the user navigates away.
  autoCleanupTimer = setTimeout(remove, 10_000);
  window.dispatchEvent(new CustomEvent('slicc:tray-join', { detail: { joinUrl, requestId } }));
  return remove;
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
        let model: Record<string, any>;
        if (base) {
          model = { ...base, api: customApi, provider: providerId };
        } else {
          // Single source for the synthesized-model shape (api is known here
          // from proxy metadata, so pass it explicitly rather than inferring).
          model = buildProviderRoutedModel(providerId, pm.id, '', customApi) as unknown as Record<
            string,
            any
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
import {
  type OAuthExtraDomainsStore,
  readOAuthExtras as sharedReadOAuthExtras,
  writeOAuthExtras as sharedWriteOAuthExtras,
} from '@slicc/shared-ts';
import { getPanelRpcClient, hasLocalDom } from '../kernel/panel-rpc.js';

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
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  try {
    if (isExtension) {
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
    } else {
      const r = await fetch(`/api/secrets/oauth/${providerId}`, { method: 'DELETE' });
      // 404 is benign (already deleted). Anything else non-2xx means the server
      // still has the OAuth token — surface so local clear ≠ server clear is visible.
      if (!r.ok && r.status !== 404) {
        log.warn('OAuth replica DELETE non-ok', { providerId, status: r.status });
      }
    }
  } catch (err) {
    log.error('OAuth replica removal failed', {
      providerId,
      isExtension,
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
      const { openIdpLogoutUrl } = await import('../providers/oauth-service.js');
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

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  try {
    if (isExtension) {
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
          chrome.runtime.sendMessage({ type: 'secrets.mask-oauth-token', ...payload }, (r: any) => {
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
            if (r?.error) {
              log.warn('SW mask-oauth-token returned error', {
                providerId: opts.providerId,
                error: r.error,
              });
            }
            resolve(r ?? {});
          });
        });
      await persistOAuthMaskViaServiceWorker(
        { providerId: opts.providerId, accessToken: opts.accessToken, domains },
        { sendMaskRequest, getAccounts, saveAccounts: saveAccountsAsync }
      );
    } else if (!(globalThis as Record<string, unknown>).__slicc_connect_mode) {
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
          await saveAccountsAsync(accounts);
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
      isExtension,
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
  /** Arrow leaving a box — used for the Logout button */
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  /** Arrow entering a box — used for the Login (re-connect) button */
  login: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'],
};

export interface ShowProviderSettingsOptions {
  /** When true, start with the "Join a tray" form instead of the account form (when no accounts exist). */
  preferTrayJoin?: boolean;
  /** When set, show a simplified "Join this tray" confirmation with the URL pre-filled (no paste needed). */
  autoJoinUrl?: string;
  /**
   * When true, open straight to the add-account form (provider picker + login),
   * skipping the accounts list and tray-join views. Used by connect mode, where
   * the dashboard already shows the account list and tray-join is irrelevant.
   * In this mode the form's secondary button is a plain "Cancel" (close) instead
   * of "Back"/"Connect to another browser".
   */
  startInAddAccount?: boolean;
  /**
   * Restrict the provider picker to providers matching this predicate. When set,
   * it fully controls the dropdown (overriding the default "models only" filter),
   * so auth-only providers like GitHub can be offered. Used by connect mode to
   * show only providers that can actually authenticate there.
   */
  providerFilter?: (providerId: string) => boolean;
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

    // After an account is added/logged-in: in connect mode the parent surface
    // owns the list (with its own remove + Done), so close instead of showing
    // the internal accounts list — which carries tray-join + "Get Started".
    const finishAccountChange = () => {
      if (options?.startInAddAccount) {
        overlay.remove();
        resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
      } else {
        renderAccountsList();
      }
    };

    // Decide initial view: list if accounts exist, tray-join or add-form if empty
    if (options?.startInAddAccount) {
      renderAccountForm();
    } else if (getAccounts().length > 0) {
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
          if (account.loggedOut) {
            detail.textContent = account.userName
              ? `Logged out — was ${account.userName}`
              : 'Logged out';
            detail.style.color = 'var(--s2-content-disabled)';
          } else if (account.userName) {
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

          // Logout/Login toggle — OAuth providers only
          if (config.isOAuth) {
            const isLoggedOut = account.loggedOut === true;
            const authBtn = document.createElement('button');
            authBtn.style.cssText = iconBtnStyle;
            if (isLoggedOut) {
              authBtn.setAttribute('aria-label', 'Log in');
              authBtn.setAttribute('title', 'Log in');
              authBtn.appendChild(svgIcon(ICON_PATHS.login));
              authBtn.addEventListener('mouseenter', () => {
                authBtn.style.color = 'var(--s2-accent)';
                authBtn.style.borderColor = 'var(--s2-accent)';
              });
              authBtn.addEventListener('mouseleave', () => {
                authBtn.style.color = 'var(--s2-content-secondary)';
                authBtn.style.borderColor = 'var(--s2-border-subtle)';
              });
              authBtn.addEventListener('click', async () => {
                const { createOAuthLauncher, createInterceptingOAuthLauncherForCurrentRuntime } =
                  await import('../providers/oauth-service.js');
                // Always force re-auth when reconnecting from a logged-out
                // state so providers with SSO (e.g. Adobe IMS) don't silently
                // re-authorize the previous account.
                const loginOptions = { forceReauth: true };
                if (config.onOAuthLoginIntercepted) {
                  const interceptingLauncher =
                    await createInterceptingOAuthLauncherForCurrentRuntime();
                  if (interceptingLauncher) {
                    await config.onOAuthLoginIntercepted(
                      interceptingLauncher,
                      renderAccountsList,
                      loginOptions
                    );
                  }
                } else if (config.onOAuthLogin) {
                  const launcher = createOAuthLauncher();
                  await config.onOAuthLogin(launcher, renderAccountsList, loginOptions);
                }
              });
            } else {
              authBtn.setAttribute('aria-label', 'Log out');
              authBtn.setAttribute('title', 'Log out');
              authBtn.appendChild(svgIcon(ICON_PATHS.logout));
              authBtn.addEventListener('mouseenter', () => {
                authBtn.style.color = 'var(--s2-warning, #f59e0b)';
                authBtn.style.borderColor = 'var(--s2-warning, #f59e0b)';
              });
              authBtn.addEventListener('mouseleave', () => {
                authBtn.style.color = 'var(--s2-content-secondary)';
                authBtn.style.borderColor = 'var(--s2-border-subtle)';
              });
              authBtn.addEventListener('click', async () => {
                await logoutOAuthAccount(account.providerId);
                renderAccountsList();
              });
            }
            actions.appendChild(authBtn);
          }

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
        // Placeholder so nothing is silently pre-selected — users must
        // explicitly pick a provider before any auth/key UI shows up.
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a provider…';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.hidden = true;
        providerSelect.appendChild(placeholder);

        const providers = getAvailableProviders();
        const existingProviders = new Set(getAccounts().map((a) => a.providerId));
        const sorted = [...providers].sort((a, b) => {
          const nameA = getProviderConfig(a).name;
          const nameB = getProviderConfig(b).name;
          return nameA.localeCompare(nameB);
        });
        for (const providerId of sorted) {
          if (existingProviders.has(providerId)) continue;
          if (options?.providerFilter) {
            // Caller-supplied filter fully controls the list (e.g. connect mode
            // offers GitHub — an auth-only provider — but hides ones that can't
            // authenticate there).
            if (!options.providerFilter(providerId)) continue;
          } else if (!providerOffersLlmModels(providerId)) {
            // Default: skip auth-only providers (no LLM models to expose) —
            // useful as existing accounts, but not something to "add" here.
            continue;
          }
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

      // OAuth login handler — calls the provider's onOAuthLogin callback with a generic launcher.
      // Device-flow providers (e.g. github-copilot) also receive a `presentDeviceCode` prompter
      // that renders the verification code inline in this dialog instead of via a floating overlay.
      const createDialogDeviceCodePrompter = (): DeviceCodePrompter => {
        const host = oauthSection;
        const status = oauthStatus;
        const loginBtn = oauthLoginBtn;
        return (input) =>
          new Promise<'continue' | 'cancel'>((resolve) => {
            // Hide the default login UI while the prompt is active so the
            // dialog only shows the code + the continue/cancel pair. The
            // original elements are restored on resolution.
            const wasLoginHidden = loginBtn.style.display;
            const wasStatusHidden = status.style.display;
            loginBtn.style.display = 'none';
            status.style.display = 'none';

            const prompt = document.createElement('div');
            prompt.setAttribute('data-slicc-device-code-prompt', '');
            prompt.style.cssText = 'display:flex;flex-direction:column;gap:8px';

            const label = document.createElement('div');
            label.className = 'dialog__desc';
            label.textContent = 'Verification code';
            label.style.cssText = 'font-size: 11px; color: var(--s2-content-tertiary);';

            const code = document.createElement('div');
            code.textContent = input.userCode;
            code.style.cssText = [
              'font: 600 22px ui-monospace, SFMono-Regular, Menlo, monospace',
              'letter-spacing: 2px',
              'color: var(--s2-content-primary, #e6edf3)',
              'background: var(--s2-bg-secondary, #161b22)',
              'border: 1px solid var(--s2-border, #30363d)',
              'border-radius: 6px',
              'padding: 10px 12px',
              'text-align: center',
              'user-select: all',
              'cursor: text',
            ].join(';');

            const hint = document.createElement('div');
            hint.className = 'dialog__desc';
            hint.style.cssText = 'font-size: 12px; color: var(--s2-content-secondary);';
            hint.textContent =
              'Click Copy & Continue — we will open the GitHub authorization page in a new tab. Paste this code there if it is not already filled in.';

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'dialog__btn';
            cancelBtn.textContent = 'Cancel';

            const continueBtn = document.createElement('button');
            continueBtn.type = 'button';
            continueBtn.className = 'dialog__btn dialog__btn--primary';
            continueBtn.textContent = 'Copy & Continue';

            const cleanup = () => {
              try {
                prompt.remove();
              } catch {
                /* already removed */
              }
              loginBtn.style.display = wasLoginHidden;
              status.style.display = wasStatusHidden;
            };

            cancelBtn.addEventListener('click', () => {
              cleanup();
              resolve('cancel');
            });
            continueBtn.addEventListener('click', () => {
              void (async () => {
                try {
                  await copyTextToClipboard(input.userCode);
                } catch {
                  /* user can still copy manually from the displayed code */
                }
                cleanup();
                status.style.display = wasStatusHidden;
                status.textContent = 'Waiting for you to authorize in the new tab…';
                resolve('continue');
              })();
            });

            row.appendChild(cancelBtn);
            row.appendChild(continueBtn);

            prompt.appendChild(label);
            prompt.appendChild(code);
            prompt.appendChild(hint);
            prompt.appendChild(row);
            host.appendChild(prompt);
          });
      };

      oauthLoginBtn.addEventListener('click', async () => {
        const pid = providerSelect.value;
        if (!pid) return;
        const providerConfig = getProviderConfig(pid);
        if (!providerConfig.onOAuthLogin && !providerConfig.onOAuthLoginIntercepted) return;

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
          if (providerConfig.onOAuthLoginIntercepted) {
            const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
              '../providers/oauth-service.js'
            );
            const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
            if (!launcher) {
              throw new Error(
                'No controlled-browser CDP transport available — open SLICC in standalone mode or the Chrome extension.'
              );
            }
            await providerConfig.onOAuthLoginIntercepted(launcher, finishAccountChange, {
              presentDeviceCode: createDialogDeviceCodePrompter(),
            });
          } else if (providerConfig.onOAuthLogin) {
            const { createOAuthLauncher } = await import('../providers/oauth-service.js');
            const launcher = createOAuthLauncher();
            await providerConfig.onOAuthLogin(launcher, finishAccountChange);
          }
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
        if (!pid) {
          // Placeholder state — hide everything so the dialog only shows
          // the dropdown until the user makes a choice.
          providerDesc.textContent = '';
          oauthSection.style.display = 'none';
          apiKeySection.style.display = 'none';
          baseUrlSection.style.display = 'none';
          deploymentSection.style.display = 'none';
          apiVersionSection.style.display = 'none';
          saveBtn.style.display = 'none';
          return;
        }
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

        finishAccountChange();
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
      if (options?.startInAddAccount) {
        // Connect mode: the parent surface owns the account list, and tray-join
        // is irrelevant here — offer a plain close instead of "Back"/"Connect to
        // another browser" (both of which dropped users into confusing views).
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'dialog__btn dialog__btn--secondary';
        cancelBtn.style.marginTop = '8px';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
          overlay.remove();
          resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
        });
        dialog.appendChild(cancelBtn);
      } else if (!isEdit && !hasAccounts) {
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
          dispatchTrayJoinWithFailureFeedback(stored.joinUrl, statusEl);
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        // 800 ms is fast feedback for the success path; failure
        // surfaces sooner via `slicc:tray-join-failed` and the
        // listener inside `dispatchTrayJoinWithFailureFeedback`
        // cancels this timer.
        const dismissTimer = setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
        statusEl.dataset.dismissTimer = String(dismissTimer);
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
          dispatchTrayJoinWithFailureFeedback(stored.joinUrl, statusEl);
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        // See note above the other dispatch site \u2014 the listener
        // inside `dispatchTrayJoinWithFailureFeedback` cancels this
        // timer if a failure event arrives.
        const dismissTimer = setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
        statusEl.dataset.dismissTimer = String(dismissTimer);
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
