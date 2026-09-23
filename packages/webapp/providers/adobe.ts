import type {
  AnthropicOptions,
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  OpenAICompletionsCompat,
  OpenAICompletionsOptions,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamAnthropic,
  streamOpenAICompletions,
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/compat';
import { getModels, getProviders } from '../src/core/model-catalog.js';
import { getPanelRpcClient } from '../src/kernel/panel-rpc.js';
import { withAdaptiveThinkingShim } from '../src/providers/adaptive-thinking.js';
import {
  type AdobeModelMetadata,
  type EnrichedAdobeModel,
  enrichAdobeModel,
} from '../src/providers/adobe-model-metadata.js';
import { buildAdobeOAuthState } from '../src/providers/adobe-oauth-state.js';
import { fetchAdobeUsage } from '../src/providers/adobe-usage.js';
import { clearBudgetWindowCache } from '../src/providers/budget-usage-source.js';
import { findFamilyCost } from '../src/providers/family-cost.js';
import { getOAuthPageOrigin } from '../src/providers/oauth-service.js';
import type { ProviderBudgetWindow } from '../src/providers/provider-budget.js';
import { createSilentRenewBackoff } from '../src/providers/silent-renew-backoff.js';
import { withSupportedTemperature } from '../src/providers/temperature-support.js';
import type {
  OAuthLauncher,
  OAuthLoginOptions,
  OAuthTokenValidation,
  ProviderConfig,
} from '../src/providers/types.js';
import { getDailyAdobeUuid } from '../src/scoops/llm-session-id.js';
import {
  getAccounts,
  getBaseUrlForProvider,
  saveOAuthAccount,
} from '../src/ui/provider-settings.js';

interface AdobeConfig {
  clientId: string;
  proxyEndpoint: string;
  scopes: string;

  imsEnvironment?: string;

  redirectUri?: string;

  extensionRedirectUri?: string;
}

const configFiles = import.meta.glob('/packages/webapp/providers/adobe-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, AdobeConfig>;

const adobeConfig: AdobeConfig = configFiles['/packages/webapp/providers/adobe-config.json'] ?? {
  clientId: '',
  proxyEndpoint: '',
  scopes: 'openid,profile,email',
};

function getProxyEndpoint(): string {
  const runtimeUrl = getBaseUrlForProvider('adobe');
  if (runtimeUrl) return runtimeUrl.replace(/\/$/, '');
  if (adobeConfig.proxyEndpoint) return adobeConfig.proxyEndpoint.replace(/\/$/, '');
  throw new Error('Adobe proxy endpoint not configured — set it in Settings or adobe-config.json');
}

interface ProxyConfig {
  clientId?: string;
  scopes?: string;
  imsEnvironment?: string;

  models?: AdobeModelMetadata[];
}

const proxyConfigCache = new Map<string, ProxyConfig>();

const proxyMetadataCache = new Map<string, AdobeModelMetadata>();

const ADOBE_MODELS_KEY = 'slicc-adobe-models';

function persistAdobeModels(models: EnrichedAdobeModel[]): void {
  try {
    localStorage.setItem(ADOBE_MODELS_KEY, JSON.stringify(models));
  } catch {}
}

async function attemptFetchProxyConfig(proxyEndpoint: string): Promise<ProxyConfig | null> {
  try {
    const res = await fetch(`${proxyEndpoint}/v1/config`, {
      headers: { [SLICC_VERSION_HEADER]: __SLICC_VERSION__ },
    });
    if (res.ok) return (await res.json()) as ProxyConfig;
    console.warn(`[adobe] Proxy /v1/config returned ${res.status}`);
    return null;
  } catch (err) {
    console.warn(
      '[adobe] Failed to fetch proxy config:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

async function fetchProxyConfig(proxyEndpoint: string): Promise<ProxyConfig> {
  const cached = proxyConfigCache.get(proxyEndpoint);
  if (cached) return cached;
  let config = await attemptFetchProxyConfig(proxyEndpoint);
  if (!config) {
    await new Promise<void>((r) => setTimeout(r, 600));
    config = await attemptFetchProxyConfig(proxyEndpoint);
  }
  if (config) {
    proxyConfigCache.set(proxyEndpoint, config);
    return config;
  }

  return {};
}

function resolveClientId(proxyConfig: ProxyConfig): string {
  const clientId = proxyConfig.clientId || adobeConfig.clientId;
  if (!clientId)
    throw new Error(
      'Could not determine IMS client ID — proxy /v1/config did not return one and adobe-config.json is empty'
    );
  return clientId;
}

function resolveScopes(proxyConfig: ProxyConfig): string {
  return proxyConfig.scopes || adobeConfig.scopes;
}

function resolveImsEnvironment(proxyConfig: ProxyConfig): string {
  return proxyConfig.imsEnvironment || adobeConfig.imsEnvironment || 'prod';
}

const IMS_HOSTS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

function imsHost(env?: string): string {
  return IMS_HOSTS[env ?? adobeConfig.imsEnvironment ?? 'prod'] ?? IMS_HOSTS.prod;
}

const VALIDATE_TIMEOUT_MS = 10_000;

const VALIDATE_CONFIG_TIMEOUT_MS = 5_000;

async function resolveValidationConfig(): Promise<ProxyConfig> {
  let endpoint: string;
  try {
    endpoint = getProxyEndpoint();
  } catch {
    return {};
  }
  const cached = proxyConfigCache.get(endpoint);
  if (cached) return cached;
  return new Promise<ProxyConfig>((resolve) => {
    const timer = setTimeout(() => resolve({}), VALIDATE_CONFIG_TIMEOUT_MS);
    const settle = (config: ProxyConfig) => {
      clearTimeout(timer);
      resolve(config);
    };
    fetchProxyConfig(endpoint).then(settle, () => settle({}));
  });
}

function readTokenClientId(accessToken: string): string | undefined {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return undefined;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json) as { client_id?: unknown };
    return typeof claims.client_id === 'string' ? claims.client_id : undefined;
  } catch {
    return undefined;
  }
}

const isExtension =
  typeof chrome !== 'undefined' && !!(chrome as { runtime?: { id?: string } })?.runtime?.id;

function getAdobeAccount() {
  return getAccounts().find((a) => a.providerId === 'adobe');
}

interface AdobeUserProfile {
  name?: string;
  avatar?: string;
}

const IMS_PROFILE_PATHS = ['/ims/profile/v1', '/ims/userinfo/v2'] as const;

async function fetchImsProfile(
  url: string,
  accessToken: string
): Promise<AdobeUserProfile | undefined> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      console.warn(`[adobe] Profile fetch ${url} returned ${res.status}`);
      return undefined;
    }
    const profile = (await res.json()) as {
      name?: string;
      email?: string;
      displayName?: string;
      picture?: string;
      avatar_url?: string;
    };
    const name = profile.displayName || profile.name || profile.email;
    return name ? { name, avatar: profile.picture || profile.avatar_url } : undefined;
  } catch (err) {
    console.warn(
      `[adobe] Profile fetch ${url} failed:`,
      err instanceof Error ? err.message : String(err)
    );
    return undefined;
  }
}

