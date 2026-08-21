import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getModels: vi.fn(),
  streamOpenAICompletions: vi.fn(),
  streamOpenAIResponses: vi.fn(),
  streamSimpleOpenAICompletions: vi.fn(),
  streamSimpleOpenAIResponses: vi.fn(),
}));

const providerSettingsMocks = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  saveOAuthAccount: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai/compat')>();
  return { ...actual, ...mocks };
});

vi.mock('../../src/ui/provider-settings.js', () => ({
  getAccounts: () => providerSettingsMocks.accounts,
  saveOAuthAccount: providerSettingsMocks.saveOAuthAccount,
}));

import {
  createAssistantMessageEventStream,
  getApiProvider,
  resetApiProviders,
} from '@earendil-works/pi-ai/compat';
import { config, register } from '../../providers/xai-grok.js';

const XAI_API = 'xai-grok-openai' as Api;
const XAI_BASE_URL = 'https://api.x.ai/v1';
const context = { systemPrompt: '', messages: [], tools: [] };

const nativeModels = [
  {
    id: 'grok-4.3',
    name: 'Grok 4.3',
    api: 'openai-completions',
    provider: 'xai',
    baseUrl: XAI_BASE_URL,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 30_000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    api: 'openai-responses',
    provider: 'xai',
    baseUrl: XAI_BASE_URL,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 500_000,
    compat: { supportsLongCacheRetention: false },
    thinkingLevelMap: { off: null, minimal: null },
  },
  {
    id: 'grok-build-0.1',
    name: 'Grok Build 0.1',
    api: 'openai-completions',
    provider: 'xai',
    baseUrl: XAI_BASE_URL,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 256_000,
    maxTokens: 256_000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  },
] as Model<Api>[];

function endedStream() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.end());
  return stream;
}

function routedModel(id: string): Model<Api> {
  const nativeModel = nativeModels.find((model) => model.id === id)!;
  return { ...nativeModel, provider: 'xai-grok', api: XAI_API };
}

async function drain(stream: ReturnType<typeof endedStream>): Promise<void> {
  for await (const _event of stream) {
    // The mocked native streams intentionally emit no events.
  }
}

