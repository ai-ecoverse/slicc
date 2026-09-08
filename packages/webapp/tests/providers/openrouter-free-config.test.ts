import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAssistantMessageEventStream: vi.fn(() => {
    const stream = {
      push: vi.fn(),
      end: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        /* empty refuse stream for tests */
      },
    };
    return stream;
  }),
  fetchModels: vi.fn(),
  getApiKeyForProvider: vi.fn<() => string | null>(() => 'stored-oauth-key'),
  getFreeCatalog: vi.fn<() => unknown[]>(() => []),
  isModelInFreeCatalog: vi.fn<(id: string) => boolean>(() => true),
  loginIntercepted: vi.fn(),
  registerApiProvider: vi.fn(),
  saveOAuthAccount: vi.fn(),
  streamOpenAICompletions: vi.fn(),
  streamSimpleOpenAICompletions: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai/compat')>()),
  createAssistantMessageEventStream: mocks.createAssistantMessageEventStream,
  registerApiProvider: mocks.registerApiProvider,
  streamOpenAICompletions: mocks.streamOpenAICompletions,
  streamSimpleOpenAICompletions: mocks.streamSimpleOpenAICompletions,
}));

vi.mock('../../src/providers/account-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/account-store.js')>()),
  getApiKeyForProvider: mocks.getApiKeyForProvider,
}));

vi.mock('../../src/ui/provider-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/provider-settings.js')>()),
  saveOAuthAccount: mocks.saveOAuthAccount,
}));

vi.mock('../../src/providers/built-in/azure-ai-foundry.js', () => ({ config: undefined }));
vi.mock('../../src/providers/built-in/azure-openai.js', () => ({ config: undefined }));
vi.mock('../../src/providers/built-in/bedrock-camp.js', () => ({ config: undefined }));
vi.mock('../../src/providers/built-in/local-llm.js', () => ({ config: undefined }));
vi.mock('../../providers/adobe.js', () => ({ config: undefined }));
vi.mock('../../providers/cerebras.js', () => ({ config: undefined }));
vi.mock('../../providers/github-copilot.js', () => ({ config: undefined }));
vi.mock('../../providers/github.js', () => ({ config: undefined }));
vi.mock('../../providers/openai-codex.js', () => ({ config: undefined }));
vi.mock('../../providers/openrouter.js', () => ({ config: undefined }));
vi.mock('../../providers/xai-grok-errors.js', () => ({ config: undefined }));
vi.mock('../../providers/xai-grok-models.js', () => ({ config: undefined }));
vi.mock('../../providers/xai-grok-sanitize.js', () => ({ config: undefined }));
vi.mock('../../providers/xai-grok.js', () => ({ config: undefined }));

vi.mock('../../providers/openrouter-models.js', () => ({
  config: undefined,
  FREE_ROUTER_FALLBACK: { id: 'openrouter/free', name: 'Free Models Router' },
  fetchModels: mocks.fetchModels,
  getFreeCatalog: mocks.getFreeCatalog,
  isModelInFreeCatalog: mocks.isModelInFreeCatalog,
}));

vi.mock('../../providers/openrouter-oauth.js', () => ({
  config: undefined,
  loginIntercepted: mocks.loginIntercepted,
}));

import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { config, register } from '../../providers/openrouter-free.js';
import { getProviderConfig } from '../../src/providers/account-store.js';
import { registerProviderConfig, unregisterProviderConfig } from '../../src/providers/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeyForProvider.mockReturnValue('stored-oauth-key');
  mocks.getFreeCatalog.mockReturnValue([]);
  mocks.isModelInFreeCatalog.mockReturnValue(true);
  mocks.createAssistantMessageEventStream.mockImplementation(() => {
    const stream = {
      push: vi.fn(),
      end: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        /* empty refuse stream for tests */
      },
    };
    return stream;
  });
});