async function fetchUserProfile(accessToken: string, imsEnv?: string): Promise<AdobeUserProfile> {
  for (const path of IMS_PROFILE_PATHS) {
    const profile = await fetchImsProfile(`${imsHost(imsEnv)}${path}`, accessToken);
    if (profile) return profile;
  }
  console.warn('[adobe] No IMS profile endpoint named the user; account will have no display name');
  return {};
}

async function validateAdobeToken(): Promise<OAuthTokenValidation> {
  const account = getAdobeAccount();
  const accessToken = account?.accessToken;
  if (!accessToken) return { status: 'unknown', detail: 'no stored token' };

  const proxyConfig = await resolveValidationConfig();
  const clientId =
    readTokenClientId(accessToken) || proxyConfig.clientId || adobeConfig.clientId || '';
  if (!clientId) return { status: 'unknown', detail: 'no IMS client ID available' };

  const host = imsHost(resolveImsEnvironment(proxyConfig));
  try {
    const res = await fetch(`${host}/ims/validate_token/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: accessToken, type: 'access_token' }),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
      return { status: 'unknown', detail };
    }
    const body = (await res.json()) as { valid?: unknown; reason?: unknown };

    if (body.valid === true) return { status: 'accepted', userName: account?.userName };
    if (body.valid === false) {
      const reason = typeof body.reason === 'string' ? body.reason : 'no reason given';
      return { status: 'rejected', detail: `IMS reported the token invalid (${reason})` };
    }

    return { status: 'unknown', detail: 'IMS answered 200 without a boolean `valid` verdict' };
  } catch (err) {
    return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

function extractTokenFromUrl(
  url: string
): { accessToken: string; expiresIn: number; scope?: string } | null {
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return null;
  const fragment = new URLSearchParams(url.slice(hashIdx + 1));
  const accessToken = fragment.get('access_token');
  if (!accessToken) return null;
  const expiresIn = parseInt(fragment.get('expires_in') ?? '86400', 10);
  const scope = fragment.get('scope') ?? undefined;
  return { accessToken, expiresIn, scope };
}

export const config: ProviderConfig = {
  id: 'adobe',
  name: 'Adobe',
  description: 'Claude via Adobe — login with your Adobe ID',
  requiresApiKey: false,
  requiresBaseUrl: !adobeConfig.proxyEndpoint,
  baseUrlPlaceholder: 'https://your-proxy.example.com',
  baseUrlDescription: 'Anthropic-compatible proxy endpoint',
  isOAuth: true,
  defaultModelId: 'sonnet',
  oauthTokenDomains: [
    'ims-na1.adobelogin.com',
    'ims-na1-stg1.adobelogin.com',
    '*.adobelogin.com',
    '*.adobe.io',
    'firefall.adobe.io',
    'admin.hlx.page',
    'admin.hlx.live',
    'admin.aem.page',
    'admin.aem.live',
    'api.aem.live',
  ],

  getBudgetUsage,

  getModelIds: () => {
    const enrichModel = (m: AdobeModelMetadata) =>
      enrichAdobeModel(m, proxyMetadataCache.get(m.id));

    for (const models of modelsCache.values()) {
      if (models.length) {
        const result = models.map((m) =>
          enrichModel({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: m.reasoning,
            input: m.input,
            cost: m.cost,
          })
        );
        persistAdobeModels(result);
        return result;
      }
    }

    for (const config of proxyConfigCache.values()) {
      if (config.models?.length) return config.models.map((m) => enrichModel(m));
    }

    try {
      const persisted = localStorage.getItem(ADOBE_MODELS_KEY);
      if (persisted) {
        const models = JSON.parse(persisted) as EnrichedAdobeModel[];
        if (models.length) return models;
      }
    } catch {}

    return [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }];
  },

  onOAuthLogin: async (
    launcher: OAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const proxyEndpoint = getProxyEndpoint();
    const proxyConfig = await fetchProxyConfig(proxyEndpoint);

    const clientId = resolveClientId(proxyConfig);
    const scopes = resolveScopes(proxyConfig);
    const imsEnv = resolveImsEnvironment(proxyConfig);

    const pageInfo = isExtension ? null : await getOAuthPageOrigin();

    const stateInfo = !isExtension
      ? buildAdobeOAuthState(
          {
            pageHref: pageInfo!.href,
            pageOrigin: pageInfo!.origin,
            configuredRedirectUri: adobeConfig.redirectUri,
          },
          () => crypto.randomUUID()
        )
      : null;
    const redirectUri = isExtension
      ? (adobeConfig.extensionRedirectUri ??
        `https://${(chrome as { runtime: { id: string } }).runtime.id}.chromiumapp.org/`)
      : stateInfo!.redirectUri;

    const oauthState = stateInfo?.oauthState;
    const expectedNonce = stateInfo?.expectedNonce ?? null;

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      response_type: 'token',
      redirect_uri: redirectUri,
    });
    if (oauthState) params.set('state', oauthState);

    if (options?.forceReauth) params.set('prompt', 'login');
    const authorizeUrl = `${imsHost(imsEnv)}/ims/authorize/v2?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

    if (expectedNonce && redirectUrl) {
      try {
        const callbackUrl = new URL(redirectUrl);
        const receivedNonce = callbackUrl.searchParams.get('nonce');
        if (receivedNonce !== expectedNonce) {
          console.error('[adobe] OAuth nonce mismatch — possible CSRF');
          return;
        }
      } catch (err) {
        console.warn(
          '[adobe] Nonce check skipped (URL parse failed):',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const tokenInfo = extractTokenFromUrl(redirectUrl);
    if (!tokenInfo) {
      console.error('[adobe] Could not extract token from redirect URL');
      return;
    }

    const userProfile = await fetchUserProfile(tokenInfo.accessToken, imsEnv);

    await saveOAuthAccount({
      providerId: 'adobe',
      accessToken: tokenInfo.accessToken,
      tokenExpiresAt: Date.now() + tokenInfo.expiresIn * 1000,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,
      scopes: tokenInfo.scope,

      baseUrl: adobeConfig.proxyEndpoint ? undefined : proxyEndpoint,
    });

    clearBudgetWindowCache();

    await getAdobeModels().catch((err) =>
      console.warn(
        '[adobe] Failed to fetch models after login:',
        err instanceof Error ? err.message : String(err)
      )
    );

    onSuccess();
  },

  onOAuthLogout: async () => {
    const account = getAdobeAccount();
    if (account?.accessToken) {
      try {
        const proxyConfig = await resolveValidationConfig();
        const clientId =
          readTokenClientId(account.accessToken) || proxyConfig.clientId || adobeConfig.clientId;
        const imsEnv = resolveImsEnvironment(proxyConfig);
        if (clientId) {
          const revRes = await fetch(`${imsHost(imsEnv)}/ims/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: account.accessToken,
              token_type_hint: 'access_token',
              client_id: clientId,
            }),
          });
          if (!revRes.ok) {
            console.warn(
              `[adobe] Token revocation returned ${revRes.status}, token may still be valid server-side`
            );
          }
        }
      } catch (err) {
        console.warn(
          '[adobe] Failed to revoke token:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    await saveOAuthAccount({ providerId: 'adobe', accessToken: '' });

    clearBudgetWindowCache();
  },

  onSilentRenew: async () => {
    const account = getAdobeAccount();
    if (!account?.accessToken) return null;
    return silentRenewToken();
  },

  onValidateToken: validateAdobeToken,

  refreshModels: async (accessToken?: string) => {
    await getAdobeModels(accessToken);

    const enriched = config.getModelIds?.() as EnrichedAdobeModel[] | undefined;
    if (enriched?.length) persistAdobeModels(enriched);
  },
};

