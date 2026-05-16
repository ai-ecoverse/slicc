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
 * Default model: Grok Heavy (grok-4.20-multi-agent-0309).
 */

import type {
  ProviderConfig,
  InterceptingOAuthLauncher,
  OAuthLoginOptions,
  ModelMetadata,
} from '../src/providers/types.js';
import {
  registerApiProvider,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  OpenAICompletionsOptions,
} from '@earendil-works/pi-ai';
import { saveOAuthAccount, getAccounts } from '../src/ui/provider-settings.js';

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_ID = 'xai-grok';

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/auth`;
const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
// Public Grok-CLI client. Same id appears in ~/.grok/auth.json and hermes.
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
const XAI_REDIRECT_PATTERN = 'http://127.0.0.1:56121/*';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';

// ── Models ─────────────────────────────────────────────────────────

const XAI_MODELS: Array<{ id: string; name: string } & ModelMetadata> = [
  {
    // Grok Heavy — xAI's multi-agent reasoning SKU; the user pinned this
    // dated id rather than relying on an undated alias.
    id: 'grok-4.20-multi-agent-0309',
    name: 'Grok Heavy',
    api: 'openai',
    context_window: 256_000,
    max_tokens: 32_768,
    reasoning: true,
    input: ['text', 'image'],
  },
  {
    id: 'grok-4.20-0309-reasoning',
    name: 'Grok 4.20 (reasoning)',
    api: 'openai',
    context_window: 256_000,
    max_tokens: 32_768,
    reasoning: true,
    input: ['text', 'image'],
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    name: 'Grok 4.20',
    api: 'openai',
    context_window: 256_000,
    max_tokens: 32_768,
    reasoning: false,
    input: ['text', 'image'],
  },
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    api: 'openai',
    context_window: 256_000,
    max_tokens: 32_768,
    reasoning: true,
    input: ['text', 'image'],
  },
];

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
    throw new Error(`xAI token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
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
    throw new Error('Not signed in to xAI Grok — run /login or `oauth-token xai-grok`');
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

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: 'xai-openai' as Api,
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

const streamXai = (model: Model<Api>, context: Context, options: OpenAICompletionsOptions = {}) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = {
        ...model,
        baseUrl: XAI_API_BASE_URL,
        api: 'openai-completions' as Api,
        compat: {
          ...(model as any).compat,
          maxTokensField: 'max_tokens',
        },
      };
      const inner = streamOpenAICompletions(proxyModel as any, context, {
        ...options,
        apiKey: accessToken,
      } as any);
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      console.error(
        '[xai-grok] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as any);
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
      const proxyModel = {
        ...model,
        baseUrl: XAI_API_BASE_URL,
        api: 'openai-completions' as Api,
        compat: { ...(model as any).compat, maxTokensField: 'max_tokens' },
      };
      const inner = streamSimpleOpenAICompletions(proxyModel as any, context, {
        ...options,
        apiKey: accessToken,
      } as any);
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      console.error(
        '[xai-grok] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as any);
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
    'Grok via xAI OAuth — uses your SuperGrok subscription, no API key needed. Default model is Grok Heavy.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'grok-4.20-multi-agent-0309',
  oauthTokenDomains: ['api.x.ai', '*.x.ai', 'auth.x.ai', 'accounts.x.ai'],
  getModelIds: () => XAI_MODELS,

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
      throw new Error('xAI OAuth login was cancelled or timed out');
    }

    const parsed = new URL(captured);
    const code = parsed.searchParams.get('code');
    const returnedState = parsed.searchParams.get('state');
    if (!code) throw new Error('xAI OAuth redirect did not include a code');
    if (returnedState !== state) {
      throw new Error('xAI OAuth state mismatch — possible CSRF, aborting');
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
    api: 'xai-openai' as Api,
    stream: streamXai as any,
    streamSimple: streamSimpleXai as any,
  });
}
