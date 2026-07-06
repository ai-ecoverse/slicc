/**
 * OpenAI Codex Provider — ChatGPT (Codex subscription) OAuth via the
 * intercepted-redirect flow.
 *
 * Auth: reuses OpenAI's public Codex-CLI OAuth client
 * (`app_EMoamEEZ73f0CkXaXp7hrann`), the same client pi-ai's CLI codex
 * login and the official `codex` CLI use. OpenAI's OAuth client only
 * trusts the loopback redirect `http://localhost:1455/auth/callback`, so
 * we send that as `redirect_uri`, intercept the navigation to it via CDP
 * `Fetch.requestPaused`, and never bind the port. This is the browser
 * equivalent of pi-ai's `loginOpenAICodex`, which binds a Node `http`
 * server on :1455 and is therefore CLI-only.
 *
 * Endpoints, client id, scopes, and the `codex_cli_simplified_flow` /
 * `id_token_add_organizations` authorize params mirror
 * `@earendil-works/pi-ai`'s `utils/oauth/openai-codex.ts`.
 *
 * Models + streaming delegate to pi-ai's `openai-codex-responses` API
 * (`streamOpenAICodexResponses`). The account id is carried inside the
 * access-token JWT (`https://api.openai.com/auth.chatgpt_account_id`) and
 * re-extracted by the stream function, so we only persist the tokens.
 * Transport is forced to `sse`: browser `WebSocket` can't set the
 * `Authorization` / `chatgpt-account-id` headers the WebSocket transport
 * needs, so we skip the doomed WS attempt and stream over fetch (which
 * also routes through slicc's LLM proxy for the cross-origin call).
 */

import type {
  Api,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  registerApiProvider,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from '@earendil-works/pi-ai/compat';
import type {
  InterceptingOAuthLauncher,
  ModelMetadata,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';

// ── Constants ──────────────────────────────────────────────────────

const PROVIDER_ID = 'openai-codex';

// Public Codex-CLI OAuth client. Same id appears in pi-ai's codex login
// and the official codex CLI.
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_SCOPE = 'openid profile email offline_access';
// OpenAI only trusts this loopback redirect for the Codex-CLI client.
const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_REDIRECT_PATTERN = 'http://localhost:1455/auth/callback*';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
// pi-ai's actual codex responses-API name — used when we delegate to
// `streamOpenAICodexResponses` after auth.
const OPENAI_CODEX_RESPONSES_API: Api = 'openai-codex-responses';
// The api slicc tags each model with: `provider-settings.ts` rewrites
// `api: 'openai'` from `getModelIds()` to `${providerId}-openai`. We
// register our streams under this name so the agent loop routes codex
// turns to *us* (OAuth + sse transport), not to a stock OpenAI path.
// Same indirection as `xai-grok.ts` / `built-in/local-llm.ts`.
const CODEX_API: Api = `${PROVIDER_ID}-openai` as Api;

// ── Models ─────────────────────────────────────────────────────────
//
// Mirrors the `openai-codex` catalog shipped in pi-ai's
// `models.generated`. `thinkingLevelMap` is a `ModelMetadata` field that
// `applyModelMetadata` (in `provider-settings.ts`) merges onto the model
// record — the codex stream reads `model.thinkingLevelMap` to translate
// the reasoning effort, so the `minimal` → `low` remap below must survive
// the metadata merge (the chatgpt Codex backend rejects `minimal`).

type CodexModelDef = { id: string; name: string } & ModelMetadata;

const CODEX_THINKING_LEVEL_MAP: Record<string, string | null> = { xhigh: 'xhigh', minimal: 'low' };

const CODEX_MODELS: CodexModelDef[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', input: ['text', 'image'] },
  { id: 'gpt-5.4', name: 'GPT-5.4', input: ['text', 'image'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', input: ['text', 'image'] },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', input: ['text', 'image'] },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', input: ['text'] },
  { id: 'gpt-5.2', name: 'GPT-5.2', input: ['text', 'image'] },
].map((m) => ({
  ...m,
  api: 'openai' as const,
  reasoning: true,
  context_window: 272000,
  max_tokens: 128000,
  thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
}));

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
    client_id: CODEX_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    redirect_uri: CODEX_REDIRECT_URI,
  });
  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`OpenAI Codex token exchange failed: ${res.status} ${await res.text()}`);
  }
  const payload = (await res.json()) as TokenResponse;
  if (!payload.access_token) {
    throw new Error('OpenAI Codex token exchange did not return access_token.');
  }
  return payload;
}

