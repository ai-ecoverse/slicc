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

import {
  bedrockCampRegionFromBaseUrl,
  isBedrockCampClaudeModel,
  isBedrockCampCompatible,
} from './built-in/bedrock-camp-compat.js';
import {
  BEDROCK_CAMP_EXTRA_MODELS,
  mergeBedrockCampCatalogue,
} from './built-in/bedrock-camp-extra-models.js';
import { findFamilyCost } from './family-cost.js';
import {
  getRegisteredProviderConfig,
  getRegisteredProviderIds,
  shouldIncludeProvider,
} from './index.js';
import {
  getActiveModelPolicy,
  isModelAllowedByPolicy,
  isModelDeniedByPolicy,
  MODELS_POLICY_FILE,
  policyHintFor,
} from './model-policy.js';
import type { CompatOverrides } from './types.js';

export type { ProviderConfig } from './index.js';

import type { ProviderConfig } from './index.js';

const getModelDynamic = getModel as (provider: string, modelId: string) => Model<Api>;

const getModelsDynamic = getModels as (provider: string) => Model<Api>[];

export const ACCOUNTS_KEY = 'slicc_accounts';
const MODEL_KEY = 'selected-model';

const LEGACY_KEYS = [
  'slicc_provider',
  'slicc_api_key',
  'slicc_base_url',
  'anthropic_api_key',
  'api_provider',
  'azure_resource',
  'bedrock_region',
] as const;

const LEGACY_AUTH_ONLY_PROVIDERS = new Set(['github']);

function isBuildExcludedPiProvider(providerId: string): boolean {
  let piProviders: string[];
  try {
    piProviders = getProviders() as string[];
  } catch {
    return false;
  }
  return piProviders.includes(providerId) && !shouldIncludeProvider(providerId);
}

export interface Account {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;

  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  userAvatar?: string;
  maskedValue?: string;

  scopes?: string;

  loggedOut?: boolean;
}

let LegacyCleaned = false;
function cleanLegacyKeys(): void {
  if (LegacyCleaned) return;
  LegacyCleaned = true;
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {}
  }
  migrateLegacyAuthOnlySelection();
}

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
  } catch {}

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
  } catch {}
}

function ResetLegacyCleanup(): void {
  LegacyCleaned = false;
}

export const __test__ = { _resetLegacyCleanup: ResetLegacyCleanup };

export function getAvailableProviders(): string[] {
  const piProviders = (getProviders() as string[]).filter(shouldIncludeProvider);
  const registeredIds = getRegisteredProviderIds();
  const merged = new Set([...piProviders, ...registeredIds]);
  return [...merged].filter((id) => !getRegisteredProviderConfig(id)?.hidden);
}

export function providerOffersLlmModels(providerId: string): boolean {
  try {
    if (getProviderModels(providerId).length > 0) return true;
  } catch {}
  try {
    const piModels = (getModels as (id: string) => unknown[])(providerId);
    if (piModels.length > 0) return true;
  } catch {}
  const cfg = getRegisteredProviderConfig(providerId);
  if (cfg?.modelOverrides && Object.keys(cfg.modelOverrides).length > 0) return true;
  return false;
}

function providerOffersModelId(providerId: string, modelId: string): boolean {
  try {
    if (getProviderModels(providerId).some((m) => m.id === modelId)) return true;
  } catch {}
  try {
    const piModels = (getModels as (id: string) => { id: string }[])(providerId);
    if (piModels.some((m) => m.id === modelId)) return true;
  } catch {}
  const cfg = getRegisteredProviderConfig(providerId);
  if (cfg?.modelOverrides && Object.hasOwn(cfg.modelOverrides, modelId)) return true;
  return false;
}

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

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface MutableModel {
  id?: string;
  name?: string;
  provider?: string;
  api?: Api;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  compat?: CompatOverrides;
  thinkingLevelMap?: Record<string, string | null>;

  [field: string]: unknown;
}

