import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREE_ROUTER_FALLBACK,
  fetchModels,
  filterModels,
  getCatalog,
  getFreeCatalog,
  isFreeAgentCapableModel,
  isModelInFreeCatalog,
  isOpenRouterFreePriced,
  loadCache,
  loadFilterPatterns,
  type OpenRouterModel,
  saveCache,
  toModelMetadata,
} from '../../providers/openrouter-models.js';

const MODELS_STORAGE_KEY = 'slicc.openrouter.models';
const FILTER_STORAGE_KEY = 'slicc.openrouter.modelFilter';
const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};

const liveModel: OpenRouterModel = {
  id: 'example/vision-reasoner',
  name: 'Vision Reasoner',
  context_length: 200_000,
  architecture: { input_modalities: ['text', 'image'] },
  top_provider: { max_completion_tokens: 32_000 },
  supported_parameters: ['tools', 'include_reasoning'],
};

const freeAgentModel: OpenRouterModel = {
  id: 'vendor/free-vision:free',
  name: 'Free Vision',
  context_length: 128_000,
  architecture: {
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
  },
  top_provider: { max_completion_tokens: 8_192 },
  supported_parameters: ['tools', 'temperature', 'top_p', 'tool_choice'],
  pricing: { prompt: '0', completion: '0' },
};

const paidVisionModel: OpenRouterModel = {
  ...freeAgentModel,
  id: 'vendor/paid-vision',
  name: 'Paid Vision',
  pricing: { prompt: '0.000001', completion: '0.000002' },
};

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', localStorageStub);
  vi.restoreAllMocks();
});

describe('OpenRouter seed catalog', () => {
  const seedModels = Object.values(OPENROUTER_MODELS);

  it('maps every real pi-ai seed model to valid SLICC metadata', () => {
    expect(seedModels.length).toBeGreaterThan(100);

    for (const seed of seedModels) {
      const mapped = toModelMetadata(seed);
      expect(mapped.id).toBe(seed.id);
      expect(mapped.name).toBe(seed.name);
      expect(mapped.api).toBe('openai');
      expect(mapped.context_window).toBeGreaterThan(0);
      expect(mapped.max_tokens).toBeGreaterThan(0);
      expect(mapped.reasoning).toBeTypeOf('boolean');
      const seedInput = seed.input as readonly string[];
      expect(mapped.input).toEqual(seedInput.includes('image') ? ['text', 'image'] : ['text']);
    }
  });

  it('filters the full seed with glob patterns', () => {
    expect(filterModels(seedModels, ['*'])).toEqual(seedModels);
    const anthropic = filterModels(seedModels, ['anthropic/*']);
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.every((model) => model.id.startsWith('anthropic/'))).toBe(true);
  });

  it('escapes regex characters while expanding stars', () => {
    const models = [{ id: 'vendor/model.v1' }, { id: 'vendor/modelXv1' }];
    expect(filterModels(models, ['vendor/*.v1'])).toEqual([{ id: 'vendor/model.v1' }]);
    expect(filterModels(models, [])).toEqual(models);
  });
});

describe('OpenRouter mapping', () => {
  it('maps live image and reasoning capabilities', () => {
    expect(toModelMetadata(liveModel)).toEqual({
      id: liveModel.id,
      name: liveModel.name,
      api: 'openai',
      context_window: 200_000,
      max_tokens: 32_000,
      reasoning: true,
      input: ['text', 'image'],
    });
  });

  it('uses safe defaults for omitted optional live metadata', () => {
    expect(
      toModelMetadata({ id: 'example/text', name: 'Text', context_length: 8_192 })
    ).toMatchObject({
      context_window: 8_192,
      max_tokens: 16_384,
      reasoning: false,
      input: ['text'],
    });
  });
});

