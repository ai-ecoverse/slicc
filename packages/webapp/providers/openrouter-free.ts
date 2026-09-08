/**
 * OpenRouter (Free) provider — currently free multimodal tool-calling models.
 *
 * Reuses OpenRouter PKCE login and OpenAI-compatible streaming; the catalog is
 * filtered from the shared `/api/v1/models` cache to models that are free,
 * accept text+image, emit text, and advertise tools/temperature/top_p.
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
import { FREE_ROUTER_FALLBACK, fetchModels, getFreeCatalog } from './openrouter-models.js';
import { loginIntercepted } from './openrouter-oauth.js';

const PROVIDER_ID = 'openrouter-free';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENAI_COMPLETIONS_API: Api = 'openai-completions';
const OPENROUTER_FREE_API: Api = `${PROVIDER_ID}-openai` as Api;
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

const streamOpenRouterFree = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions = {}
) =>
  streamOpenAICompletions(asOpenRouterModel(model), context, {
    ...options,
    apiKey: getApiKeyForProvider(PROVIDER_ID) ?? options.apiKey,
    headers: withAttribution(options.headers),
  });

const streamSimpleOpenRouterFree = (
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
  name: 'OpenRouter (Free)',
  description:
    'Currently free OpenRouter models that support vision and tools. Catalog refreshes from OpenRouter; paid models are excluded.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: FREE_ROUTER_FALLBACK.id,
  oauthTokenDomains: ['openrouter.ai', '*.openrouter.ai'],
  getModelIds: getFreeCatalog,
  refreshModels: async () => {
    await fetchModels();
  },
  onOAuthLoginIntercepted: async (
    launcher: InterceptingOAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    await loginIntercepted(launcher, () => undefined, {
      ...options,
      providerId: PROVIDER_ID,
    });
    await fetchModels().catch(() => undefined);
    onSuccess();
  },
  onOAuthLogout: async () => {
    await saveOAuthAccount({ providerId: PROVIDER_ID, accessToken: '' });
  },
};

export function register(): void {
  registerApiProvider({
    api: OPENROUTER_FREE_API,
    stream: streamOpenRouterFree as Parameters<typeof registerApiProvider>[0]['stream'],
    streamSimple: streamSimpleOpenRouterFree as Parameters<
      typeof registerApiProvider
    >[0]['streamSimple'],
  });
}
