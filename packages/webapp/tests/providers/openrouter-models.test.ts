import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModels,
  filterModels,
  getCatalog,
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