function applyModelMetadata(
  model: MutableModel,
  metadata: {
    context_window?: number;
    max_tokens?: number;
    reasoning?: boolean;
    input?: string[];
    cost?: ModelCost;
    compat?: CompatOverrides;
    thinkingLevelMap?: Record<string, string | null>;
  }
): void {
  if (metadata.context_window !== undefined) model.contextWindow = metadata.context_window;
  if (metadata.max_tokens !== undefined) model.maxTokens = metadata.max_tokens;
  if (metadata.reasoning !== undefined) model.reasoning = metadata.reasoning;
  if (metadata.input !== undefined) model.input = metadata.input;

  if (metadata.cost !== undefined) {
    model.cost = metadata.cost;
    model.inputCost = metadata.cost.input;
    model.outputCost = metadata.cost.output;
    model.cacheReadCost = metadata.cost.cacheRead;
    model.cacheWriteCost = metadata.cost.cacheWrite;
  }

  if (metadata.compat !== undefined) {
    model.compat = {
      ...(model.compat ?? {}),
      ...metadata.compat,
    } as CompatOverrides;
  }

  if (metadata.thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = {
      ...(model.thinkingLevelMap ?? {}),
      ...metadata.thinkingLevelMap,
    };
  }
}

export function getProviderModels(providerId: string): Model<Api>[] {
  try {
    if (providerId === 'bedrock-camp') {
      const region = bedrockCampRegionFromBaseUrl(getBaseUrlForProvider('bedrock-camp'));
      return mergeBedrockCampCatalogue(
        getModelsDynamic('amazon-bedrock'),
        BEDROCK_CAMP_EXTRA_MODELS as unknown as Model<Api>[]
      )
        .filter((m) => isBedrockCampCompatible(m, region))
        .map((m) => ({
          ...m,
          api: 'bedrock-camp-converse' as Api,
          provider: 'bedrock-camp',

          reasoning: m.reasoning === true && isBedrockCampClaudeModel(m),
        }));
    }

    const providerConfig = getProviderConfig(providerId);
    if (providerConfig.getModelIds) {
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

      const modelMap = new Map<string, Model<Api>>();
      for (const p of getProviders() as string[]) {
        try {
          for (const m of getModelsDynamic(p)) modelMap.set(m.id, m);
        } catch {}
      }
      return modelIds.map((pm) => {
        const apiType = pm.api === 'openai' ? 'openai' : 'anthropic';
        const customApi = `${providerId}-${apiType}` as Api;
        const base = modelMap.get(pm.id);
        let model: MutableModel;
        if (base) {
          model = { ...base, api: customApi, provider: providerId };
        } else {
          model = buildProviderRoutedModel(providerId, pm.id, '', customApi) as MutableModel;
          if (pm.name) model.name = pm.name;

          if (apiType === 'anthropic') {
            const familyCost = findFamilyCost(pm.id, modelMap);
            model.cost = familyCost;
            model.inputCost = familyCost.input;
            model.outputCost = familyCost.output;
            model.cacheReadCost = familyCost.cacheRead;
            model.cacheWriteCost = familyCost.cacheWrite;
          }
        }

        const overrides = providerConfig.modelOverrides?.[pm.id];
        if (overrides) applyModelMetadata(model, overrides);
        applyModelMetadata(model, pm);

        return model as unknown as Model<Api>;
      });
    }
    if (providerConfig.isOAuth) {
      const anthropicModels = getModelsDynamic('anthropic');
      const customApi = `${providerId}-anthropic` as Api;
      return anthropicModels.map((m) => {
        const model: MutableModel = { ...m, api: customApi, provider: providerId };
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

export function getOAuthAccountInfo(providerId: string): {
  token: string;
  maskedValue?: string;
  expiresAt?: number;
  userName?: string;
  userAvatar?: string;
  scopes?: string;
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
    scopes: account.scopes,
    expired,
  };
}

export interface ProviderDefault {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const providerFiles = import.meta.glob('/packages/webapp/providers.json', {
  eager: true,
  import: 'default',
}) as Record<string, ProviderDefault[]>;

const providerDefaults: ProviderDefault[] = providerFiles['/packages/webapp/providers.json'] ?? [];

const log = createLogger('provider-settings');

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

export interface GroupedModels {
  providerId: string;
  providerName: string;
  models: Model<Api>[];
}

const PICKER_HIDDEN_MODEL_PATTERNS: RegExp[] = [/haiku/i];

export function isModelHiddenFromPicker(modelId: string): boolean {
  return PICKER_HIDDEN_MODEL_PATTERNS.some((re) => re.test(modelId));
}

function pickerVisible<T extends { id: string }>(models: T[]): T[] {
  return models.filter((m) => !isModelHiddenFromPicker(m.id));
}

export function policyVisible<T extends { id: string }>(models: T[], providerId: string): T[] {
  const selected = safeSelectedProvider();
  if (selected === null) return models;
  const policy = getActiveModelPolicy();
  return models.filter((m) => !isModelDeniedByPolicy(policy, selected, providerId, m.id));
}

export function getAllAvailableModels(): GroupedModels[] {
  const accounts = getAccounts();
  if (accounts.length === 0) return [];
  const seen = new Map<string, GroupedModels>();
  for (const account of accounts) {
    if (seen.has(account.providerId)) continue;
    const config = getProviderConfig(account.providerId);

    if (config.hidden) continue;

    if (isBuildExcludedPiProvider(account.providerId)) continue;
    const models = policyVisible(
      pickerVisible(getProviderModels(account.providerId)),
      account.providerId
    );
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

export function getAlternativeModelProviders(excludeProviderId?: string | null): string[] {
  return getAllAvailableModels()
    .map((group) => group.providerId)
    .filter((id) => id !== excludeProviderId);
}

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
      const resp = await callSecretsBridge<{ ok?: boolean; error?: string } | undefined>(
        'secrets.delete',
        { name: `oauth.${providerId}.token` }
      );
      if (resp?.error) {
        log.error('Bridge secrets.delete returned error', { providerId, error: resp.error });
      }
    } else if (topology === 'connect') {
    } else {
      const r = await fetch(resolveApiUrl(`/api/secrets/oauth/${providerId}`), {
        method: 'DELETE',
        headers: apiHeaders(),
      });

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
  const accountToRemove = getAccounts().find((a) => a.providerId === providerId);
  const configToRemove = getProviderConfig(providerId);
  if (accountToRemove && configToRemove?.isOAuth) {
    await logoutOAuthAccount(providerId);
  }

  await deleteOAuthReplica(providerId);

  await saveAccountsAsync(getAccounts().filter((a) => a.providerId !== providerId));

  const raw = localStorage.getItem(MODEL_KEY) ?? '';
  const sep = raw.indexOf(':');
  if (sep > 0 && raw.slice(0, sep) === providerId) {
    localStorage.removeItem(MODEL_KEY);
  }
}

export async function logoutOAuthAccount(providerId: string): Promise<void> {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account) return;
  const providerConfig = getProviderConfig(providerId);
  if (!providerConfig?.isOAuth) return;

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

  await deleteOAuthReplica(providerId);
}

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

export type OAuthMaskWriteResult = { maskedValue?: string; error?: string };

const MASK_TOKEN_ROTATED = 'access token rotated during mask write';

function attachMaskIfTokenUnchanged(
  providerId: string,
  accessToken: string,
  maskedValue: string,
  accounts: Account[]
): OAuthMaskWriteResult {
  const acct = accounts.find((a) => a.providerId === providerId);
  if (!acct?.accessToken) {
    return { error: 'account gone after mask write' };
  }
  if (acct.accessToken !== accessToken) {
    log.warn('OAuth mask write raced with token rotation; discarding replica', {
      providerId,
    });
    return { error: MASK_TOKEN_ROTATED };
  }
  acct.maskedValue = maskedValue;
  return { maskedValue };
}

export function isUsableOAuthMaskReplica(
  masked: string | undefined,
  accessToken: string
): masked is string {
  return Boolean(masked) && masked !== accessToken;
}

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
): Promise<OAuthMaskWriteResult> {
  const payload = {
    providerId: opts.providerId,
    accessToken: opts.accessToken,
    domains: opts.domains.join(','),
  };
  const { maskedValue, lastError } = await maskOAuthTokenWithRetry(
    () => deps.sendMaskRequest(payload),
    maskOpts
  );
  if (!isUsableOAuthMaskReplica(maskedValue, opts.accessToken)) {
    const reason = !maskedValue
      ? (lastError ?? 'no error reported (cold SW or empty reply)')
      : 'mask replica equals the access token';
    log.error('OAuth mask give-up: no masked value after retries', {
      providerId: opts.providerId,
      reason,
    });
    return { error: reason };
  }
  const accounts = deps.getAccounts();
  const attached = attachMaskIfTokenUnchanged(
    opts.providerId,
    opts.accessToken,
    maskedValue,
    accounts
  );
  if (attached.maskedValue) await deps.saveAccounts(accounts);
  return attached;
}

function oauthMaskDomains(providerId: string): string[] {
  const defaults = getProviderConfig(providerId).oauthTokenDomains ?? [];
  const extras = getExtraOAuthDomains(providerId);
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const d of [...defaults, ...extras]) {
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    domains.push(d);
  }
  return domains;
}

type MaskRequestPayload = { providerId: string; accessToken: string; domains: string };

function sendExtensionDirectMaskRequest(
  payload: MaskRequestPayload
): Promise<OAuthMaskWriteResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'secrets.mask-oauth-token', ...payload }, (r: unknown) => {
      if (chrome.runtime.lastError) {
        log.error('SW mask-oauth-token transport failed', {
          providerId: payload.providerId,
          error: chrome.runtime.lastError.message,
        });
      }

      const response =
        typeof r === 'object' && r !== null ? (r as OAuthMaskWriteResult) : undefined;
      if (response?.error) {
        log.warn('SW mask-oauth-token returned error', {
          providerId: payload.providerId,
          error: response.error,
        });
      }
      resolve(response ?? {});
    });
  });
}