describe('OpenRouter free-agent filter', () => {
  it('treats zero pricing and :free ids as free', () => {
    expect(isOpenRouterFreePriced(freeAgentModel)).toBe(true);
    expect(isOpenRouterFreePriced(paidVisionModel)).toBe(false);
    expect(isOpenRouterFreePriced({ id: 'openrouter/free', name: 'Router' })).toBe(true);
    expect(isOpenRouterFreePriced({ id: 'vendor/model:free', name: 'Tagged' })).toBe(true);
    expect(isOpenRouterFreePriced({ id: 'vendor/model', name: 'Unknown' })).toBe(false);
  });

  it('rejects zero token prices when image or request charges are nonzero', () => {
    expect(
      isOpenRouterFreePriced({
        ...freeAgentModel,
        pricing: { prompt: '0', completion: '0', image: '0.0001' },
      })
    ).toBe(false);
    expect(
      isOpenRouterFreePriced({
        ...freeAgentModel,
        pricing: { prompt: '0', completion: '0', request: '0.01' },
      })
    ).toBe(false);
    expect(
      isOpenRouterFreePriced({
        ...freeAgentModel,
        pricing: { prompt: '0', completion: '0', image: '0', request: '0', discount: 0 },
      })
    ).toBe(true);
  });

  it('requires free pricing, vision input, text output, and tool params', () => {
    expect(isFreeAgentCapableModel(freeAgentModel)).toBe(true);
    expect(isFreeAgentCapableModel(paidVisionModel)).toBe(false);
    expect(
      isFreeAgentCapableModel({
        ...freeAgentModel,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      })
    ).toBe(false);
    expect(
      isFreeAgentCapableModel({
        ...freeAgentModel,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['audio'] },
      })
    ).toBe(false);
    expect(
      isFreeAgentCapableModel({
        ...freeAgentModel,
        supported_parameters: ['temperature', 'top_p'],
      })
    ).toBe(false);
  });

  it('returns only free agent models from the live cache with zero cost', () => {
    saveCache([liveModel, freeAgentModel, paidVisionModel]);
    expect(getFreeCatalog()).toEqual([
      {
        ...toModelMetadata(freeAgentModel),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('falls back to the free router when nothing matches', () => {
    saveCache([liveModel, paidVisionModel]);
    expect(getFreeCatalog()).toEqual([
      {
        ...toModelMetadata(FREE_ROUTER_FALLBACK),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  });

  it('reports membership via isModelInFreeCatalog', () => {
    saveCache([freeAgentModel]);
    expect(isModelInFreeCatalog(freeAgentModel.id)).toBe(true);
    expect(isModelInFreeCatalog('vendor/paid-elsewhere')).toBe(false);
  });
});

describe('OpenRouter localStorage helpers', () => {
  it('round-trips the raw catalog', () => {
    saveCache([liveModel]);
    expect(JSON.parse(storage.get(MODELS_STORAGE_KEY)!)).toEqual([liveModel]);
    expect(loadCache()).toEqual([liveModel]);
  });

  it('ignores malformed cache and missing localStorage', () => {
    storage.set(MODELS_STORAGE_KEY, '{bad json');
    expect(loadCache()).toEqual([]);
    vi.stubGlobal('localStorage', undefined);
    expect(loadCache()).toEqual([]);
    expect(() => saveCache([liveModel])).not.toThrow();
  });

  it('reads filter patterns and defaults invalid preferences to all models', () => {
    expect(loadFilterPatterns()).toEqual(['*']);
    storage.set(FILTER_STORAGE_KEY, JSON.stringify(['anthropic/*', 'openai/gpt-*']));
    expect(loadFilterPatterns()).toEqual(['anthropic/*', 'openai/gpt-*']);
    storage.set(FILTER_STORAGE_KEY, JSON.stringify([]));
    expect(loadFilterPatterns()).toEqual(['*']);
    storage.set(FILTER_STORAGE_KEY, 'invalid');
    expect(loadFilterPatterns()).toEqual(['*']);
  });
});

describe('OpenRouter catalog loading', () => {
  it('uses the filtered pi-ai seed before a live fetch or persisted cache', () => {
    storage.set(FILTER_STORAGE_KEY, JSON.stringify(['anthropic/*']));
    const catalog = getCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((model) => model.id.startsWith('anthropic/'))).toBe(true);
  });

  it('prefers the persisted raw catalog over the seed', () => {
    saveCache([liveModel]);
    expect(getCatalog()).toEqual([toModelMetadata(liveModel)]);
  });

  it('throws a clear error for a non-OK live response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' })
    );
    await expect(fetchModels()).rejects.toThrow(
      'Failed to fetch OpenRouter models: 503 Service Unavailable'
    );
  });

  it('rejects a successful response without a model array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: null }) })
    );
    await expect(fetchModels()).rejects.toThrow(
      'Failed to fetch OpenRouter models: response did not contain a data array'
    );
  });

  it('fetches, caches, and prioritizes the in-memory live catalog', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [liveModel] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchModels()).resolves.toEqual([liveModel]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal),
      })
    );
    saveCache([{ ...liveModel, id: 'cached/model' }]);
    expect(getCatalog()).toEqual([toModelMetadata(liveModel)]);
  });
});
