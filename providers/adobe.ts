/**
 * Adobe IMS Provider — OAuth login via generic OAuthLauncher.
 *
 * Authentication:
 *   CLI mode:       popup → /auth/callback → postMessage → token extracted
 *   Extension mode: chrome.identity.launchWebAuthFlow → redirect URL → token extracted
 *
 * Both modes use the generic OAuthLauncher from src/providers/oauth-service.ts.
 * This file only handles Adobe-specific logic: building the authorize URL,
 * extracting the token from the redirect URL, and fetching the user profile.
 *
 * Proxied through an Anthropic-compatible LLM endpoint.
 * Reuses pi-ai's Anthropic stream functions — the IMS access token is passed
 * as the API key (JWT >200 chars triggers Bearer auth in the Anthropic SDK).
 *
 * This file lives in /providers/ (gitignored) and is auto-discovered
 * by the build-time provider system. It is NOT part of the open-source repo.
 */

import type { ProviderConfig, OAuthLauncher } from '../src/providers/types.js';
import {
  registerApiProvider,
  streamAnthropic,
  streamSimpleAnthropic,
  getModels,
} from '@mariozechner/pi-ai';
import { AssistantMessageEventStream } from '@mariozechner/pi-ai/dist/utils/event-stream.js';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import type { AnthropicOptions } from '@mariozechner/pi-ai/dist/providers/anthropic.js';
import {
  saveOAuthAccount,
  getAccounts,
  getBaseUrlForProvider,
} from '../src/ui/provider-settings.js';

// ── Config ──────────────────────────────────────────────────────────

interface AdobeConfig {
  clientId: string;
  proxyEndpoint: string;
  scopes: string;
  /** IMS environment: "prod" (default) or "stg1". */
  imsEnvironment?: string;
  /** Redirect URI for CLI mode (regular browser popup). */
  redirectUri?: string;
  /** Redirect URI for extension mode (chrome.identity.launchWebAuthFlow). */
  extensionRedirectUri?: string;
}