async function refreshAccessToken(refresh: string): Promise<TokenResponse | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CODEX_CLIENT_ID,
    });
    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      console.error('[openai-codex] refresh failed:', res.status, await res.text());
      return null;
    }
    return (await res.json()) as TokenResponse;
  } catch (err) {
    console.error(
      '[openai-codex] refresh error:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── JWT display name (for the account picker) ──────────────────────
//
// The access token is a JWT whose `https://api.openai.com/profile` claim
// carries the account email and whose `https://api.openai.com/auth` claim
// carries the ChatGPT plan type. We surface `email (Plan)` so the picker
// reads like "lars@example.com (Team)" rather than the raw account UUID.
// The stream function re-derives the account id from the token itself, so
// we only persist a human-friendly label here.

// JWT segments are base64url (RFC 7515): `-`/`_` instead of `+`/`/` and no
// padding. `atob` only accepts standard base64, so restore the alphabet and
// pad before decoding — otherwise valid tokens whose payload happens to
// contain those characters throw and we silently drop the profile metadata.
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    let b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    if (b64.length % 4) b64 += '='.repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function getEmail(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const profile = payload?.['https://api.openai.com/profile'] as { email?: unknown } | undefined;
  return typeof profile?.email === 'string' ? profile.email : undefined;
}

function getDisplayName(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'] as
    | { chatgpt_plan_type?: unknown }
    | undefined;
  const email = getEmail(accessToken);
  const plan = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
  if (email && planLabel) return `${email} (${planLabel})`;
  if (email) return email;
  if (planLabel) return `ChatGPT ${planLabel}`;
  return undefined;
}

// ── Profile picture (Gravatar) ─────────────────────────────────────
//
// OpenAI's token carries only the email — its `userinfo` endpoint returns
// just `sub`, and `chatgpt.com/backend-api/me` is Cloudflare-gated (403
// to non-browser clients, CORS-blocked from the page). Gravatar is the
// portable, email-keyed avatar API: we hash the verified email and point
// the avatar `<img>` at it with `d=404`, so accounts that have a Gravatar
// show their photo and everyone else falls through to initials (the
// avatar element's `error` handler swaps in `initialsFromLabel`).

async function getUserAvatar(accessToken: string): Promise<string | undefined> {
  const email = getEmail(accessToken);
  if (!email) return undefined;
  try {
    const normalized = email.trim().toLowerCase();
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
    );
    const hex = Array.from(digest)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `https://www.gravatar.com/avatar/${hex}?s=128&d=404`;
  } catch {
    return undefined;
  }
}

// ── Account lookup ─────────────────────────────────────────────────

function getCodexAccount() {
  return getAccounts().find((a) => a.providerId === PROVIDER_ID);
}

async function getValidAccessToken(): Promise<string> {
  const account = getCodexAccount();
  if (!account?.accessToken) {
    throw new Error('Not signed in to OpenAI Codex — run `oauth-token openai-codex` or /login');
  }
  const expiresAt = account.tokenExpiresAt ?? 0;
  // Refresh 60s before expiry to keep streaming requests warm.
  if (expiresAt && Date.now() + 60_000 < expiresAt) {
    return account.accessToken;
  }
  if (account.refreshToken) {
    const refreshed = await refreshAccessToken(account.refreshToken);
    if (refreshed?.access_token) {
      await saveOAuthAccount({
        providerId: PROVIDER_ID,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? account.refreshToken,
        tokenExpiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
        baseUrl: CODEX_BASE_URL,
        userName: getDisplayName(refreshed.access_token),
        userAvatar: await getUserAvatar(refreshed.access_token),
      });
      return refreshed.access_token;
    }
  }
  return account.accessToken; // best-effort; OpenAI will 401 if revoked
}

// ── Stream functions ───────────────────────────────────────────────

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: CODEX_API,
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

const streamCodex = (model: Model<Api>, context: Context, options: ProviderStreamOptions = {}) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = {
        ...model,
        baseUrl: CODEX_BASE_URL,
        api: OPENAI_CODEX_RESPONSES_API,
      } as Model<'openai-codex-responses'>;
      const inner = streamOpenAICodexResponses(proxyModel, context, {
        ...options,
        apiKey: accessToken,
        transport: 'sse',
      });
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[openai-codex] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as never);
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleCodex = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = {
        ...model,
        baseUrl: CODEX_BASE_URL,
        api: OPENAI_CODEX_RESPONSES_API,
      } as Model<'openai-codex-responses'>;
      const inner = streamSimpleOpenAICodexResponses(proxyModel, context, {
        ...options,
        apiKey: accessToken,
        transport: 'sse',
      } as SimpleStreamOptions);
      for await (const event of inner) stream.push(event);
      stream.end();
    } catch (error) {
      console.error(
        '[openai-codex] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as never);
      stream.end();
    }
  })();
  return stream;
};

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'OpenAI Codex (ChatGPT Subscription)',
  description:
    'GPT-5 Codex via your ChatGPT Plus/Pro/Business subscription — OAuth login, no API key needed. Default model is GPT-5.5.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'gpt-5.5',
  oauthTokenDomains: ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com', 'api.openai.com'],
  getModelIds: () => CODEX_MODELS,

  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await deriveCodeChallenge(codeVerifier);
    const state = randomState();

    const authorize = new URL(CODEX_AUTHORIZE_URL);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', CODEX_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', CODEX_REDIRECT_URI);
    authorize.searchParams.set('scope', options?.scopes ?? CODEX_SCOPE);
    authorize.searchParams.set('code_challenge', codeChallenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', state);
    // Codex-CLI authorize params — see pi-ai's createAuthorizationFlow.
    authorize.searchParams.set('id_token_add_organizations', 'true');
    authorize.searchParams.set('codex_cli_simplified_flow', 'true');
    authorize.searchParams.set('originator', 'pi');

    const captured = await launcher({
      authorizeUrl: authorize.toString(),
      redirectUriPattern: CODEX_REDIRECT_PATTERN,
      onCapture: 'close',
    });
    if (!captured) {
      throw new Error('OpenAI Codex OAuth login was cancelled or timed out');
    }

    const parsed = new URL(captured);
    const code = parsed.searchParams.get('code');
    const returnedState = parsed.searchParams.get('state');
    if (!code) {
      throw new Error('OpenAI Codex OAuth redirect did not include a code');
    }
    // Strict equality (matching the Codex CLI): a callback without `state` —
    // e.g. a stray or forged navigation to the loopback redirect during a
    // pending login — must be rejected exactly like a mismatched value, or
    // the CSRF binding for this intercepted browser redirect is lost.
    if (returnedState !== state) {
      throw new Error('OpenAI Codex OAuth state mismatch — possible CSRF, aborting');
    }

    const tokens = await exchangeCode(code, codeVerifier);
    await saveOAuthAccount({
      providerId: PROVIDER_ID,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      baseUrl: CODEX_BASE_URL,
      userName: getDisplayName(tokens.access_token),
      userAvatar: await getUserAvatar(tokens.access_token),
    });
    onSuccess();
  },

  onOAuthLogout: async () => {
    await saveOAuthAccount({ providerId: PROVIDER_ID, accessToken: '' });
  },

  onSilentRenew: async () => {
    const account = getCodexAccount();
    if (!account?.refreshToken) return null;
    const refreshed = await refreshAccessToken(account.refreshToken);
    if (!refreshed?.access_token) return null;
    await saveOAuthAccount({
      providerId: PROVIDER_ID,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? account.refreshToken,
      tokenExpiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      baseUrl: CODEX_BASE_URL,
      userName: getDisplayName(refreshed.access_token),
      userAvatar: await getUserAvatar(refreshed.access_token),
    });
    return refreshed.access_token;
  },
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: CODEX_API,
    stream: streamCodex as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleCodex as Parameters<typeof registerApiProvider>[0]['streamSimple'],
  });
}
