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
import {
  bridgeRefreshBlocked,
  noteBridgeTokenRequired,
} from '../src/providers/bridge-token-required.js';
import { deriveCodeChallenge, generateCodeVerifier, randomState } from '../src/providers/pkce.js';
import type {
  InterceptingOAuthLauncher,
  ModelMetadata,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';

const PROVIDER_ID = 'openai-codex';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_SCOPE = 'openid profile email offline_access';

const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_REDIRECT_PATTERN = 'http://localhost:1455/auth/callback*';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

const OPENAI_CODEX_RESPONSES_API: Api = 'openai-codex-responses';

const CODEX_API: Api = `${PROVIDER_ID}-openai` as Api;

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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
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
  if (bridgeRefreshBlocked()) return null;
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
      const text = await res.text();
      if (noteBridgeTokenRequired(res.status, text)) return null;
      console.error('[openai-codex] refresh failed:', res.status, text);
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

interface OpenAICodexJwtProfile {
  email?: string;
}

interface OpenAICodexJwtAuth {
  chatgpt_plan_type?: string;
}

interface OpenAICodexJwtPayload {
  'https://api.openai.com/profile'?: OpenAICodexJwtProfile;
  'https://api.openai.com/auth'?: OpenAICodexJwtAuth;
}

function decodeJwtPayload(token: string): OpenAICodexJwtPayload | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    let b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    if (b64.length % 4) b64 += '='.repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64)) as OpenAICodexJwtPayload;
  } catch {
    return undefined;
  }
}

function getEmail(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const email = payload?.['https://api.openai.com/profile']?.email;
  return typeof email === 'string' ? email : undefined;
}

function getDisplayName(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const email = getEmail(accessToken);
  const plan = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
  if (email && planLabel) return `${email} (${planLabel})`;
  if (email) return email;
  if (planLabel) return `ChatGPT ${planLabel}`;
  return undefined;
}

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

function getCodexAccount() {
  return getAccounts().find((a) => a.providerId === PROVIDER_ID);
}

async function getValidAccessToken(): Promise<string> {
  const account = getCodexAccount();
  if (!account?.accessToken) {
    throw new Error('Not signed in to OpenAI Codex — run `oauth-token openai-codex` or /login');
  }
  const expiresAt = account.tokenExpiresAt ?? 0;

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
        scopes: refreshed.scope ?? account.scopes,
      });
      return refreshed.access_token;
    }
  }
  return account.accessToken;
}

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

type CodexEventStream = ReturnType<typeof createAssistantMessageEventStream>;

function logStreamError(error: unknown): void {
  console.error(
    '[openai-codex] Stream error:',
    error instanceof Error ? error.message : String(error)
  );
}

async function pumpCodexStream(
  stream: CodexEventStream,
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions
): Promise<void> {
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
    logStreamError(error);
    stream.push(makeErrorOutput(model, error) as never);
    stream.end();
  }
}

async function pumpSimpleCodexStream(
  stream: CodexEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): Promise<void> {
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
    logStreamError(error);
    stream.push(makeErrorOutput(model, error) as never);
    stream.end();
  }
}

const streamCodex = (model: Model<Api>, context: Context, options: ProviderStreamOptions = {}) => {
  const stream = createAssistantMessageEventStream();

  pumpCodexStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

const streamSimpleCodex = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();

  pumpSimpleCodexStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

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

      scopes: tokens.scope,
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
      scopes: refreshed.scope ?? account.scopes,
    });
    return refreshed.access_token;
  },
};

export function register(): void {
  registerApiProvider({
    api: CODEX_API,
    stream: streamCodex as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleCodex as Parameters<typeof registerApiProvider>[0]['streamSimple'],
  });
}
