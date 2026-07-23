/**
 * xAI Grok Provider — OAuth via the intercepted-redirect flow.
 *
 * Auth: piggybacks on xAI's public Grok-CLI OAuth client
 * (`b1a00492-073a-47ea-816f-4c329264a828`), the same client the official
 * `grok` TUI and hermes-agent both use. xAI's OIDC issuer
 * (https://auth.x.ai) only trusts loopback redirect URIs for this client,
 * so we send `redirect_uri=http://127.0.0.1:56121/callback`, intercept the
 * navigation to that URL via CDP, and never actually bind the port.
 *
 * The `plan=generic` query parameter is load-bearing — without it,
 * accounts.x.ai rejects non-Grok-CLI loopback flows. `referrer=slicc` is
 * informational attribution.
 *
 * Model catalog and API quirks come from pi-ai's built-in xAI provider. The
 * OAuth transport uses slicc's CDP interception since the webapp / extension
 * floats can't bind 127.0.0.1.
 */

import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  ProviderHeaders,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  getModels,
  registerApiProvider,
  streamOpenAICompletions,
  streamOpenAIResponses,
  streamSimpleOpenAICompletions,
  streamSimpleOpenAIResponses,
} from '@earendil-works/pi-ai/compat';
import type {
  InterceptingOAuthLauncher,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';
import { XaiErrorCode, XaiOAuthError } from './xai-grok-errors.js';

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_ID = 'xai-grok';

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
// Endpoints sourced from https://auth.x.ai/.well-known/openid-configuration
// (issuer-canonical). The grok CLI sees a redirect through
// `https://accounts.x.ai/oauth2/consent` after this initial authorize hit.
//
// TODO(oauth-discovery): replace these constants with runtime OIDC
// discovery (fetch `${ISSUER}/.well-known/openid-configuration`, validate
// endpoints belong to `*.x.ai`, cache on the OAuth account). Stnly's
// pi-grok already does this in `oauth.ts::discover()`. Even better: lift
// the pattern into `src/providers/oauth-service.ts` so any provider can
// declare `discoveryUrl: ...` instead of hardcoding endpoints.
const XAI_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
// Public Grok-CLI client. Same id appears in ~/.grok/auth.json and hermes.
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
const XAI_REDIRECT_PATTERN = 'http://127.0.0.1:56121/*';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';
// The api slicc tags each model with after `provider-settings.ts` rewrites
// `api: 'openai'` from `getModelIds()` to `${providerId}-${apiType}`.
// We register our streams under this name so the agent loop routes Grok
// turns to *us* for OAuth injection, not to pi-ai's stock OpenAI path.
// Same indirection trick as `built-in/local-llm.ts`.
const XAI_API: Api = `${PROVIDER_ID}-openai` as Api;

// ── Models ─────────────────────────────────────────────────────────

type NativeXaiModel = Model<'openai-completions'> | Model<'openai-responses'>;

function getNativeXaiModels(): Model<Api>[] {
  return getModels('xai') as Model<Api>[];
}

type ApiProviderRegistration = Parameters<typeof registerApiProvider>[0];

function toModelMetadata(model: Model<Api>) {
  return {
    id: model.id,
    name: model.name,
    api: 'openai' as const,
    reasoning: model.reasoning,
    input: model.input,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

function resolveNativeXaiModel(model: Model<Api>): NativeXaiModel {
  const nativeModel = getNativeXaiModels().find((candidate) => candidate.id === model.id);
  if (!nativeModel) {
    throw new Error(`xAI model "${model.id}" is not registered by pi-ai`);
  }
  if (nativeModel.api !== 'openai-responses' && nativeModel.api !== 'openai-completions') {
    throw new Error(`Unsupported pi-ai API "${nativeModel.api}" for xAI model "${model.id}"`);
  }
  return {
    ...model,
    ...nativeModel,
    baseUrl: XAI_API_BASE_URL,
  } as NativeXaiModel;
}

// ── PKCE helpers ───────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(32));
}

async function deriveCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return base64UrlEncode(digest);
}

function randomState(): string {
  return base64UrlEncode(randomBytes(16));
}

// ── Token exchange ─────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: XAI_REDIRECT_URI,
    client_id: XAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(XAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new XaiOAuthError(
      `xAI token exchange failed: ${res.status} ${await res.text()}`,
      XaiErrorCode.TOKEN_EXCHANGE_FAILED
    );
  }
  const payload = (await res.json()) as TokenResponse;
  if (!payload.access_token) {
    throw new XaiOAuthError(
      'xAI token exchange did not return access_token.',
      XaiErrorCode.TOKEN_EXCHANGE_INVALID
    );
  }
  return payload;
}

