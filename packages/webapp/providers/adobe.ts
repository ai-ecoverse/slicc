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
 * This file lives in packages/webapp/providers/ and is auto-discovered by the
 * build-time provider system via import.meta.glob. It is safe to commit — no
 * secrets are hardcoded; the proxy endpoint (base URL) must be configured at runtime.
 */

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
  getModels,
  getProviders,
  registerApiProvider,
  streamAnthropic,
  streamOpenAICompletions,
  streamSimpleAnthropic,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/compat';
import { getPanelRpcClient } from '../src/kernel/panel-rpc.js';
import { withAdaptiveThinkingShim } from '../src/providers/adaptive-thinking.js';
import {
  type AdobeModelMetadata,
  enrichAdobeModel,
} from '../src/providers/adobe-model-metadata.js';
import { buildAdobeOAuthState } from '../src/providers/adobe-oauth-state.js';
import { getOAuthPageOrigin } from '../src/providers/oauth-service.js';
import { createSilentRenewBackoff } from '../src/providers/silent-renew-backoff.js';
import { withSupportedTemperature } from '../src/providers/temperature-support.js';
import type { OAuthLauncher, OAuthLoginOptions, ProviderConfig } from '../src/providers/types.js';
import { getDailyAdobeUuid } from '../src/scoops/llm-session-id.js';
import {
  getAccounts,
  getBaseUrlForProvider,
  saveOAuthAccount,
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

const configFiles = import.meta.glob('/packages/webapp/providers/adobe-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, AdobeConfig>;

const adobeConfig: AdobeConfig = configFiles['/packages/webapp/providers/adobe-config.json'] ?? {
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
  // The /v1/config response carries full per-model metadata (context_window,
  // max_tokens, etc.) — not just id/name. Typing it as AdobeModelMetadata lets
  // getModelIds propagate the real window through the unauthenticated fallback
  // path, before the authenticated /v1/models cache is populated.
  models?: AdobeModelMetadata[];
}

const proxyConfigCache = new Map<string, ProxyConfig>();

// ── Proxy model metadata cache ──────────────────────────────────────

const proxyMetadataCache = new Map<string, AdobeModelMetadata>();

/** Storage key for the enriched model list (read by cold consumers, e.g. the
 * cloud cone's kernel worker on first resolve). */
const ADOBE_MODELS_KEY = 'slicc-adobe-models';

/**
 * Persist the enriched model list so it survives a page refresh and is visible
 * to other floats/contexts that share localStorage (page→worker shim). Named
 * (rather than an inline `setItem`) so the side effect `refreshModels` relies on
 * stays discoverable if `getModelIds` is ever refactored toward a pure read.
 */
function persistAdobeModels(models: unknown): void {
  try {
    localStorage.setItem(ADOBE_MODELS_KEY, JSON.stringify(models));
  } catch {}
}

/**
 * Fetch client config from the proxy's /v1/config endpoint (unauthenticated).
 * Caches per endpoint so switching proxy URLs fetches fresh config.
 * Falls back to build-time adobeConfig values on failure.
 */
async function fetchProxyConfig(proxyEndpoint: string): Promise<ProxyConfig> {
  const cached = proxyConfigCache.get(proxyEndpoint);
  if (cached) return cached;
  try {
    const res = await fetch(`${proxyEndpoint}/v1/config`, {
      headers: { [SLICC_VERSION_HEADER]: __SLICC_VERSION__ },
    });
    if (res.ok) {
      const config = (await res.json()) as ProxyConfig;
      proxyConfigCache.set(proxyEndpoint, config);
      return config;
    }
    console.warn(
      `[adobe] Proxy /v1/config returned ${res.status}, falling back to build-time config`
    );
  } catch (err) {
    console.warn(
      '[adobe] Failed to fetch proxy config:',
      err instanceof Error ? err.message : String(err)
    );
  }
  // ponytail: failures are intentionally NOT cached — a transient proxy blip
  // must not poison the session-level Map and block every subsequent retry.
  return {};
}

/** Resolve the IMS client ID. Fetched config takes precedence over build-time config. */
function resolveClientId(proxyConfig: ProxyConfig): string {
  const clientId = proxyConfig.clientId || adobeConfig.clientId;
  if (!clientId)
    throw new Error(
      'Could not determine IMS client ID — proxy /v1/config did not return one and adobe-config.json is empty'
    );
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

const isExtension =
  typeof chrome !== 'undefined' && !!(chrome as { runtime?: { id?: string } })?.runtime?.id;

// ── Shared helpers ──────────────────────────────────────────────────

function getAdobeAccount() {
  return getAccounts().find((a) => a.providerId === 'adobe');
}

async function fetchUserProfile(
  accessToken: string,
  imsEnv?: string
): Promise<{ name?: string; avatar?: string }> {
  try {
    const res = await fetch(`${imsHost(imsEnv)}/ims/userinfo/v2`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const profile = (await res.json()) as {
        name?: string;
        email?: string;
        displayName?: string;
        picture?: string;
        avatar_url?: string;
      };
      return {
        name: profile.displayName || profile.name || profile.email,
        avatar: profile.picture || profile.avatar_url,
      };
    }
    console.warn(
      `[adobe] User profile fetch returned ${res.status}, account will have no display name`
    );
  } catch (err) {
    console.warn(
      '[adobe] Failed to fetch user profile:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return {};
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
  ],

  getModelIds: () => {
    // Merge each model with cached /v1/models metadata; the entry itself fills
    // any gaps. The Haiku `compat` workaround and the cache-vs-entry precedence
    // live in the pure helper (src/providers/adobe-model-metadata.ts) so they
    // can be unit-tested without importing this DOM/chrome-bound module.
    const enrichModel = (m: AdobeModelMetadata) =>
      enrichAdobeModel(m, proxyMetadataCache.get(m.id));

    // Prefer the authenticated /v1/models response (has all available models)
    for (const models of modelsCache.values()) {
      if (models.length) {
        const result = models.map((m) =>
          enrichModel({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: m.reasoning,
            input: m.input,
          })
        );
        persistAdobeModels(result); // survives refresh; read by cold consumers
        return result;
      }
    }
    // Fall back to /v1/config response (unauthenticated). Entries carry their
    // own context_window/max_tokens, so the real window survives this path even
    // though proxyMetadataCache is empty until /v1/models is fetched.
    for (const config of proxyConfigCache.values()) {
      if (config.models?.length) return config.models.map((m) => enrichModel(m));
    }
    // Fall back to persisted models from a previous session
    try {
      const persisted = localStorage.getItem(ADOBE_MODELS_KEY);
      if (persisted) {
        const models = JSON.parse(persisted) as Array<
          { id: string; name?: string } & Record<string, unknown>
        >;
        if (models.length) return models;
      }
    } catch {}
    // Default before any config is fetched
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

    // Resolve the page origin via panel-RPC when invoked from the kernel
    // `DedicatedWorker` (no `window`); the page-context login path still
    // reads `window.location.*` directly through the helper.
    const pageInfo = isExtension ? null : await getOAuthPageOrigin();
    // CLI / page-context path branches on whether the SPA is served by the
    // worker (thin-bridge / hosted-leader). `buildAdobeOAuthState` returns
    // `source:'opener'` + same-origin redirect_uri in that case, so the
    // worker's relay postMessages the implicit-flow callback URL straight
    // back to this window's opener instead of self-looping a localhost
    // redirect that doesn't resolve. Classic CLI keeps the legacy
    // `{ port, path, nonce }` shape.
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
    // Force re-authentication when reconnecting from a logged-out state so
    // IMS doesn't silently re-authorize the previous account via SSO.
    if (options?.forceReauth) params.set('prompt', 'login');
    const authorizeUrl = `${imsHost(imsEnv)}/ims/authorize/v2?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

    // Verify CSRF nonce from relay callback
    if (expectedNonce && redirectUrl) {
      try {
        const callbackUrl = new URL(redirectUrl);
        const receivedNonce = callbackUrl.searchParams.get('nonce');
        if (receivedNonce !== expectedNonce) {
          console.error('[adobe] OAuth nonce mismatch — possible CSRF');
          return;
        }
      } catch (err) {
        // URL parse failure — continue (backwards compat with old localhost flow)
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
      // Only pin baseUrl when there is no bundled adobe-config.json (npm
      // distribution). When the config is bundled, getProxyEndpoint() can
      // always read it fresh, so persisting the URL would block deploy-time
      // proxy endpoint changes from taking effect.
      baseUrl: adobeConfig.proxyEndpoint ? undefined : proxyEndpoint,
    });

    // Fetch the full model list now that we're authenticated.
    // This populates modelsCache so getModelIds() returns all available models.
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
        const lastConfig = proxyConfigCache.values().next().value ?? {};
        const clientId = lastConfig.clientId || adobeConfig.clientId;
        const imsEnv = resolveImsEnvironment(lastConfig);
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
  },

  // Note: getOAuthLogoutUrl is intentionally absent for Adobe IMS. The IMS
  // logout/v1 endpoint requires the access_token in the POST body (not as a
  // query parameter), so it cannot be driven via a browser popup URL. Token
  // revocation is handled by onOAuthLogout above via POST /ims/revoke.

  onSilentRenew: async () => {
    const account = getAdobeAccount();
    if (!account?.accessToken) return null;
    return silentRenewToken();
  },

  // Fetch + cache the proxy model list, then persist the enriched list to
  // localStorage so a cold consumer (the cloud cone's kernel worker) reads the
  // full model set + 1M context window on its first resolve instead of the
  // default sonnet. The cloud cone calls this with the injected token, before
  // the account is saved. `getModelIds()` returns the enriched list (and
  // persists it via `persistAdobeModels`); we persist explicitly too so this
  // path doesn't silently depend on that side effect.
  refreshModels: async (accessToken?: string) => {
    await getAdobeModels(accessToken);
    const enriched = config.getModelIds?.();
    if (enriched?.length) persistAdobeModels(enriched);
  },
};

// ── Token access + silent renewal ────────────────────────────────────

/** Track in-flight renewal to avoid duplicate attempts. */
let renewalInProgress: Promise<string | null> | null = null;

/** Skips re-attempting a failed silent renewal until the cooldown elapses. */
const silentRenewBackoff = createSilentRenewBackoff();

async function getValidAccessToken(): Promise<string> {
  const account = getAdobeAccount();
  if (!account?.accessToken) throw new Error('Not logged in to Adobe — please log in first');

  // Token still valid (with 60s buffer)
  const expiresIn = (account.tokenExpiresAt ?? 0) - Date.now();
  if (expiresIn > 60000) return account.accessToken;

  // Token expired or about to expire — try silent renewal, throttled so a dead
  // session doesn't re-hit IMS on every stream/turn (see silent-renew-backoff).
  console.log('[adobe] Token expired or expiring soon, attempting silent renewal...');
  const newToken = await silentRenewBackoff.run(() => silentRenewToken());
  if (newToken) return newToken;

  // Re-read account — another concurrent call may have renewed it
  const refreshedAccount = getAdobeAccount();
  const refreshedExpiresIn = (refreshedAccount?.tokenExpiresAt ?? 0) - Date.now();
  if (refreshedExpiresIn > 0 && refreshedAccount?.accessToken) return refreshedAccount.accessToken;

  throw new Error('Adobe session expired — please log in again');
}

function isTokenExpired(): boolean {
  const account = getAdobeAccount();
  if (!account?.tokenExpiresAt) return true;
  return Date.now() > account.tokenExpiresAt - 60000;
}

/**
 * Silent token renewal — re-authenticates with IMS without user interaction.
 *
 * Uses the same OAuthLauncher as normal login (handles CLI popup, extension
 * chrome.identity, and Electron relay), but appends prompt=none to the
 * authorize URL so IMS skips the login UI and returns a new token if the
 * session cookie is still valid.
 *
 * Returns the new access token on success, or null if renewal failed.
 */
async function silentRenewToken(): Promise<string | null> {
  // Silent renewal needs a DOM (popup/iframe) to drive the IMS authorize
  // flow. The kernel-worker has no `window`, so bridge to the page realm
  // over panel-RPC: the page runs the renewal and persists the rotated
  // token via saveOAuthAccount, which fans back into the worker's
  // localStorage shim (issue #1181). When no bridge is published yet
  // (pre-attach boot) we fall back to null — oauth-bootstrap still
  // pre-renews tokens before the worker streams.
  if (typeof window === 'undefined') {
    const rpc = getPanelRpcClient();
    if (!rpc) return null;
    try {
      // Generous timeout: page-side renewal can drive a full IMS authorize
      // round-trip (matches the oauth-popup op's window).
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

  // Deduplicate concurrent renewal attempts
  if (renewalInProgress) return renewalInProgress;

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

  const redirectUri = isExtension
    ? (adobeConfig.extensionRedirectUri ??
      `https://${(chrome as { runtime: { id: string } }).runtime.id}.chromiumapp.org/`)
    : (adobeConfig.redirectUri ?? `${window.location.origin}/auth/callback`);

  // Build OAuth state with port and CSRF nonce for the sliccy.ai relay (CLI only)
  const oauthState = !isExtension
    ? btoa(
        JSON.stringify({
          port: parseInt(new URL(window.location.href).port || '5710', 10),
          path: '/auth/callback',
          nonce: crypto.randomUUID(),
        })
      )
    : undefined;
  const expectedNonce = oauthState ? JSON.parse(atob(oauthState)).nonce : null;

  const params = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
    response_type: 'token',
    redirect_uri: redirectUri,
    prompt: 'none', // Silent — no UI, relies on existing IMS session
  });
  if (oauthState) params.set('state', oauthState);
  const authorizeUrl = `${imsHost(imsEnv)}/ims/authorize/v2?${params}`;
  return { authorizeUrl, expectedNonce, proxyEndpoint };
}

/** Verify the CSRF nonce echoed back in the relay callback (CLI only). */
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
    // URL parse failure — continue (backwards compat with old localhost flow)
    console.warn(
      '[adobe] Nonce check skipped (URL parse failed):',
      err instanceof Error ? err.message : String(err)
    );
  }
  return true;
}

async function persistRenewedToken(
  tokenInfo: { accessToken: string; expiresIn: number },
  proxyEndpoint: string
): Promise<void> {
  // Save the renewed token. Preserve the baseUrl so getProxyEndpoint()
  // continues to resolve after a page reload wipes the in-memory cache.
  // Only pin when there is no bundled config — same rationale as onOAuthLogin.
  const account = getAdobeAccount();
  await saveOAuthAccount({
    providerId: 'adobe',
    accessToken: tokenInfo.accessToken,
    tokenExpiresAt: Date.now() + tokenInfo.expiresIn * 1000,
    userName: account?.userName,
    userAvatar: account?.userAvatar,
    baseUrl: adobeConfig.proxyEndpoint ? undefined : proxyEndpoint,
  });
}

async function performSilentRenewal(): Promise<string | null> {
  try {
    const proxyEndpoint = getProxyEndpoint();
    const proxyConfig = await fetchProxyConfig(proxyEndpoint);
    const { authorizeUrl, expectedNonce } = buildSilentRenewAuthorize(proxyEndpoint, proxyConfig);

    // Use the same launcher as normal login — handles CLI, extension, and Electron
    const { createOAuthLauncher } = await import('../src/providers/oauth-service.js');
    const launcher = createOAuthLauncher();
    // prompt=none needs no user interaction → drive the launcher silently.
    // In the extension this maps to launchWebAuthFlow({ interactive: false }).
    const redirectUrl = await launcher(authorizeUrl, { interactive: false });
    if (!redirectUrl) return null;
    if (!verifySilentRenewNonce(redirectUrl, expectedNonce)) return null;

    const tokenInfo = extractTokenFromUrl(redirectUrl);
    if (!tokenInfo) return null;

    await persistRenewedToken(tokenInfo, proxyEndpoint);
    console.log('[adobe] Token renewed silently');

    // Refresh model list to repopulate proxyMetadataCache (needed for
    // OpenAI-compatible model routing). Without this, getModelIds() falls
    // back to stale localStorage data that may lack the 'api' field.
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

// ── SLICC version header ─────────────────────────────────────────────

/**
 * Name of the header used to attribute Adobe LLM proxy traffic to a
 * specific SLICC build. Applied to every fetch the Adobe provider makes
 * against the proxy (`/v1/config`, `/v1/models`, and all LLM stream
 * requests) — IMS calls (`adobelogin.com`) intentionally don't get it.
 */
const SLICC_VERSION_HEADER = 'X-Slicc-Version';

/**
 * Merge the SLICC version header into the caller's stream options.
 * Caller-set headers (e.g. `X-Session-Id` from `scoop-context.ts`) are
 * preserved; the version header always wins on conflict so callers
 * cannot accidentally spoof it. HTTP headers are case-insensitive, so
 * we drop any case-variant of `X-Slicc-Version` from caller headers
 * before injecting ours — otherwise `fetch` would send both values
 * joined by `, ` and the proxy would see a spoofed value alongside ours.
 */
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

// ── X-Session-Id defense-in-depth ───────────────────────────────────

/**
 * Sentinel anchor for the daily-rotated UUID used when a caller didn't
 * attach `X-Session-Id`. Shared with the other purpose-anchored
 * fallbacks (`'ui-quick-llm'`, `'ui-new-session'`) — same shape, same
 * rotation cadence, no per-user info encoded.
 */
const ADOBE_PROVIDER_FALLBACK_ANCHOR = 'adobe-provider-fallback';

/** Dedup developer warnings per call site so hot paths don't spam the console. */
const warnedCallSites = new Set<string>();

/**
 * Defense-in-depth: every Adobe-bound LLM call MUST carry `X-Session-Id`.
 * The intended wiring attaches an anchor-specific id at the call site —
 * `scoop-context.ts` for cone/scoop traffic, `quick-llm.ts` for ad-hoc UI
 * labels, `new-session.ts` for the freezer, etc. If a new call site
 * slips through without one, fall back to a daily-rotated sentinel UUID
 * so the proxy can still group requests, rather than letting it hash
 * the content into an opaque hex id. The fallback intentionally collides
 * across all unwrapped paths within a browser-day — the value is "the
 * dev forgot the wrapper, fix it" not "this is a legitimate session."
 *
 * Caller-supplied values (any case variant) are always preserved.
 */
function ensureSessionIdHeader<T extends { headers?: ProviderHeaders }>(
  options: T,
  callSite: string
): T {
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      // A null value is pi-ai's "erase this header" convention — it does NOT
      // discharge the X-Session-Id invariant, so only a real value counts.
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

/** Test-only: clear the dedup set so warning-emission tests stay independent. */
export function __resetAdobeSessionIdWarningCacheForTests(): void {
  warnedCallSites.clear();
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

const streamAdobe = (
  model: Model<Api>,
  context: Context,
  options: AnthropicOptions | OpenAICompletionsOptions = {}
) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const isOpenAI = String(model.api).includes('openai');

      if (isOpenAI) {
        // Route to OpenAI Chat Completions API — append /v1 since the OpenAI SDK adds /chat/completions
        // pi-ai's detectCompat uses provider/baseUrl to identify non-standard providers,
        // but ours are overridden (provider='adobe', baseUrl=proxy). Set compat explicitly
        // to disable features unsupported by OpenAI-compatible backends (Cerebras, etc.)
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
        // Route to Anthropic Messages API
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
              // opus-4-8 quirks the pinned pi-ai doesn't know: it rejects
              // `temperature` (strip it), and needs adaptive thinking instead of
              // the legacy enabled+budget shape pi-ai emits (rewrite via onPayload).
              withAdaptiveThinkingShim(
                model,
                withSupportedTemperature(model.id, model.name, { ...options, apiKey: accessToken })
              ),
              'streamAdobe[anthropic]'
            )
            // Same cross-vocabulary cast as the openai branch above: `options`
            // arrives as the pi-ai-wide union; the agent layer only sends
            // anthropic-shaped options to an anthropic-routed model.
          ) as unknown as AnthropicOptions
        );
        for await (const event of inner) stream.push(event);
      }
      stream.end();
    } catch (error) {
      console.error(
        '[adobe] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as unknown as AssistantMessageEvent);
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleAdobe = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
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
        // Route to Anthropic Messages API
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
              // opus-4-8 quirks the pinned pi-ai doesn't know: it rejects
              // `temperature` (strip it — also covers thinking-disabled quick-llm
              // helpers), and needs adaptive thinking instead of the legacy
              // enabled+budget shape pi-ai emits (rewrite via onPayload).
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
      console.error(
        '[adobe] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as unknown as AssistantMessageEvent);
      stream.end();
    }
  })();
  return stream;
};