let renewalInProgress: Promise<string | null> | null = null;

const silentRenewBackoff = createSilentRenewBackoff();

async function getValidAccessToken(): Promise<string> {
  const account = getAdobeAccount();
  if (!account?.accessToken) throw new Error('Not logged in to Adobe — please log in first');

  const expiresIn = (account.tokenExpiresAt ?? 0) - Date.now();
  if (expiresIn > 60000) return account.accessToken;

  console.log('[adobe] Token expired or expiring soon, attempting silent renewal...');
  const newToken = await silentRenewBackoff.run(() => silentRenewToken());
  if (newToken) return newToken;

  const refreshedAccount = getAdobeAccount();
  const refreshedExpiresIn = (refreshedAccount?.tokenExpiresAt ?? 0) - Date.now();
  if (refreshedExpiresIn > 0 && refreshedAccount?.accessToken) return refreshedAccount.accessToken;

  throw new Error('Adobe session expired — please log in again');
}

async function getBudgetUsage(): Promise<ProviderBudgetWindow | null> {
  let endpoint: string;
  try {
    endpoint = getProxyEndpoint();
  } catch {
    return null;
  }
  const account = getAdobeAccount();
  if (!account?.accessToken || isTokenExpired()) {
    throw new Error('Adobe budget: not signed in');
  }
  return fetchAdobeUsage(endpoint, account.accessToken, fetch, {
    headers: { 'X-Session-Id': getDailyAdobeUuid(ADOBE_USAGE_ANCHOR) },
  });
}