function sendExtensionDelegateMaskRequest(
  payload: MaskRequestPayload
): Promise<OAuthMaskWriteResult> {
  return callSecretsBridge<OAuthMaskWriteResult | undefined>('secrets.mask-oauth-token', payload)
    .then((r) => {
      if (r?.error) {
        log.warn('Bridge mask-oauth-token returned error', {
          providerId: payload.providerId,
          error: r.error,
        });
      }
      return r ?? {};
    })
    .catch((err) => {
      log.error('Bridge mask-oauth-token transport failed', {
        providerId: payload.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    });
}

async function persistCliMaskReplica(
  providerId: string,
  accessToken: string,
  domains: string[]
): Promise<OAuthMaskWriteResult> {
  const url = resolveApiUrl('/api/secrets/oauth-update');
  const r = await fetch(url, {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ providerId, accessToken, domains }),
  });
  if (!r.ok) {
    log.warn('OAuth replica POST non-ok', { providerId, status: r.status, url });
    return { error: `OAuth replica POST HTTP ${r.status}` };
  }
  const data = await r.json();
  if (typeof data.maskedValue !== 'string') {
    log.warn('OAuth replica POST ok but missing maskedValue', { providerId, url });
    return { error: 'OAuth replica POST ok but missing maskedValue' };
  }
  if (!isUsableOAuthMaskReplica(data.maskedValue, accessToken)) {
    log.error('OAuth mask replica equals the access token; refusing to persist', { providerId });
    return { error: 'mask replica equals the access token' };
  }
  const accounts = getAccounts();
  const attached = attachMaskIfTokenUnchanged(providerId, accessToken, data.maskedValue, accounts);
  if (attached.maskedValue) await saveAccountsAsync(accounts);
  return attached;
}