beforeEach(() => {
  resetApiProviders();
  vi.clearAllMocks();
  mocks.getModels.mockImplementation((provider: string) =>
    provider === 'xai' ? nativeModels : []
  );
  mocks.streamOpenAICompletions.mockImplementation(endedStream);
  mocks.streamOpenAIResponses.mockImplementation(endedStream);
  mocks.streamSimpleOpenAICompletions.mockImplementation(endedStream);
  mocks.streamSimpleOpenAIResponses.mockImplementation(endedStream);
  providerSettingsMocks.accounts = [
    {
      providerId: 'xai-grok',
      accessToken: 'oauth-token',
      tokenExpiresAt: Date.now() + 3_600_000,
    },
  ];
  register();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('xai-grok provider', () => {
  it('records the provider-reported login scope rather than the requested scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
              scope: 'reported:scope',
            }),
            { status: 200 }
          )
      )
    );
    const launcher = vi.fn(async ({ authorizeUrl }: { authorizeUrl: string }) => {
      const state = new URL(authorizeUrl).searchParams.get('state');
      return `http://127.0.0.1:56121/callback?code=test-code&state=${state}`;
    });

    await config.onOAuthLoginIntercepted!(launcher, () => {}, { scopes: 'requested:scope' });

    expect(providerSettingsMocks.saveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: 'reported:scope' })
    );
  });

  it('leaves login scopes unknown when the token response omits scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ access_token: 'new-access' }), { status: 200 })
      )
    );
    const launcher = vi.fn(async ({ authorizeUrl }: { authorizeUrl: string }) => {
      const state = new URL(authorizeUrl).searchParams.get('state');
      return `http://127.0.0.1:56121/callback?code=test-code&state=${state}`;
    });

    await config.onOAuthLoginIntercepted!(launcher, () => {}, { scopes: 'requested:scope' });

    expect(providerSettingsMocks.saveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: undefined })
    );
  });

  it.each([
    ['records a refreshed scope', 'refreshed:scope', 'refreshed:scope'],
    ['preserves the prior scope when refresh omits scope', undefined, 'prior:scope'],
  ])('%s', async (_label, responseScope, expectedScope) => {
    providerSettingsMocks.accounts = [
      {
        providerId: 'xai-grok',
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        scopes: 'prior:scope',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'refreshed-access',
              ...(responseScope ? { scope: responseScope } : {}),
            }),
            { status: 200 }
          )
      )
    );

    await expect(config.onSilentRenew!()).resolves.toBe('refreshed-access');

    expect(providerSettingsMocks.saveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expectedScope })
    );
  });

  it('persists scope when getValidAccessToken refreshes during a stream', async () => {
    providerSettingsMocks.accounts = [
      {
        providerId: 'xai-grok',
        accessToken: 'expired-access',
        refreshToken: 'old-refresh',
        tokenExpiresAt: Date.now() - 1,
        scopes: 'prior:scope',
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'stream-refreshed-access',
              scope: 'stream:scope',
            }),
            { status: 200 }
          )
      )
    );

    const provider = getApiProvider(XAI_API)!;
    await drain(provider.stream(routedModel('grok-4.5'), context, {}));

    expect(providerSettingsMocks.saveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'stream-refreshed-access',
        scopes: 'stream:scope',
      })
    );
    expect(mocks.streamOpenAIResponses.mock.calls[0][2]).toEqual(
      expect.objectContaining({ apiKey: 'stream-refreshed-access' })
    );
  });

  it('sources its catalog and metadata from pi-ai xai models', () => {
    const models = config.getModelIds!();

    expect(mocks.getModels).toHaveBeenCalledWith('xai');
    expect(models.map((model) => model.id)).toEqual(['grok-4.3', 'grok-4.5', 'grok-build-0.1']);
    expect(models.every((model) => model.api === 'openai')).toBe(true);
    expect(models.find((model) => model.id === 'grok-4.5')).toEqual(
      expect.objectContaining({
        context_window: 500_000,
        max_tokens: 500_000,
        compat: { supportsLongCacheRetention: false },
        thinkingLevelMap: { off: null, minimal: null },
      })
    );
  });

  // Catalog-staleness guard: `getModelIds()` is a pass-through over pi-ai's
  // bundled xAI data, so a stale `@earendil-works/pi-ai` pin is the only way a
  // shipped Grok model can go missing from the dropdown. Assert against the
  // real catalog (not the mock) so a lockfile that predates a model release
  // fails here instead of silently in the UI.
  it('surfaces every shipped Grok model from the real pi-ai catalog', async () => {
    const { getModels } = await vi.importActual<typeof import('@earendil-works/pi-ai/compat')>(
      '@earendil-works/pi-ai/compat'
    );

    const ids = (getModels('xai') as Model<Api>[]).map((model) => model.id);

    expect(ids).toContain('grok-4.6');
    expect(ids).toContain(config.defaultModelId);
  });

  it('defaults to Grok 4.5 without the retired Grok Heavy copy', () => {
    expect(config.defaultModelId).toBe('grok-4.5');
    expect(config.description).toContain('Default model is Grok 4.5');
    expect(config.description).not.toContain('Grok Heavy');
  });

  it('dispatches Responses models with native xAI identity while preserving slicc routing', async () => {
    const provider = getApiProvider(XAI_API)!;
    const model = routedModel('grok-4.5');
    const options = { headers: { existing: 'header' }, sessionId: 'session-123' } as any;

    await drain(provider.stream(model, context, options));
    await drain(provider.streamSimple(model, context, options));

    expect(mocks.streamOpenAIResponses).toHaveBeenCalledOnce();
    expect(mocks.streamSimpleOpenAIResponses).toHaveBeenCalledOnce();
    expect(mocks.streamOpenAICompletions).not.toHaveBeenCalled();
    expect(mocks.streamSimpleOpenAICompletions).not.toHaveBeenCalled();
    expect(config.id).toBe('xai-grok');
    expect(model).toEqual(expect.objectContaining({ provider: 'xai-grok', api: XAI_API }));
    const [forwardedModel, , forwardedOptions] = mocks.streamOpenAIResponses.mock.calls[0];
    expect(forwardedModel).toEqual(
      expect.objectContaining({
        id: 'grok-4.5',
        api: 'openai-responses',
        provider: 'xai',
        baseUrl: XAI_BASE_URL,
        compat: { supportsLongCacheRetention: false },
      })
    );
    expect(mocks.streamSimpleOpenAIResponses.mock.calls[0][0]).toEqual(
      expect.objectContaining({ provider: 'xai', api: 'openai-responses' })
    );
    expect(forwardedOptions).toEqual(
      expect.objectContaining({
        apiKey: 'oauth-token',
        headers: { existing: 'header', 'x-grok-conv-id': 'session-123' },
      })
    );
    expect(forwardedOptions).not.toHaveProperty('onPayload');
  });

  it('falls back to Grok 4.5 when a stored model id is retired', async () => {
    const provider = getApiProvider(XAI_API)!;
    const model = { ...routedModel('grok-4.3'), id: 'grok-3-mini', name: 'Grok 3 Mini' };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(drain(provider.stream(model, context, {}))).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        'xAI model "grok-3-mini" is no longer in the pi-ai catalog; falling back to default "grok-4.5"'
      );
      expect(mocks.streamOpenAIResponses).toHaveBeenCalledOnce();
      expect(mocks.streamOpenAIResponses.mock.calls[0][0]).toEqual(
        expect.objectContaining({ id: 'grok-4.5', provider: 'xai', api: 'openai-responses' })
      );
      expect(mocks.streamOpenAICompletions).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('dispatches Grok 4.3 and Grok Build to native Completions streams', async () => {
    const provider = getApiProvider(XAI_API)!;

    await drain(provider.stream(routedModel('grok-4.3'), context, {}));
    await drain(provider.streamSimple(routedModel('grok-build-0.1'), context, {}));

    expect(mocks.streamOpenAICompletions).toHaveBeenCalledOnce();
    expect(mocks.streamSimpleOpenAICompletions).toHaveBeenCalledOnce();
    expect(mocks.streamOpenAIResponses).not.toHaveBeenCalled();
    expect(mocks.streamSimpleOpenAIResponses).not.toHaveBeenCalled();
    expect(mocks.streamOpenAICompletions.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 'grok-4.3',
        api: 'openai-completions',
        provider: 'xai',
        baseUrl: XAI_BASE_URL,
      })
    );
    expect(mocks.streamSimpleOpenAICompletions.mock.calls[0][0]).toEqual(
      expect.objectContaining({ provider: 'xai', api: 'openai-completions' })
    );
    expect(mocks.streamOpenAICompletions.mock.calls[0][2]).toEqual(
      expect.objectContaining({ apiKey: 'oauth-token' })
    );
    expect(mocks.streamOpenAICompletions.mock.calls[0][2]).not.toHaveProperty('onPayload');
  });
});