function isTokenExpired(): boolean {
  const account = getAdobeAccount();
  if (!account?.tokenExpiresAt) return true;
  return Date.now() > account.tokenExpiresAt - 60000;
}

async function silentRenewToken(): Promise<string | null> {
  if (typeof window === 'undefined') {
    const rpc = getPanelRpcClient();
    if (!rpc) return null;
    try {
      const { accessToken } = await rpc.call(
        'silent-renew',
        { providerId: 'adobe' },
        { timeoutMs: 130_000 }
      );
      return accessToken;
    } catch (err) {
      console.warn(
        '[adobe] worker→page silent-renew bridge failed:',
        err instanceof Error ? err.message : String(err)
      );
      return null;
    }
  }

  if (renewalInProgress !== null) return renewalInProgress;

  renewalInProgress = performSilentRenewal().finally(() => {
    renewalInProgress = null;
  });
  return renewalInProgress;
}

interface SilentRenewAuthorizeContext {
  authorizeUrl: string;
  expectedNonce: string | null;
  proxyEndpoint: string;
}

function buildSilentRenewAuthorize(
  proxyEndpoint: string,
  proxyConfig: ProxyConfig
): SilentRenewAuthorizeContext {
  const clientId = resolveClientId(proxyConfig);
  const scopes = resolveScopes(proxyConfig);
  const imsEnv = resolveImsEnvironment(proxyConfig);

  const stateInfo = !isExtension
    ? buildAdobeOAuthState(
        {
          pageHref: window.location.href,
          pageOrigin: window.location.origin,
          configuredRedirectUri: adobeConfig.redirectUri,
        },
        () => crypto.randomUUID()
      )
    : null;
  const redirectUri = isExtension
    ? (adobeConfig.extensionRedirectUri ??
      `https://${(chrome as { runtime: { id: string } }).runtime.id}.chromiumapp.org/`)
    : stateInfo!.redirectUri;
  const oauthState = stateInfo?.oauthState;
  const expectedNonce = stateInfo?.expectedNonce ?? null;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    response_type: 'token',
    redirect_uri: redirectUri,
    prompt: 'none',
  });
  if (oauthState) params.set('state', oauthState);
  const authorizeUrl = `${imsHost(imsEnv)}/ims/authorize/v2?${params}`;
  return { authorizeUrl, expectedNonce, proxyEndpoint };
}