async function writeOAuthMaskReplica(
  providerId: string,
  accessToken: string
): Promise<OAuthMaskWriteResult> {
  const result = await writeOAuthMaskReplicaOnce(providerId, accessToken);
  if (result.error !== MASK_TOKEN_ROTATED) return result;
  const current = getAccounts().find((a) => a.providerId === providerId)?.accessToken;
  if (!current || current === accessToken) return result;
  return writeOAuthMaskReplicaOnce(providerId, current);
}

async function writeOAuthMaskReplicaOnce(
  providerId: string,
  accessToken: string
): Promise<OAuthMaskWriteResult> {
  const domains = oauthMaskDomains(providerId);
  if (domains.length === 0) {
    return { error: 'no oauth token domains configured' };
  }
  const topology = resolveSecretTopology();
  try {
    if (topology === 'extension-direct') {
      return persistOAuthMaskViaServiceWorker(
        { providerId, accessToken, domains },
        {
          sendMaskRequest: sendExtensionDirectMaskRequest,
          getAccounts,
          saveAccounts: saveAccountsAsync,
        }
      );
    }
    if (topology === 'extension-delegate') {
      return persistOAuthMaskViaServiceWorker(
        { providerId, accessToken, domains },
        {
          sendMaskRequest: sendExtensionDelegateMaskRequest,
          getAccounts,
          saveAccounts: saveAccountsAsync,
        }
      );
    }
    if (topology === 'connect') {
      return { error: 'no replica store in connect mode' };
    }
    return await persistCliMaskReplica(providerId, accessToken, domains);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('OAuth replica sync failed', { providerId, topology, error });
    return { error };
  }
}

