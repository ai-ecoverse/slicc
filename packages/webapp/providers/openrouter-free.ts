/**
 * OpenRouter (Free) provider — currently free multimodal tool-calling models.
 *
 * Reuses OpenRouter PKCE login and OpenAI-compatible streaming; the catalog is
 * filtered from the shared `/api/v1/models` cache to models that are free,
 * accept text+image, emit text, and advertise tools/temperature/top_p.
 *
 * Stream functions re-check {@link isModelInFreeCatalog} so a cone that kept a
 * previously free model cannot call OpenRouter after that model is repriced.
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
  createAssistantMessageEventStream,
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
import {
  FREE_ROUTER_FALLBACK,
  fetchModels,
  getFreeCatalog,
  isModelInFreeCatalog,
} from './openrouter-models.js';
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

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: OPENROUTER_FREE_API,
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

function refuseNonFreeModel(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const error = new Error(
    `OpenRouter (Free) refused "${model.id}" — it is not in the current free catalog. Choose another free model or refresh the catalog.`
  );
  queueMicrotask(() => {
    stream.push(makeErrorOutput(model, error) as never);
    stream.end();
  });
  return stream;
}

const streamOpenRouterFree = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions = {}
) => {
  if (!isModelInFreeCatalog(model.id)) {
    return refuseNonFreeModel(model);
  }
  return streamOpenAICompletions(asOpenRouterModel(model), context, {
    ...options,
    apiKey: getApiKeyForProvider(PROVIDER_ID) ?? options.apiKey,
    headers: withAttribution(options.headers),
  });
};

const streamSimpleOpenRouterFree = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions = {}
) => {
  if (!isModelInFreeCatalog(model.id)) {
    return refuseNonFreeModel(model);
  }
  return streamSimpleOpenAICompletions(asOpenRouterModel(model), context, {
    ...options,
    apiKey: getApiKeyForProvider(PROVIDER_ID) ?? options.apiKey,
    headers: withAttribution(options.headers),
  });
};

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