function verifySilentRenewNonce(redirectUrl: string, expectedNonce: string | null): boolean {
  if (!expectedNonce) return true;
  try {
    const callbackUrl = new URL(redirectUrl);
    const receivedNonce = callbackUrl.searchParams.get('nonce');
    if (receivedNonce !== expectedNonce) {
      console.error('[adobe] OAuth nonce mismatch — possible CSRF');
      return false;
    }
  } catch (err) {
    console.warn(
      '[adobe] Nonce check skipped (URL parse failed):',
      err instanceof Error ? err.message : String(err)
    );
  }
  return true;
}

async function persistRenewedToken(
  tokenInfo: { accessToken: string; expiresIn: number; scope?: string },
  proxyEndpoint: string
): Promise<void> {
  const account = getAdobeAccount();
  await saveOAuthAccount({
    providerId: 'adobe',
    accessToken: tokenInfo.accessToken,
    tokenExpiresAt: Date.now() + tokenInfo.expiresIn * 1000,
    userName: account?.userName,
    userAvatar: account?.userAvatar,
    scopes: tokenInfo.scope,
    baseUrl: adobeConfig.proxyEndpoint ? undefined : proxyEndpoint,
  });
}

async function performSilentRenewal(): Promise<string | null> {
  try {
    const proxyEndpoint = getProxyEndpoint();
    const proxyConfig = await fetchProxyConfig(proxyEndpoint);
    const { authorizeUrl, expectedNonce } = buildSilentRenewAuthorize(proxyEndpoint, proxyConfig);

    const { createOAuthLauncher } = await import('../src/providers/oauth-service.js');
    const launcher = createOAuthLauncher();

    const redirectUrl = await launcher(authorizeUrl, { interactive: false });
    if (!redirectUrl) return null;
    if (!verifySilentRenewNonce(redirectUrl, expectedNonce)) return null;

    const tokenInfo = extractTokenFromUrl(redirectUrl);
    if (!tokenInfo) return null;

    await persistRenewedToken(tokenInfo, proxyEndpoint);
    console.log('[adobe] Token renewed silently');

    await getAdobeModels().catch((err) =>
      console.warn(
        '[adobe] Failed to refresh models after silent renewal:',
        err instanceof Error ? err.message : String(err)
      )
    );

    return tokenInfo.accessToken;
  } catch (err) {
    console.warn('[adobe] Silent renewal error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

const SLICC_VERSION_HEADER = 'X-Slicc-Version';

function withSliccVersionHeader<T extends { headers?: ProviderHeaders }>(options: T): T {
  const merged: ProviderHeaders = {};
  const versionKeyLower = SLICC_VERSION_HEADER.toLowerCase();
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (key.toLowerCase() !== versionKeyLower) merged[key] = value;
    }
  }
  merged[SLICC_VERSION_HEADER] = __SLICC_VERSION__;
  return { ...options, headers: merged };
}

const ADOBE_PROVIDER_FALLBACK_ANCHOR = 'adobe-provider-fallback';

const ADOBE_USAGE_ANCHOR = 'adobe-usage-probe';

const warnedCallSites = new Set<string>();

function ensureSessionIdHeader<T extends { headers?: ProviderHeaders }>(
  options: T,
  callSite: string
): T {
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (key.toLowerCase() === 'x-session-id' && value != null) return options;
    }
  }
  if (!warnedCallSites.has(callSite)) {
    warnedCallSites.add(callSite);
    console.warn(
      `[adobe] Missing X-Session-Id from ${callSite} — using daily fallback. ` +
        `Attach an X-Session-Id header at the call site (see scoop-context.ts ` +
        `streamWithSessionId or docs/pitfalls.md).`
    );
  }
  return {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      'X-Session-Id': getDailyAdobeUuid(ADOBE_PROVIDER_FALLBACK_ANCHOR),
    },
  };
}