async function refreshToken(refresh: string): Promise<TokenResponse | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: XAI_OAUTH_CLIENT_ID,
    });
    const res = await fetch(XAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      console.error('[xai-grok] refresh failed:', res.status, await res.text());
      return null;
    }
    return (await res.json()) as TokenResponse;
  } catch (err) {
    console.error('[xai-grok] refresh error:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Account lookup ─────────────────────────────────────────────────

function getXaiAccount() {
  return getAccounts().find((a) => a.providerId === PROVIDER_ID);
}

async function getValidAccessToken(): Promise<string> {
  const account = getXaiAccount();
  if (!account?.accessToken) {
    throw new XaiOAuthError(
      'Not signed in to xAI Grok — run /login or `oauth-token xai-grok`',
      XaiErrorCode.AUTH_MISSING,
      true
    );
  }
  const expiresAt = account.tokenExpiresAt ?? 0;
  // Refresh 60s before expiry to keep streaming requests warm.
  if (expiresAt && Date.now() + 60_000 < expiresAt) {
    return account.accessToken;
  }
  if (account.refreshToken) {
    const refreshed = await refreshToken(account.refreshToken);
    if (refreshed?.access_token) {
      await saveOAuthAccount({
        providerId: PROVIDER_ID,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? account.refreshToken,
        tokenExpiresAt: Date.now() + (refreshed.expires_in ?? 21_600) * 1000,
      });
      return refreshed.access_token;
    }
  }
  return account.accessToken; // best-effort; xAI will 401 if revoked
}

// ── Stream functions ───────────────────────────────────────────────

function makeErrorOutput(model: Model<Api>, error: unknown): AssistantMessageEvent {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: XAI_API,
      provider: PROVIDER_ID,
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

/**
 * xAI routes requests with the same `x-grok-conv-id` to the same backend
 * shard for prompt-cache locality. Mirror stnly/pi-grok and tag every
 * stream with the slicc session ID when one is available.
 */
function withGrokConvHeader(
  base: ProviderHeaders | undefined,
  sessionId: string | undefined
): ProviderHeaders | undefined {
  if (!sessionId) return base;
  return { ...(base ?? {}), 'x-grok-conv-id': sessionId };
}

const streamXai = (model: Model<Api>, context: Context, options: ProviderStreamOptions = {}) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const sessionId = (options as { sessionId?: string }).sessionId;
      const nativeModel = resolveNativeXaiModel(model);
      const forwardedOptions = {
        ...options,
        apiKey: accessToken,
        headers: withGrokConvHeader(options.headers, sessionId),
      };
      const inner =
        nativeModel.api === 'openai-responses'
          ? streamOpenAIResponses(nativeModel, context, forwardedOptions)
          : streamOpenAICompletions(nativeModel, context, forwardedOptions);
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[xai-grok] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error));
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleXai = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const sessionId = (options as { sessionId?: string } | undefined)?.sessionId;
      const nativeModel = resolveNativeXaiModel(model);
      const forwardedOptions: SimpleStreamOptions = {
        ...options,
        apiKey: accessToken,
        headers: withGrokConvHeader(options?.headers, sessionId),
      };
      const inner =
        nativeModel.api === 'openai-responses'
          ? streamSimpleOpenAIResponses(nativeModel, context, forwardedOptions)
          : streamSimpleOpenAICompletions(nativeModel, context, forwardedOptions);
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[xai-grok] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error));
      stream.end();
    }
  })();
  return stream;
};

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'xAI Grok (SuperGrok OAuth)',
  description:
    'Grok via xAI OAuth — uses your SuperGrok subscription, no API key needed. Default model is Grok 4.5.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'grok-4.5',
  oauthTokenDomains: ['api.x.ai', '*.x.ai', 'auth.x.ai', 'accounts.x.ai'],
  getModelIds: () => getNativeXaiModels().map(toModelMetadata),

  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    const state = randomState();
    const nonce = randomState();

    const authorize = new URL(XAI_AUTHORIZE_URL);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', XAI_OAUTH_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', XAI_REDIRECT_URI);
    authorize.searchParams.set('scope', options?.scopes ?? XAI_OAUTH_SCOPE);
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', nonce);
    // plan=generic is required for non-Grok-CLI loopback flows; see hermes
    // auth.py comment on `_xai_oauth_build_authorize_url`.
    authorize.searchParams.set('plan', 'generic');
    authorize.searchParams.set('referrer', 'slicc');

    const captured = await launcher({
      authorizeUrl: authorize.toString(),
      redirectUriPattern: XAI_REDIRECT_PATTERN,
      onCapture: 'close',
    });
    if (!captured) {
      throw new XaiOAuthError(
        'xAI OAuth login was cancelled or timed out',
        XaiErrorCode.CALLBACK_TIMEOUT
      );
    }

    const parsed = new URL(captured);
    const code = parsed.searchParams.get('code');
    const returnedState = parsed.searchParams.get('state');
    if (!code) {
      throw new XaiOAuthError(
        'xAI OAuth redirect did not include a code',
        XaiErrorCode.CODE_MISSING
      );
    }
    if (returnedState !== state) {
      throw new XaiOAuthError(
        'xAI OAuth state mismatch — possible CSRF, aborting',
        XaiErrorCode.STATE_MISMATCH
      );
    }

    const tokens = await exchangeCode(code, codeVerifier);
    await saveOAuthAccount({
      providerId: PROVIDER_ID,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in ?? 21_600) * 1000,
      baseUrl: XAI_API_BASE_URL,
    });
    onSuccess();
  },

  onOAuthLogout: async () => {
    await saveOAuthAccount({ providerId: PROVIDER_ID, accessToken: '' });
  },

  onSilentRenew: async () => {
    const account = getXaiAccount();
    if (!account?.refreshToken) return null;
    const refreshed = await refreshToken(account.refreshToken);
    if (!refreshed?.access_token) return null;
    await saveOAuthAccount({
      providerId: PROVIDER_ID,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? account.refreshToken,
      tokenExpiresAt: Date.now() + (refreshed.expires_in ?? 21_600) * 1000,
    });
    return refreshed.access_token;
  },
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: XAI_API,
    stream: streamXai as ApiProviderRegistration['stream'],
    streamSimple: streamSimpleXai as ApiProviderRegistration['streamSimple'],
  });
}

export { XaiErrorCode, XaiOAuthError };