const configFiles = import.meta.glob('/providers/adobe-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, AdobeConfig>;

const adobeConfig: AdobeConfig = configFiles['/providers/adobe-config.json'] ?? {
  clientId: '',
  proxyEndpoint: '',
  scopes: 'openid,profile,email',
};

// ── Proxy endpoint resolution ───────────────────────────────────────

/**
 * Resolve the proxy endpoint URL.
 * Priority: Account.baseUrl (runtime UI) → adobeConfig.proxyEndpoint (build-time json) → error
 */
function getProxyEndpoint(): string {
  const runtimeUrl = getBaseUrlForProvider('adobe');
  if (runtimeUrl) return runtimeUrl.replace(/\/$/, '');
  if (adobeConfig.proxyEndpoint) return adobeConfig.proxyEndpoint.replace(/\/$/, '');
  throw new Error('Adobe proxy endpoint not configured — set it in Settings or adobe-config.json');
}

// ── Dynamic proxy config (fetched from /v1/config at login time) ────

interface ProxyConfig {
  clientId?: string;
  scopes?: string;
  imsEnvironment?: string;
  models?: Array<{ id: string; name?: string }>;
}

let cachedProxyConfig: ProxyConfig | null = null;

/**
 * Fetch client config from the proxy's /v1/config endpoint (unauthenticated).
 * Caches the result for the session lifetime. Falls back to adobeConfig values on failure.
 */
async function fetchProxyConfig(proxyEndpoint: string): Promise<ProxyConfig> {
  if (cachedProxyConfig) return cachedProxyConfig;
  try {
    const res = await fetch(`${proxyEndpoint}/v1/config`);
    if (res.ok) {
      cachedProxyConfig = await res.json() as ProxyConfig;
      return cachedProxyConfig;
    }
  } catch { /* best-effort — fall back to build-time config */ }
  cachedProxyConfig = {};
  return cachedProxyConfig;
}

/** Resolve the IMS client ID. Fetched config takes precedence over build-time config. */
function resolveClientId(proxyConfig: ProxyConfig): string {
  const clientId = proxyConfig.clientId || adobeConfig.clientId;
  if (!clientId) throw new Error('Could not determine IMS client ID — proxy /v1/config did not return one and adobe-config.json is empty');
  return clientId;
}

/** Resolve scopes. Fetched config takes precedence over build-time config. */
function resolveScopes(proxyConfig: ProxyConfig): string {
  return proxyConfig.scopes || adobeConfig.scopes;
}

/** Resolve IMS environment. Fetched config takes precedence over build-time config. */
function resolveImsEnvironment(proxyConfig: ProxyConfig): string {
  return proxyConfig.imsEnvironment || adobeConfig.imsEnvironment || 'prod';
}

// ── IMS endpoints ───────────────────────────────────────────────────

const IMS_HOSTS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

function imsHost(env?: string): string {
  return IMS_HOSTS[env ?? adobeConfig.imsEnvironment ?? 'prod'] ?? IMS_HOSTS.prod;
}

// ── Runtime detection ───────────────────────────────────────────────

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

// ── Shared helpers ──────────────────────────────────────────────────

function getAdobeAccount() {
  return getAccounts().find(a => a.providerId === 'adobe');
}

async function fetchUserProfile(accessToken: string, imsEnv?: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${imsHost(imsEnv)}/ims/userinfo/v2`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const profile = await res.json() as { name?: string; email?: string; displayName?: string };
      return profile.displayName || profile.name || profile.email;
    }
  } catch { /* best-effort */ }
  return undefined;
}

/** Extract token from a URL fragment (#access_token=...&expires_in=...) */
function extractTokenFromUrl(url: string): { accessToken: string; expiresIn: number } | null {
  const hashIdx = url.indexOf('#');
  if (hashIdx < 0) return null;
  const fragment = new URLSearchParams(url.slice(hashIdx + 1));
  const accessToken = fragment.get('access_token');
  if (!accessToken) return null;
  const expiresIn = parseInt(fragment.get('expires_in') ?? '86400', 10);
  return { accessToken, expiresIn };
}

// ── Provider config ─────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: 'adobe',
  name: 'Adobe',
  description: 'Claude via Adobe — login with your Adobe ID',
  requiresApiKey: false,
  requiresBaseUrl: true,
  baseUrlPlaceholder: 'https://your-proxy.example.com',
  baseUrlDescription: 'Anthropic-compatible proxy endpoint (leave empty to use default from config)',
  isOAuth: true,

  getModelIds: () => {
    if (cachedProxyConfig?.models?.length) {
      return cachedProxyConfig.models;
    }
    // Default before proxy config is fetched — use alias without date suffix
    // so pi-ai resolves it from its registry with full model metadata
    return [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    ];
  },

  onOAuthLogin: async (launcher: OAuthLauncher, onSuccess: () => void) => {
    const proxyEndpoint = getProxyEndpoint();
    const proxyConfig = await fetchProxyConfig(proxyEndpoint);

    const clientId = resolveClientId(proxyConfig);
    const scopes = resolveScopes(proxyConfig);
    const imsEnv = resolveImsEnvironment(proxyConfig);

    const redirectUri = isExtension
      ? (adobeConfig.extensionRedirectUri ?? `https://${(chrome as any).runtime.id}.chromiumapp.org/`)
      : (adobeConfig.redirectUri ?? `${window.location.origin}/auth/callback`);

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      response_type: 'token',
      redirect_uri: redirectUri,
    });
    const authorizeUrl = `${imsHost(imsEnv)}/ims/authorize/v2?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

    const tokenInfo = extractTokenFromUrl(redirectUrl);
    if (!tokenInfo) {
      console.error('[adobe] Could not extract token from redirect URL');
      return;
    }

    const userName = await fetchUserProfile(tokenInfo.accessToken, imsEnv);

    saveOAuthAccount({
      providerId: 'adobe',
      accessToken: tokenInfo.accessToken,
      tokenExpiresAt: Date.now() + tokenInfo.expiresIn * 1000,
      userName,
    });

    onSuccess();
  },

  onOAuthLogout: async () => {
    const account = getAdobeAccount();
    if (account?.accessToken) {
      try {
        const proxyConfig = cachedProxyConfig ?? {};
        const clientId = proxyConfig.clientId || adobeConfig.clientId;
        const imsEnv = resolveImsEnvironment(proxyConfig);
        if (clientId) {
          await fetch(`${imsHost(imsEnv)}/ims/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token: account.accessToken,
              token_type_hint: 'access_token',
              client_id: clientId,
            }),
          });
        }
      } catch { /* best-effort */ }
    }
    saveOAuthAccount({ providerId: 'adobe', accessToken: '' });
  },
};

