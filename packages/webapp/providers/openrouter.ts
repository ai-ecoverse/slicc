/**
 * OpenRouter OAuth provider and OpenAI-compatible stream routing.
 *
 * The PKCE and catalog helpers are adapted from espennilsen/pi's
 * MIT-licensed pi-openrouter extension:
 * https://github.com/espennilsen/pi/tree/main/extensions/pi-openrouter
 */

import type {
  Api,
  Context,
  Model,
  ProviderHeaders,
  ProviderStreamOptions,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  registerApiProvider,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
} from '@earendil-works/pi-ai/compat';
import { getApiKeyForProvider } from '../src/providers/account-store.js';
import type {
  InterceptingOAuthLauncher,
  OAuthLoginOptions,
  ProviderConfig,
} from '../src/providers/types.js';
import { saveOAuthAccount } from '../src/ui/provider-settings.js';
import { fetchModels, getCatalog } from './openrouter-models.js';
import { loginIntercepted } from './openrouter-oauth.js';

const PROVIDER_ID = 'openrouter';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENAI_COMPLETIONS_API: Api = 'openai-completions';
const OPENROUTER_API: Api = `${PROVIDER_ID}-openai` as Api;
const ATTRIBUTION_HEADERS: ProviderHeaders = {
  'HTTP-Referer': 'https://sliccy.ai',
  'X-Title': 'SLICC',
};

function asOpenRouterModel(model: Model<Api>): Model<'openai-completions'> {
  return {
    ...model,
    baseUrl: OPENROUTER_BASE_URL,
    api: OPENAI_COMPLETIONS_API,
  } as Model<'openai-completions'>;
}

function withAttribution(headers?: ProviderHeaders): ProviderHeaders {
  return { ...(headers ?? {}), ...ATTRIBUTION_HEADERS };
}

const streamOpenRouter = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions = {}
) =>
  streamOpenAICompletions(asOpenRouterModel(model), context, {
    ...options,
    apiKey: getApiKeyForProvider(PROVIDER_ID) ?? options.apiKey,
    headers: withAttribution(options.headers),
  });

const streamSimpleOpenRouter = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {}
) =>
  streamSimpleOpenAICompletions(asOpenRouterModel(model), context, {
    ...options,
    apiKey: getApiKeyForProvider(PROVIDER_ID) ?? options.apiKey,
    headers: withAttribution(options.headers),
  });

export const config: ProviderConfig = {
  id: PROVIDER_ID,
  name: 'OpenRouter',
  description: 'Access OpenRouter models with one-click PKCE login. No pasted API key is required.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'anthropic/claude-sonnet-4.6',
  oauthTokenDomains: ['openrouter.ai', '*.openrouter.ai'],
  getModelIds: getCatalog,
  refreshModels: async () => {
    await fetchModels();
  },
  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    await loginIntercepted(launcher, () => undefined, options);
    // The permanent key is already stored; fall back to the seed catalog if refresh fails.
    await fetchModels().catch(() => undefined);
    onSuccess();
  },
  onOAuthLogout: async () => {
    await saveOAuthAccount({ providerId: PROVIDER_ID, accessToken: '' });
  },
};

export function register(): void {
  registerApiProvider({
    api: OPENROUTER_API,
    stream: streamOpenRouter as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleOpenRouter as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}