// ── Model list ──────────────────────────────────────────────────────

/**
 * Raw `/v1/models` entry as the proxy returns it. Trusted shape — the JSON is
 * cast to this once at the parse edge in `fetchProxyModels` (same trust level
 * as the previous blind `Record<string, unknown>` + field-by-field reads).
 */
type RawProxyModel = {
  id: string;
  name?: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
};

/** Pull the typed metadata fields off a raw proxy `/v1/models` entry. */
function toMetadataEntry(pm: RawProxyModel): AdobeModelMetadata {
  const entry: AdobeModelMetadata = { id: pm.id, name: pm.name };
  if (pm.api !== undefined) entry.api = pm.api;
  if (pm.context_window !== undefined) entry.context_window = pm.context_window;
  if (pm.max_tokens !== undefined) entry.max_tokens = pm.max_tokens;
  if (pm.reasoning !== undefined) entry.reasoning = pm.reasoning;
  if (pm.input !== undefined) entry.input = pm.input;
  return entry;
}

/** Lookup across all pi-ai providers (Anthropic, Cerebras, OpenAI, etc.). */
function buildPiAiModelMap(): Map<string, Model<Api>> {
  const modelMap = new Map<string, Model<Api>>();
  for (const provider of getProviders()) {
    try {
      for (const m of getModels(provider) as unknown as Model<Api>[]) modelMap.set(m.id, m);
    } catch {}
  }
  return modelMap;
}