// ── Token access ────────────────────────────────────────────────────

async function getValidAccessToken(): Promise<string> {
  const account = getAdobeAccount();
  if (!account?.accessToken) throw new Error('Not logged in to Adobe — please log in first');
  const expired = !account.tokenExpiresAt || Date.now() > account.tokenExpiresAt - 60000;
  if (expired) throw new Error('Adobe session expired — please log in again');
  return account.accessToken;
}

function isTokenExpired(): boolean {
  const account = getAdobeAccount();
  if (!account?.tokenExpiresAt) return true;
  return Date.now() > account.tokenExpiresAt - 60000;
}

// ── Stream functions (reuse pi-ai's Anthropic provider) ─────────────

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
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error' as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

const streamAdobe = (
  model: Model<Api>,
  context: Context,
  options: AnthropicOptions = {},
) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = { ...model, baseUrl: getProxyEndpoint(), api: 'anthropic-messages' as Api };
      const inner = streamAnthropic(proxyModel as any, context, { ...options, apiKey: accessToken });
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      stream.push(makeErrorOutput(model, error) as any);
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleAdobe = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  const stream = new AssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = { ...model, baseUrl: getProxyEndpoint(), api: 'anthropic-messages' as Api };
      const inner = streamSimpleAnthropic(proxyModel as any, context, { ...options, apiKey: accessToken } as any);
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      stream.push(makeErrorOutput(model, error) as any);
      stream.end();
    }
  })();
  return stream;
};

// ── Model list ──────────────────────────────────────────────────────

async function fetchProxyModels(): Promise<Model<Api>[]> {
  try {
    const accessToken = await getValidAccessToken();
    const res = await fetch(`${getProxyEndpoint()}/v1/models`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const data = await res.json() as { data?: Array<{ id: string; name?: string }> };
      if (data.data?.length) {
        const anthropicModels = getModels('anthropic' as any) as Model<Api>[];
        const modelMap = new Map(anthropicModels.map(m => [m.id, m]));
        return data.data.map(pm => {
          const base = modelMap.get(pm.id);
          if (base) return { ...base, provider: 'adobe', api: 'adobe-anthropic' as Api };
          return {
            id: pm.id, name: pm.name ?? pm.id, provider: 'adobe',
            api: 'adobe-anthropic' as Api, baseUrl: getProxyEndpoint(),
            contextWindow: 200000, maxTokens: 16384, input: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, reasoning: true,
          } as unknown as Model<Api>;
        });
      }
    }
  } catch { /* best-effort */ }

  const anthropicModels = getModels('anthropic' as any) as Model<Api>[];
  return anthropicModels.map(m => ({ ...m, provider: 'adobe', api: 'adobe-anthropic' as Api }));
}

let cachedModels: Model<Api>[] | null = null;

export async function getAdobeModels(): Promise<Model<Api>[]> {
  if (cachedModels) return cachedModels;
  cachedModels = await fetchProxyModels();
  return cachedModels;
}

// ── Registration ────────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: 'adobe-anthropic' as Api,
    stream: streamAdobe as any,
    streamSimple: streamSimpleAdobe as any,
  });
}

export { getValidAccessToken, isTokenExpired };
