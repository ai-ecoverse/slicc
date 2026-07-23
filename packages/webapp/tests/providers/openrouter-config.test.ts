import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchModels: vi.fn(),
  getApiKeyForProvider: vi.fn<() => string | null>(() => 'stored-oauth-key'),
  getCatalog: vi.fn<() => unknown[]>(() => []),
  loginIntercepted: vi.fn(),
  registerApiProvider: vi.fn(),
  saveOAuthAccount: vi.fn(),
  streamOpenAICompletions: vi.fn(),
  streamSimpleOpenAICompletions: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai/compat')>()),
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

vi.mock('../../providers/openrouter-models.js', () => ({
  config: undefined,
  fetchModels: mocks.fetchModels,
  getCatalog: mocks.getCatalog,
}));

vi.mock('../../providers/openrouter-oauth.js', () => ({
  config: undefined,
  loginIntercepted: mocks.loginIntercepted,
}));

import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { config, register } from '../../providers/openrouter.js';
import { getProviderConfig } from '../../src/providers/account-store.js';
import { registerProviders } from '../../src/providers/index.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApiKeyForProvider.mockReturnValue('stored-oauth-key');
  mocks.getCatalog.mockReturnValue([]);
});

describe('OpenRouter provider config', () => {
  it('declares PKCE OAuth UI settings and a seeded default model', () => {
    expect(config).toMatchObject({
      id: 'openrouter',
      name: 'OpenRouter',
      isOAuth: true,
      requiresApiKey: false,
      requiresBaseUrl: false,
      defaultModelId: 'anthropic/claude-sonnet-4.6',
      oauthTokenDomains: ['openrouter.ai', '*.openrouter.ai'],
    });
    expect(config.description).toContain('PKCE');
    expect(Object.hasOwn(OPENROUTER_MODELS, config.defaultModelId!)).toBe(true);
  });

  it('delegates synchronous model discovery to the catalog module', () => {
    const catalog = [
      { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', api: 'openai' },
    ];
    mocks.getCatalog.mockReturnValue(catalog);

    expect(config.getModelIds!()).toEqual(catalog);
    expect(mocks.getCatalog).toHaveBeenCalledOnce();
  });

  it('exposes model refresh for hosted account prewarming', async () => {
    await config.refreshModels!('ignored-public-catalog-token');
    expect(mocks.fetchModels).toHaveBeenCalledOnce();
  });

  it('is auto-discovered and overrides the pi-ai fallback config', async () => {
    await registerProviders();
    expect(getProviderConfig('openrouter').isOAuth).toBe(true);
    expect(getProviderConfig('openrouter').requiresApiKey).toBe(false);
  });
});

describe('OpenRouter OAuth hooks', () => {
  it('refreshes and caches models after token storage and before success', async () => {
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

    expect(mocks.loginIntercepted).toHaveBeenCalledWith(launcher, expect.any(Function), options);
    expect(order).toEqual(['login', 'stored', 'refresh', 'success']);
  });

  it('reports OAuth success when the best-effort model refresh rejects', async () => {
    const launcher = vi.fn();
    const onSuccess = vi.fn();
    mocks.loginIntercepted.mockResolvedValue(undefined);
    mocks.fetchModels.mockRejectedValue(new Error('catalog unavailable'));

    await expect(config.onOAuthLoginIntercepted!(launcher, onSuccess)).resolves.toBeUndefined();

    expect(mocks.fetchModels).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('clears the stored OAuth token on logout', async () => {
    await config.onOAuthLogout!();
    expect(mocks.saveOAuthAccount).toHaveBeenCalledWith({
      providerId: 'openrouter',
      accessToken: '',
    });
  });
});

describe('OpenRouter stream registration', () => {
  function registeredProvider() {
    register();
    return mocks.registerApiProvider.mock.calls[0][0];
  }

  const model = {
    id: 'anthropic/claude-sonnet-4.6',
    provider: 'openrouter',
    api: 'openrouter-openai',
  } as Model<Api>;
  const context = { messages: [] } as unknown as Context;

  it('registers the synthetic OpenRouter API with both stream functions', () => {
    const provider = registeredProvider();
    expect(provider.api).toBe('openrouter-openai');
    expect(provider.stream).toBeTypeOf('function');
    expect(provider.streamSimple).toBeTypeOf('function');
  });

  it('delegates streaming with the stored key, base URL, and attribution headers', () => {
    const provider = registeredProvider();
    provider.stream(
      model as never,
      context as never,
      {
        apiKey: 'caller-key',
        headers: { 'X-Custom': 'kept' },
      } as never
    );

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

  it('preserves a caller/env-resolved key for simple streaming when no OAuth key is stored', () => {
    mocks.getApiKeyForProvider.mockReturnValue(null);
    const provider = registeredProvider();
    provider.streamSimple(model as never, context as never, { apiKey: 'env-key' } as never);

    expect(mocks.streamSimpleOpenAICompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
      context,
      expect.objectContaining({
        apiKey: 'env-key',
        headers: {
          'HTTP-Referer': 'https://sliccy.ai',
          'X-Title': 'SLICC',
        },
      })
    );
  });
});