/** Construct an Adobe-tagged Model from a proxy entry, reusing pi-ai metadata when present. */
function buildAdobeModel(
  pm: RawProxyModel,
  endpoint: string,
  modelMap: Map<string, Model<Api>>
): Model<Api> {
  // Determine API type from metadata or default to anthropic
  const apiType = pm.api === 'openai' ? 'openai' : 'anthropic';
  const customApi = `adobe-${apiType}` as Api;
  const base = modelMap.get(pm.id);
  if (base) return { ...base, provider: 'adobe', api: customApi };
  return {
    id: pm.id,
    name: pm.name ?? pm.id,
    provider: 'adobe',
    api: customApi,
    baseUrl: endpoint,
    contextWindow: 200000,
    maxTokens: 16384,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    reasoning: true,
  } as unknown as Model<Api>;
}

/** Map a successful `/v1/models` payload into the Adobe-tagged Model<Api>[] list,
 * populating `proxyMetadataCache` as a side effect for later use in `getModelIds()`. */
function processProxyModelsPayload(rawModels: RawProxyModel[], endpoint: string): Model<Api>[] {
  for (const pm of rawModels) proxyMetadataCache.set(pm.id, toMetadataEntry(pm));
  const modelMap = buildPiAiModelMap();
  return rawModels.map((pm) => buildAdobeModel(pm, endpoint, modelMap));
}

async function fetchProxyModels(accessToken?: string): Promise<Model<Api>[] | null> {
  try {
    // Pre-warm callers (cloud cone, before the account is persisted) pass the
    // token explicitly; everyone else reads it from the saved account.
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

  // Fetch failed / returned no models — signal failure (null) so getAdobeModels
  // can serve the Anthropic fallback WITHOUT caching it. Caching the fallback
  // here would poison modelsCache (which is never invalidated) for the whole
  // session, so a transient pre-warm failure would stick a degraded, 200K-window
  // list even after a valid token is available.
  return null;
}

const modelsCache = new Map<string, Model<Api>[]>();

/** Anthropic-registry models tagged as Adobe — the best-effort fallback when
 * the proxy `/v1/models` fetch fails. Intentionally NOT cached by callers. */
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
    modelsCache.set(endpoint, models); // cache only a real /v1/models success
    return models;
  }
  // Uncached fallback: a later call (with a valid saved token) retries and can
  // populate the real list.
  return adobeAnthropicFallbackModels();
}

// ── Registration ────────────────────────────────────────────────────

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

export { getValidAccessToken, isTokenExpired };
