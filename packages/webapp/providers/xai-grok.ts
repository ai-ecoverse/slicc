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
import { deriveCodeChallenge, generateCodeVerifier, randomState } from '../src/providers/pkce.js';
import type { ProviderBudgetWindow } from '../src/providers/provider-budget.js';
import type {
  InterceptingOAuthLauncher,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { fetchXaiGrokUsage } from '../src/providers/xai-grok-usage.js';
import { getAccounts, saveOAuthAccount } from '../src/ui/provider-settings.js';
import { XaiErrorCode, XaiOAuthError } from './xai-grok-errors.js';

const PROVIDER_ID = 'xai-grok';

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';

const XAI_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;

const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
const XAI_REDIRECT_PATTERN = 'http://127.0.0.1:56121/*';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';
const XAI_DEFAULT_MODEL_ID = 'grok-4.7';

const XAI_API: Api = `${PROVIDER_ID}-openai` as Api;

type NativeXaiModel = Model<'openai-completions'> | Model<'openai-responses'>;

function catalogWithDefaultOverlay(nativeModels: Model<Api>[]): Model<Api>[] {
  if (nativeModels.some((model) => model.id === XAI_DEFAULT_MODEL_ID)) return nativeModels;
  const sibling =
    nativeModels.find((model) => model.id === 'grok-4.6') ??
    nativeModels.find((model) => model.api === 'openai-responses') ??
    nativeModels[0];
  if (!sibling) return nativeModels;
  const overlay: Model<Api> = {
    ...sibling,
    id: XAI_DEFAULT_MODEL_ID,
    name: 'Grok 4.7',
    api: 'openai-responses',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    },
  };
  return [overlay, ...nativeModels];
}

function getNativeXaiModels(): Model<Api>[] {
  return catalogWithDefaultOverlay(getModels('xai') as Model<Api>[]);
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

    cost: model.cost,
  };
}

function resolveNativeXaiModel(model: Model<Api>): NativeXaiModel {
  const nativeModels = getNativeXaiModels();
  let nativeModel = nativeModels.find((candidate) => candidate.id === model.id);
  if (!nativeModel) {
    console.warn(
      `xAI model "${model.id}" is no longer in the pi-ai catalog; falling back to default "${XAI_DEFAULT_MODEL_ID}"`
    );
    nativeModel = nativeModels.find((candidate) => candidate.id === XAI_DEFAULT_MODEL_ID);
    if (!nativeModel) {
      throw new Error(`xAI default model "${XAI_DEFAULT_MODEL_ID}" is not registered by pi-ai`);
    }
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
        scopes: refreshed.scope ?? account.scopes,
      });
      return refreshed.access_token;
    }
  }
  return account.accessToken;
}

async function getBudgetUsage(): Promise<ProviderBudgetWindow | null> {
  if (!getXaiAccount()?.accessToken) throw new Error('xAI Grok budget: not signed in');
  return fetchXaiGrokUsage(await getValidAccessToken(), fetch);
}

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

function withGrokConvHeader(
  base: ProviderHeaders | undefined,
  sessionId: string | undefined
): ProviderHeaders | undefined {
  if (!sessionId) return base;
  return { ...(base ?? {}), 'x-grok-conv-id': sessionId };
}

type XaiEventStream = ReturnType<typeof createAssistantMessageEventStream>;

function logStreamError(error: unknown): void {
  console.error('[xai-grok] Stream error:', error instanceof Error ? error.message : String(error));
}

async function pumpXaiStream(
  stream: XaiEventStream,
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions
): Promise<void> {
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
    logStreamError(error);
    stream.push(makeErrorOutput(model, error));
    stream.end();
  }
}

async function pumpSimpleXaiStream(
  stream: XaiEventStream,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): Promise<void> {
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
    logStreamError(error);
    stream.push(makeErrorOutput(model, error));
    stream.end();
  }
}

const streamXai = (model: Model<Api>, context: Context, options: ProviderStreamOptions = {}) => {
  const stream = createAssistantMessageEventStream();

  pumpXaiStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

const streamSimpleXai = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();

  pumpSimpleXaiStream(stream, model, context, options).catch(logStreamError);
  return stream;
};

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'xAI Grok (SuperGrok OAuth)',
  description:
    'Grok via xAI OAuth — uses your SuperGrok subscription, no API key needed. Default model is Grok 4.7.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: XAI_DEFAULT_MODEL_ID,

  oauthTokenDomains: [
    'api.x.ai',
    '*.x.ai',
    'auth.x.ai',
    'accounts.x.ai',
    'cli-chat-proxy.grok.com',
  ],
  getModelIds: () => getNativeXaiModels().map(toModelMetadata),
  getBudgetUsage,

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

      scopes: tokens.scope,
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
      scopes: refreshed.scope ?? account.scopes,
    });
    return refreshed.access_token;
  },
};

export function register(): void {
  registerApiProvider({
    api: XAI_API,
    stream: streamXai as ApiProviderRegistration['stream'],
    streamSimple: streamSimpleXai as ApiProviderRegistration['streamSimple'],
  });
}

export { XaiErrorCode, XaiOAuthError };