export function __resetAdobeSessionIdWarningCacheForTests(): void {
  warnedCallSites.clear();
}

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: 'adobe-anthropic' as Api,
      provider: 'adobe',
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error' as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

function logStreamError(error: unknown): void {
  console.error('[adobe] Stream error:', error instanceof Error ? error.message : String(error));
}

const streamAdobe = (
  model: Model<Api>,
  context: Context,
  options: AnthropicOptions | OpenAICompletionsOptions = {}
) => {
  const stream = createAssistantMessageEventStream();

  pumpAdobeStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

async function pumpAdobeStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<Api>,
  context: Context,
  options: AnthropicOptions | OpenAICompletionsOptions
): Promise<void> {
  try {
    const accessToken = await getValidAccessToken();
    const isOpenAI = String(model.api).includes('openai');

    if (isOpenAI) {
      const proxyModel = {
        ...model,
        baseUrl: `${getProxyEndpoint()}/v1`,
        api: 'openai-completions' as Api,

        compat: {
          ...(model as unknown as { compat?: OpenAICompletionsCompat }).compat,
          supportsStore: false,
          supportsDeveloperRole: false,
        },
      };

      const inner = streamOpenAICompletions(
        proxyModel as unknown as Model<'openai-completions'>,
        context,
        withSliccVersionHeader(
          ensureSessionIdHeader({ ...options, apiKey: accessToken }, 'streamAdobe[openai]')
        ) as unknown as OpenAICompletionsOptions
      );
      for await (const event of inner) stream.push(event);
    } else {
      const proxyModel = {
        ...model,
        baseUrl: getProxyEndpoint(),
        api: 'anthropic-messages' as Api,
      };

      const inner = streamAnthropic(
        proxyModel as unknown as Model<'anthropic-messages'>,
        context,
        withSliccVersionHeader(
          ensureSessionIdHeader(
            withAdaptiveThinkingShim(
              model,
              withSupportedTemperature(model.id, model.name, { ...options, apiKey: accessToken })
            ),
            'streamAdobe[anthropic]'
          )
        ) as unknown as AnthropicOptions
      );
      for await (const event of inner) stream.push(event);
    }
    stream.end();
  } catch (error) {
    logStreamError(error);

    stream.push(makeErrorOutput(model, error) as unknown as AssistantMessageEvent);
    stream.end();
  }
}