export async function ensureOAuthMaskReplica(providerId: string): Promise<OAuthMaskWriteResult> {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account?.accessToken) {
    return { error: 'no access token held' };
  }
  if (isUsableOAuthMaskReplica(account.maskedValue, account.accessToken)) {
    return { maskedValue: account.maskedValue };
  }
  return writeOAuthMaskReplica(providerId, account.accessToken);
}

function resolveStoredScopes(
  opts: { accessToken: string; scopes?: string },
  existing: Account | undefined
): string | undefined {
  if (!opts.accessToken) return undefined;
  return 'scopes' in opts ? opts.scopes : existing?.scopes;
}

export async function saveOAuthAccount(opts: {
  providerId: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  userAvatar?: string;
  baseUrl?: string;

  scopes?: string;
}): Promise<void> {
  const existing = getAccounts().find((a) => a.providerId === opts.providerId);
  const accounts = getAccounts().filter((a) => a.providerId !== opts.providerId);
  accounts.push({
    providerId: opts.providerId,
    apiKey: '',
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    tokenExpiresAt: opts.tokenExpiresAt,
    userName: opts.userName,
    userAvatar: opts.userAvatar,
    baseUrl: opts.baseUrl ?? existing?.baseUrl,
    scopes: resolveStoredScopes(opts, existing),
  });

  await saveAccountsAsync(accounts);

  await writeOAuthMaskReplica(opts.providerId, opts.accessToken);
}

const OPTIONAL_API_KEY_PLACEHOLDER = 'local';

export function getRawApiKeyForProvider(providerId: string): string | null {
  const account = getAccounts().find((a) => a.providerId === providerId);
  if (!account) return null;

  return account.accessToken || account.apiKey || null;
}