describe('OpenRouter (Free) provider config', () => {
  it('declares PKCE OAuth UI settings and the free-router default', () => {
    expect(config).toMatchObject({
      id: 'openrouter-free',
      name: 'OpenRouter (Free)',
      isOAuth: true,
      requiresApiKey: false,
      requiresBaseUrl: false,
      defaultModelId: 'openrouter/free',
      oauthTokenDomains: ['openrouter.ai', '*.openrouter.ai'],
    });
    expect(config.description).toMatch(/free/i);
  });

  it('delegates synchronous model discovery to the free catalog', () => {
    const catalog = [{ id: 'openrouter/free', name: 'Free Models Router', api: 'openai' }];
    mocks.getFreeCatalog.mockReturnValue(catalog);

    expect(config.getModelIds!()).toEqual(catalog);
    expect(mocks.getFreeCatalog).toHaveBeenCalledOnce();
  });

  it('exposes model refresh for hosted account prewarming', async () => {
    await config.refreshModels!('ignored-public-catalog-token');
    expect(mocks.fetchModels).toHaveBeenCalledOnce();
  });

  it('registers as an OAuth provider config when added to the runtime registry', () => {
    registerProviderConfig(config);
    try {
      expect(getProviderConfig('openrouter-free').isOAuth).toBe(true);
      expect(getProviderConfig('openrouter-free').requiresApiKey).toBe(false);
    } finally {
      unregisterProviderConfig('openrouter-free');
    }
  });
});

describe('OpenRouter (Free) OAuth hooks', () => {
  it('logs in under openrouter-free and refreshes before success', async () => {
    const order: string[] = [];
    const launcher = vi.fn();
    const options = { forceReauth: true };
    mocks.loginIntercepted.mockImplementation(async (_launcher, onStored) => {
      order.push('login');
      onStored();
      order.push('stored');
    });
    mocks.fetchModels.mockImplementation(async () => {
      order.push('refresh');
      return [];
    });

    await config.onOAuthLoginIntercepted!(launcher, () => order.push('success'), options);

    expect(mocks.loginIntercepted).toHaveBeenCalledWith(launcher, expect.any(Function), {
      ...options,
      providerId: 'openrouter-free',
    });
    expect(order).toEqual(['login', 'stored', 'refresh', 'success']);
  });

  it('reports OAuth success when the best-effort model refresh rejects', async () => {
    const onSuccess = vi.fn();
    mocks.loginIntercepted.mockResolvedValue(undefined);
    mocks.fetchModels.mockRejectedValue(new Error('catalog unavailable'));

    await expect(config.onOAuthLoginIntercepted!(vi.fn(), onSuccess)).resolves.toBeUndefined();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('clears the stored OAuth token on logout', async () => {
    await config.onOAuthLogout!();
    expect(mocks.saveOAuthAccount).toHaveBeenCalledWith({
      providerId: 'openrouter-free',
      accessToken: '',
    });
  });
});

describe('OpenRouter (Free) stream registration', () => {
  function registeredProvider() {
    register();
    return mocks.registerApiProvider.mock.calls[0][0];
  }

  const model = {
    id: 'openrouter/free',
    provider: 'openrouter-free',
    api: 'openrouter-free-openai',
  } as Model<Api>;
  const context = { messages: [] } as unknown as Context;

  it('registers the synthetic Free API with both stream functions', () => {
    const provider = registeredProvider();
    expect(provider.api).toBe('openrouter-free-openai');
    expect(provider.stream).toBeTypeOf('function');
    expect(provider.streamSimple).toBeTypeOf('function');
  });

  it('delegates streaming with the stored free-provider key and attribution', () => {
    const provider = registeredProvider();
    provider.stream(
      model as never,
      context as never,
      {
        apiKey: 'caller-key',
        headers: { 'X-Custom': 'kept' },
      } as never
    );

    expect(mocks.getApiKeyForProvider).toHaveBeenCalledWith('openrouter-free');
    expect(mocks.streamOpenAICompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: model.id,
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
      context,
      expect.objectContaining({
        apiKey: 'stored-oauth-key',
        headers: {
          'X-Custom': 'kept',
          'HTTP-Referer': 'https://sliccy.ai',
          'X-Title': 'SLICC',
        },
      })
    );
  });

  it('refuses models absent from the current free catalog without calling OpenRouter', async () => {
    mocks.isModelInFreeCatalog.mockReturnValue(false);
    const refuseStream = {
      push: vi.fn(),
      end: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        /* empty */
      },
    };
    mocks.createAssistantMessageEventStream.mockReturnValue(refuseStream);

    const provider = registeredProvider();
    provider.stream(model as never, context as never, {} as never);

    expect(mocks.streamOpenAICompletions).not.toHaveBeenCalled();
    expect(mocks.createAssistantMessageEventStream).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(refuseStream.push).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          error: expect.objectContaining({
            stopReason: 'error',
            errorMessage: expect.stringMatching(/not in the current free catalog/i),
          }),
        })
      );
      expect(refuseStream.end).toHaveBeenCalledOnce();
    });
  });
});