const streamSimpleAdobe = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();

  pumpSimpleAdobeStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

async function pumpSimpleAdobeStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): Promise<void> {
  try {
    const accessToken = await getValidAccessToken();
    const isOpenAI = String(model.api).includes('openai');

    if (isOpenAI) {
      const proxyModel = {
        ...model,
        baseUrl: `${getProxyEndpoint()}/v1`,
        api: 'openai-completions' as Api,

        compat: {
          ...(model as unknown as { compat?: OpenAICompletionsCompat }).compat,
          supportsStore: false,
          supportsDeveloperRole: false,
        },
      };

      const inner = streamSimpleOpenAICompletions(
        proxyModel as unknown as Model<'openai-completions'>,
        context,
        withSliccVersionHeader(
          ensureSessionIdHeader({ ...options, apiKey: accessToken }, 'streamSimpleAdobe[openai]')
        ) as unknown as SimpleStreamOptions
      );
      for await (const event of inner) stream.push(event);
    } else {
      const proxyModel = {
        ...model,
        baseUrl: getProxyEndpoint(),
        api: 'anthropic-messages' as Api,
      };

      const inner = streamSimpleAnthropic(
        proxyModel as unknown as Model<'anthropic-messages'>,
        context,
        withSliccVersionHeader(
          ensureSessionIdHeader(
            withAdaptiveThinkingShim(
              model,
              withSupportedTemperature(model.id, model.name, { ...options, apiKey: accessToken })
            ),
            'streamSimpleAdobe[anthropic]'
          )
        ) as unknown as SimpleStreamOptions
      );
      for await (const event of inner) stream.push(event);
    }
    stream.end();
  } catch (error) {
    logStreamError(error);

    stream.push(makeErrorOutput(model, error) as unknown as AssistantMessageEvent);
    stream.end();
  }
}

type RawProxyModel = {
  id: string;
  name?: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
};

function toMetadataEntry(pm: RawProxyModel): AdobeModelMetadata {
  const entry: AdobeModelMetadata = { id: pm.id, name: pm.name };
  if (pm.api !== undefined) entry.api = pm.api;
  if (pm.context_window !== undefined) entry.context_window = pm.context_window;
  if (pm.max_tokens !== undefined) entry.max_tokens = pm.max_tokens;
  if (pm.reasoning !== undefined) entry.reasoning = pm.reasoning;
  if (pm.input !== undefined) entry.input = pm.input;
  return entry;
}