export function getApiKeyForProvider(providerId: string): string | null {
  const account = getAccounts().find((a) => a.providerId === providerId);

  if (!account) return null;
  const stored = account.accessToken || account.apiKey;
  if (stored) return stored;

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

export function getSelectedModelId(): string {
  const raw = localStorage.getItem(MODEL_KEY) || '';

  const idx = raw.indexOf(':');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

export function setSelectedModelId(modelId: string): void {
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

  const provider = getSelectedProvider();
  localStorage.setItem(MODEL_KEY, `${provider}:${modelId}`);
}

function getRawSelectedModel(): string {
  return localStorage.getItem(MODEL_KEY) || '';
}

export function getSelectedProvider(): string {
  const raw = getRawSelectedModel();
  const idx = raw.indexOf(':');
  if (idx > 0) return raw.slice(0, idx);

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

  localStorage.setItem(MODEL_KEY, modelId);
}

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

export async function clearAllSettings(): Promise<void> {
  const accounts = getAccounts();
  await Promise.allSettled(accounts.map((a) => removeAccount(a.providerId)));
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(MODEL_KEY);
  for (const key of LEGACY_KEYS) {
    localStorage.removeItem(key);
  }
}

function inferProviderApiType(modelId: string): 'anthropic' | 'openai' {
  return /^(?:gpt[-.]?|o[0-9]|chatgpt)/i.test(modelId) ? 'openai' : 'anthropic';
}

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

function resolveEffectiveProvider(providerId: string, providerConfig: ProviderConfig): string {
  if (providerConfig.isOAuth) return 'anthropic';
  if (providerId === 'azure-ai-foundry') return 'anthropic';
  if (providerId === 'bedrock-camp') return 'amazon-bedrock';
  return providerId;
}

export function getModelCatalogProviderIds(): string[] {
  const ids = new Set<string>();
  for (const account of getAccounts()) {
    if (account.loggedOut) continue;
    ids.add(account.providerId);
    ids.add(resolveEffectiveProvider(account.providerId, getProviderConfig(account.providerId)));
  }
  return [...ids];
}

function providerCatalogueModel(
  providerId: string,
  modelId: string,
  baseUrl: string | null
): Model<Api> | null {
  const providerModel = getProviderModels(providerId).find((m) => m.id === modelId);
  if (!providerModel) return null;
  return baseUrl ? { ...providerModel, baseUrl } : providerModel;
}

function applyProviderRouting(
  resolved: Model<Api>,
  providerId: string,
  providerConfig: ProviderConfig,
  modelId: string
): Model<Api> {
  if (providerConfig.isOAuth) {
    const providerModel = getProviderModels(providerId).find((m) => m.id === modelId);
    if (providerModel) return providerModel;
    return { ...resolved, api: `${providerId}-anthropic` as Api, provider: providerId };
  }
  if (providerId === 'bedrock-camp') {
    return { ...resolved, api: 'bedrock-camp-converse' as Api, provider: 'bedrock-camp' };
  }
  return resolved;
}

function resolveUnknownModelId(
  providerId: string,
  providerConfig: ProviderConfig,
  modelId: string,
  baseUrl: string | null,
  pinned: boolean
): Model<Api> {
  const catalogueModel = providerCatalogueModel(providerId, modelId, baseUrl);
  if (catalogueModel) return catalogueModel;
  if (providerConfig.isOAuth) {
    return buildProviderRoutedModel(providerId, modelId, baseUrl);
  }

  if (pinned) {
    throw new Error(`Model ${modelId} is not available from provider ${providerId}`);
  }
  return resolveCurrentModel();
}

export function resolveModelById(modelId?: string, explicitProviderId?: string): Model<Api> {
  if (!modelId) return resolveCurrentModel();

  const providerId = explicitProviderId ?? getSelectedProvider();
  const baseUrl = getBaseUrlForProvider(providerId);
  const providerConfig = getProviderConfig(providerId);

  if (explicitProviderId !== undefined) {
    const pinnedModel = providerCatalogueModel(providerId, modelId, baseUrl);
    if (pinnedModel) return pinnedModel;
  }

  try {
    const effectiveProvider = resolveEffectiveProvider(providerId, providerConfig);
    const model = getModelDynamic(effectiveProvider, modelId);
    if (!model?.id) throw new Error(`Model ${modelId} not found`);
    const resolved = applyProviderRouting(model, providerId, providerConfig, modelId);
    return baseUrl ? { ...resolved, baseUrl } : resolved;
  } catch (err) {
    log.debug('resolveModelById: pi-ai lookup miss, using provider fallback', {
      providerId,
      modelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return resolveUnknownModelId(
      providerId,
      providerConfig,
      modelId,
      baseUrl,
      explicitProviderId !== undefined
    );
  }
}

export function modelRunsOnProvider(model: Model<Api>, providerId: string): boolean {
  if (model.provider === providerId) return true;
  return model.provider === resolveEffectiveProvider(providerId, getProviderConfig(providerId));
}

export function resolveCurrentModel(): Model<Api> {
  const providerId = getSelectedProvider();
  const modelId = getSelectedModelId();
  const baseUrl = getBaseUrlForProvider(providerId);

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

    if (providerConfig.isOAuth) {
      const providerModel = models.find((m) => m.id === effectiveModelId);
      if (providerModel) {
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
    log.debug('resolveCurrentModel: pi-ai lookup miss, using provider fallback', {
      providerId,
      effectiveModelId,
      error: err instanceof Error ? err.message : String(err),
    });

    const customModel = models.find((m) => m.id === effectiveModelId);
    if (customModel) {
      return baseUrl ? { ...customModel, baseUrl } : customModel;
    }

    if (providerConfig.isOAuth) {
      return buildProviderRoutedModel(providerId, effectiveModelId, baseUrl);
    }

    return getModelDynamic('anthropic', 'claude-sonnet-4-0');
  }
}

export function resolveModelByShorthand(input: string): string | null {
  const keyword = input.toLowerCase();
  if (!keyword) return null;

  let selectedProvider: string | null = null;
  try {
    selectedProvider = getSelectedProvider();
  } catch {}

  if (selectedProvider !== null) {
    const preferred = bestShorthandMatch(keyword, [selectedProvider]);
    if (preferred !== null) return preferred;
  }
  return bestShorthandMatch(
    keyword,
    getAccounts().map((a) => a.providerId)
  );
}

function bestShorthandMatch(keyword: string, providerIds: string[]): string | null {
  let bestId: string | null = null;
  let bestContextWindow = -1;

  for (const providerId of providerIds) {
    for (const model of getProviderModels(providerId)) {
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

export interface ScoopModelSelection {
  modelId: string;

  providerId: string;
}

export type ScoopModelResolution =
  | { ok: true; selection: ScoopModelSelection }
  | { ok: false; error: string };

function configuredProviderIds(): string[] {
  const ids: string[] = [];
  try {
    for (const account of getAccounts()) {
      if (!ids.includes(account.providerId)) ids.push(account.providerId);
    }
  } catch {}
  try {
    const selected = getSelectedProvider();
    if (!ids.includes(selected)) ids.push(selected);
  } catch {}
  return ids;
}

function splitQualifiedModelId(
  input: string
): { providerId: string; modelId: string; configured: boolean } | null {
  const idx = input.indexOf(':');
  if (idx <= 0 || idx === input.length - 1) return null;
  const providerId = input.slice(0, idx);
  const modelId = input.slice(idx + 1);
  const configured = configuredProviderIds().includes(providerId);
  if (configured) return { providerId, modelId, configured };
  let known = false;
  try {
    known = getAvailableProviders().includes(providerId);
  } catch {}
  return known ? { providerId, modelId, configured: false } : null;
}

function selectModelFromProvider(
  input: string,
  providerId: string,
  allowShorthand = true
): ScoopModelSelection | null {
  const candidates = [input];
  const alias = allowShorthand ? bestShorthandMatch(input.toLowerCase(), [providerId]) : null;
  if (alias !== null && alias !== input) candidates.push(alias);

  let catalogue: Model<Api>[] = [];
  try {
    catalogue = getProviderModels(providerId);
  } catch {}

  for (const candidate of candidates) {
    if (catalogue.length > 0 && !catalogue.some((m) => m.id === candidate)) continue;
    try {
      if (resolveModelById(candidate, providerId).id === candidate) {
        return { modelId: candidate, providerId };
      }
    } catch (err) {
      log.debug('selectModelFromProvider: candidate did not resolve', {
        input,
        candidate,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return null;
}

function qualifiedList(selections: readonly ScoopModelSelection[]): string {
  return selections.map((s) => `${s.providerId}:${s.modelId}`).join(', ');
}

export function resolveModelSelectionForScoop(input: string): ScoopModelResolution {
  if (!input) return { ok: false, error: 'unknown model: (empty)' };

  const qualified = splitQualifiedModelId(input);
  if (qualified) return resolveQualifiedSelection(input, qualified);

  let selectedProvider: string | null = null;
  try {
    selectedProvider = getSelectedProvider();
  } catch {}
  if (selectedProvider !== null) {
    const selection = selectModelFromProvider(input, selectedProvider);
    if (selection) return applyModelPolicy(selection);
  }
  return resolveCrossProviderSelection(input, selectedProvider);
}

function safeSelectedProvider(): string | null {
  try {
    return getSelectedProvider();
  } catch {
    return null;
  }
}

function policyPermits(selection: ScoopModelSelection): boolean {
  const selected = safeSelectedProvider();

  if (selected === null) return true;
  return isModelAllowedByPolicy(
    getActiveModelPolicy(),
    selected,
    selection.providerId,
    selection.modelId
  );
}

function policyRejection(selection: ScoopModelSelection): ScoopModelResolution {
  const selected = safeSelectedProvider() ?? '<none>';
  const qualified = `${selection.providerId}:${selection.modelId}`;
  return {
    ok: false,
    error: `model not allowed: ${qualified} is blocked by ${MODELS_POLICY_FILE} while "${selected}" is selected — ${policyHintFor(selected, selection.providerId, selection.modelId)}`,
  };
}

function applyModelPolicy(selection: ScoopModelSelection): ScoopModelResolution {
  return policyPermits(selection) ? { ok: true, selection } : policyRejection(selection);
}

function resolveQualifiedSelection(
  input: string,
  qualified: { providerId: string; modelId: string; configured: boolean }
): ScoopModelResolution {
  if (!qualified.configured) {
    const configured = configuredProviderIds();
    return {
      ok: false,
      error:
        `unknown model: ${input} (provider "${qualified.providerId}" is not configured` +
        `${configured.length > 0 ? `; configured: ${configured.join(', ')}` : ''})`,
    };
  }
  const selection = selectModelFromProvider(qualified.modelId, qualified.providerId);
  if (selection) return applyModelPolicy(selection);
  return {
    ok: false,
    error: `unknown model: ${input} (provider "${qualified.providerId}" does not offer "${qualified.modelId}")`,
  };
}

function resolveCrossProviderSelection(
  input: string,
  selectedProvider: string | null
): ScoopModelResolution {
  const others = configuredProviderIds().filter((id) => id !== selectedProvider);
  for (const tier of ['exact', 'shorthand'] as const) {
    const found: ScoopModelSelection[] = [];
    for (const providerId of others) {
      const candidate =
        tier === 'exact' ? input : bestShorthandMatch(input.toLowerCase(), [providerId]);
      if (candidate === null) continue;
      const selection = selectModelFromProvider(candidate, providerId, false);
      if (selection) found.push(selection);
    }

    const matches = found.filter(policyPermits);
    if (matches.length === 0 && found.length > 0) return policyRejection(found[0]);
    if (matches.length === 1) return { ok: true, selection: matches[0] };
    if (matches.length > 1) {
      return {
        ok: false,
        error: `ambiguous model: ${input} matches ${qualifiedList(matches)} — qualify it as provider:model`,
      };
    }
  }
  return { ok: false, error: `unknown model: ${input}` };
}

export function resolveModelIdForScoop(input: string): string | null {
  const resolution = resolveModelSelectionForScoop(input);
  return resolution.ok ? resolution.selection.modelId : null;
}

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