function buildPiAiModelMap(): Map<string, Model<Api>> {
  const modelMap = new Map<string, Model<Api>>();
  for (const provider of getProviders()) {
    try {
      const providerModels = getModels(provider) as unknown as Model<Api>[];
      for (const m of providerModels) modelMap.set(m.id, m);
    } catch {}
  }
  return modelMap;
}

function buildAdobeModel(
  pm: RawProxyModel,
  endpoint: string,
  modelMap: Map<string, Model<Api>>
): Model<Api> {
  const apiType = pm.api === 'openai' ? 'openai' : 'anthropic';
  const customApi = `adobe-${apiType}` as Api;
  const base = modelMap.get(pm.id);
  if (base) return { ...base, provider: 'adobe', api: customApi };

  const cost = findFamilyCost(pm.id, modelMap);

  return {
    id: pm.id,
    name: pm.name ?? pm.id,
    provider: 'adobe',
    api: customApi,
    baseUrl: endpoint,
    contextWindow: 200000,
    maxTokens: 16384,
    input: ['text', 'image'],
    cost,
    inputCost: cost.input,
    outputCost: cost.output,
    cacheReadCost: cost.cacheRead,
    cacheWriteCost: cost.cacheWrite,
    reasoning: true,
  } as unknown as Model<Api>;
}

function processProxyModelsPayload(rawModels: RawProxyModel[], endpoint: string): Model<Api>[] {
  for (const pm of rawModels) proxyMetadataCache.set(pm.id, toMetadataEntry(pm));
  const modelMap = buildPiAiModelMap();
  return rawModels.map((pm) => buildAdobeModel(pm, endpoint, modelMap));
}

async function fetchProxyModels(accessToken?: string): Promise<Model<Api>[] | null> {
  try {
    const token = accessToken ?? (await getValidAccessToken());
    const endpoint = getProxyEndpoint();
    const res = await fetch(`${endpoint}/v1/models`, {
      headers: {
        Authorization: `Bearer ${token}`,
        [SLICC_VERSION_HEADER]: __SLICC_VERSION__,
      },
    });
    if (!res.ok) {
      console.warn(
        `[adobe] Proxy /v1/models returned ${res.status}, falling back to Anthropic models`
      );
    } else {
      const data = (await res.json()) as { data?: RawProxyModel[] };
      if (data.data?.length) return processProxyModelsPayload(data.data, endpoint);
    }
  } catch (err) {
    console.warn(
      '[adobe] Failed to fetch proxy models:',
      err instanceof Error ? err.message : String(err)
    );
  }

  return null;
}

const modelsCache = new Map<string, Model<Api>[]>();

function adobeAnthropicFallbackModels(): Model<Api>[] {
  const anthropicModels = getModels('anthropic') as unknown as Model<Api>[];
  return anthropicModels.map((m) => ({ ...m, provider: 'adobe', api: 'adobe-anthropic' as Api }));
}

export async function getAdobeModels(accessToken?: string): Promise<Model<Api>[]> {
  const endpoint = getProxyEndpoint();
  const cached = modelsCache.get(endpoint);
  if (cached) return cached;
  const models = await fetchProxyModels(accessToken);
  if (models) {
    modelsCache.set(endpoint, models);
    return models;
  }

  return adobeAnthropicFallbackModels();
}

export function register(): void {
  registerApiProvider({
    api: 'adobe-anthropic' as Api,

    stream: streamAdobe as unknown as StreamFunction<Api>,

    streamSimple: streamSimpleAdobe as unknown as StreamFunction<Api, SimpleStreamOptions>,
  });
  registerApiProvider({
    api: 'adobe-openai' as Api,

    stream: streamAdobe as unknown as StreamFunction<Api>,

    streamSimple: streamSimpleAdobe as unknown as StreamFunction<Api, SimpleStreamOptions>,
  });
}

export { extractTokenFromUrl, getValidAccessToken, isTokenExpired };
