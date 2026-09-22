import type { Api, Model } from '@earendil-works/pi-ai';
import { getModels as getBundledModels } from '@earendil-works/pi-ai/compat';
import { getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initFeatureFlags } from '../../src/core/feature-flags.js';
import {
  __resetModelCatalogMemoForTests,
  getModel,
  getModels,
  MODEL_CATALOG_STORAGE_KEY,
  type ModelCatalogEntry,
  sanitizeCatalogModel,
} from '../../src/core/model-catalog.js';
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  refreshModelCatalog,
} from '../../src/core/model-catalog-refresh.js';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const bundled = (provider: string) => (getBundledModels as (p: string) => Model<Api>[])(provider);
const GENERATED_AT = getBuiltinModelDataGeneratedAt() ?? 0;
const AFTER = GENERATED_AT + 86_400_000;
const ANTHROPIC = bundled('anthropic');
const TEMPLATE = ANTHROPIC.find((m) => m.id === 'claude-opus-5') ?? ANTHROPIC[0];

function remote(overrides: Partial<Model<Api>> & { id: string }): object {
  return {
    ...TEMPLATE,
    name: `Remote ${overrides.id}`,
    ...overrides,
  };
}

function store(storage: MemoryStorage, entries: Record<string, Partial<ModelCatalogEntry>>) {
  const full = Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [
      id,
      { models: [], checkedAt: 0, lastModified: AFTER, ...e },
    ])
  );
  storage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify(full));
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  initFeatureFlags('standalone');
  __resetModelCatalogMemoForTests();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
  initFeatureFlags('standalone');
});

describe('getModels / getModel overlay', () => {
  it('bakes the same generation time pi-ai reports at runtime', () => {
    expect(__PI_AI_MODELS_GENERATED_AT__).toBe(getBuiltinModelDataGeneratedAt());
  });

  it('returns the bundled catalogue when nothing is stored', () => {
    expect(getModels('anthropic').map((m) => m.id)).toEqual(ANTHROPIC.map((m) => m.id));
  });

  it('appends new models and replaces same-id models from a fresh catalogue', () => {
    store(storage, {
      anthropic: {
        models: [
          remote({ id: 'claude-opus-9-9', name: 'Claude Opus 9.9' }),
          remote({ id: TEMPLATE.id, name: 'Renamed upstream' }),
        ],
      },
    });
    const models = getModels('anthropic');
    expect(models).toHaveLength(ANTHROPIC.length + 1);
    expect(models.at(-1)).toMatchObject({
      id: 'claude-opus-9-9',
      name: 'Claude Opus 9.9',
      provider: 'anthropic',
    });
    expect(models.find((m) => m.id === TEMPLATE.id)?.name).toBe('Renamed upstream');
    expect(getModel('anthropic', 'claude-opus-9-9').name).toBe('Claude Opus 9.9');
  });

  it('falls back to the bundled model for ids the overlay lacks', () => {
    expect(getModel('anthropic', TEMPLATE.id).id).toBe(TEMPLATE.id);
    expect(getModel('anthropic', 'no-such-model')).toBeUndefined();
  });

  it('ignores a catalogue that is not newer than the bundled data (pi rule)', () => {
    store(storage, {
      anthropic: { models: [remote({ id: 'claude-opus-9-9' })], lastModified: GENERATED_AT },
    });
    expect(getModels('anthropic').some((m) => m.id === 'claude-opus-9-9')).toBe(false);
  });

  it('ignores the overlay when the live-model-catalog flag is off', () => {
    store(storage, { anthropic: { models: [remote({ id: 'claude-opus-9-9' })] } });
    initFeatureFlags('standalone', { 'live-model-catalog': 'off' });
    expect(getModels('anthropic').some((m) => m.id === 'claude-opus-9-9')).toBe(false);
  });

  it('re-reads when the stored payload changes', () => {
    store(storage, { anthropic: { models: [remote({ id: 'claude-a-1' })] } });
    expect(getModels('anthropic').some((m) => m.id === 'claude-a-1')).toBe(true);
    store(storage, { anthropic: { models: [remote({ id: 'claude-b-1' })] } });
    const ids = getModels('anthropic').map((m) => m.id);
    expect(ids).toContain('claude-b-1');
    expect(ids).not.toContain('claude-a-1');
  });

  it('survives corrupt storage', () => {
    storage.setItem(MODEL_CATALOG_STORAGE_KEY, '{not json');
    expect(getModels('anthropic')).toHaveLength(ANTHROPIC.length);
    storage.setItem(MODEL_CATALOG_STORAGE_KEY, '[]');
    expect(getModels('anthropic')).toHaveLength(ANTHROPIC.length);
  });

  it('returns a fresh array each call so callers cannot mutate the memo', () => {
    store(storage, { anthropic: { models: [remote({ id: 'claude-opus-9-9' })] } });
    getModels('anthropic').pop();
    expect(getModels('anthropic').some((m) => m.id === 'claude-opus-9-9')).toBe(true);
  });

  it('adds nothing for a provider with no bundled models', () => {
    store(storage, { 'not-a-provider': { models: [remote({ id: 'x-1' })] } });
    expect(getModels('not-a-provider')).toEqual([]);
  });
});

describe('sanitizeCatalogModel', () => {
  const shape = {
    apis: new Set(ANTHROPIC.map((m) => m.api as string)),
    baseUrls: new Set(ANTHROPIC.map((m) => m.baseUrl)),
  };

  it('keeps only the known Model fields and stamps the provider', () => {
    const model = sanitizeCatalogModel(
      'anthropic',
      remote({
        id: 'claude-opus-9-9',
        provider: 'someone-else',
        headers: { Authorization: 'Bearer stolen' },
      } as Partial<Model<Api>> & { id: string }),
      shape
    );
    expect(model?.provider).toBe('anthropic');
    expect(model).not.toHaveProperty('headers');
  });

  it.each([
    ['a baseUrl the bundled catalogue never uses', { baseUrl: 'https://evil.example/v1' }],
    ['an api the provider does not use', { api: 'openai-completions' }],
    ['a negative price', { cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    ['a missing name', { name: '' }],
    ['a zero context window', { contextWindow: 0 }],
    ['an unknown input kind', { input: ['text', 'audio'] }],
    ['a non-boolean reasoning flag', { reasoning: 'yes' }],
    ['a malformed thinkingLevelMap', { thinkingLevelMap: { high: 3 } }],
  ])('drops a model with %s', (_label, overrides) => {
    expect(
      sanitizeCatalogModel(
        'anthropic',
        remote({ id: 'claude-x-1', ...(overrides as Partial<Model<Api>>) }),
        shape
      )
    ).toBeNull();
  });

  it('drops non-objects', () => {
    expect(sanitizeCatalogModel('anthropic', 'nope', shape)).toBeNull();
    expect(sanitizeCatalogModel('anthropic', null, shape)).toBeNull();
  });
});

describe('refreshModelCatalog', () => {
  const NOW = AFTER + 1_000;
  const LAST_MODIFIED = new Date(AFTER).toUTCString();

  function okResponse(body: unknown, etag = '"v1"'): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', etag, 'last-modified': LAST_MODIFIED },
    });
  }

  function stored(): Record<string, ModelCatalogEntry> {
    return JSON.parse(storage.getItem(MODEL_CATALOG_STORAGE_KEY) ?? '{}');
  }

  it('fetches each known provider through the worker relay and stores the result', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ 'claude-opus-9-9': remote({ id: 'claude-opus-9-9' }) })
    );
    const result = await refreshModelCatalog({
      workerBaseUrl: 'https://www.sliccy.ai/',
      providers: ['anthropic', 'anthropic', 'not-a-provider'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
      now: () => NOW,
    });
    expect(result).toEqual({ updated: ['anthropic'], failed: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://www.sliccy.ai/api/models/providers/anthropic');
    expect(stored().anthropic).toMatchObject({
      checkedAt: NOW,
      lastModified: Date.parse(LAST_MODIFIED),
      etag: '"v1"',
    });
    expect(getModel('anthropic', 'claude-opus-9-9')?.id).toBe('claude-opus-9-9');
  });

  it('accepts array and { models } bodies', async () => {
    for (const body of [
      [remote({ id: 'claude-a-1' })],
      { models: [remote({ id: 'claude-a-1' })] },
    ]) {
      storage.values.clear();
      await refreshModelCatalog({
        workerBaseUrl: 'https://w.example',
        providers: ['anthropic'],
        fetchImpl: (async () => okResponse(body)) as unknown as typeof fetch,
        storage,
        now: () => NOW,
      });
      expect(stored().anthropic.models).toHaveLength(1);
    }
  });

  it('skips a provider checked within the refresh window unless forced', async () => {
    store(storage, { anthropic: { checkedAt: NOW - 60_000, models: [remote({ id: 'a' })] } });
    const fetchImpl = vi.fn(async () => okResponse([]));
    const options = {
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
      now: () => NOW,
    };
    expect(await refreshModelCatalog(options)).toEqual({ updated: [], failed: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    await refreshModelCatalog({ ...options, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await refreshModelCatalog({ ...options, now: () => NOW + MODEL_CATALOG_REFRESH_INTERVAL_MS });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('revalidates with the stored ETag and keeps the body on 304', async () => {
    store(storage, { anthropic: { etag: '"v1"', models: [remote({ id: 'claude-a-1' })] } });
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(null, { status: 304 })
    );
    const result = await refreshModelCatalog({
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
      now: () => NOW,
    });
    expect(result).toEqual({ updated: [], failed: [] });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
    expect(stored().anthropic).toMatchObject({ checkedAt: NOW, etag: '"v1"' });
    expect(stored().anthropic.models).toHaveLength(1);
  });

  it('does not send a validator without a cached body', async () => {
    store(storage, { anthropic: { etag: '"v1"', models: [] } });
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => okResponse([]));
    await refreshModelCatalog({
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
      now: () => NOW,
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty('If-None-Match');
  });

  it('clears the overlay on 404', async () => {
    store(storage, { anthropic: { models: [remote({ id: 'claude-a-1' })] } });
    const result = await refreshModelCatalog({
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      storage,
      now: () => NOW,
    });
    expect(result.updated).toEqual(['anthropic']);
    expect(stored().anthropic.models).toEqual([]);
  });

  it.each([
    ['a 5xx', async () => new Response('', { status: 502 })],
    [
      'a network error',
      async () => {
        throw new Error('offline');
      },
    ],
    ['a malformed body', async () => new Response('not json', { status: 200 })],
  ])('keeps the previous catalogue after %s', async (_label, impl) => {
    store(storage, { anthropic: { models: [remote({ id: 'claude-a-1' })] } });
    const result = await refreshModelCatalog({
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: impl as unknown as typeof fetch,
      storage,
      now: () => NOW,
    });
    expect(result.failed).toEqual(['anthropic']);
    expect(stored().anthropic.models).toHaveLength(1);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const result = await refreshModelCatalog({
      workerBaseUrl: 'https://w.example',
      providers: ['anthropic'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage,
      now: () => NOW,
      timeoutMs: 5,
    });
    expect(result.failed).toEqual(['anthropic']);
  });

  it('never rejects when storage writes fail', async () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    await expect(
      refreshModelCatalog({
        workerBaseUrl: 'https://w.example',
        providers: ['anthropic'],
        fetchImpl: (async () => okResponse([])) as unknown as typeof fetch,
        storage: broken,
        now: () => NOW,
      })
    ).resolves.toEqual({ updated: ['anthropic'], failed: [] });
  });

  it('does nothing when the flag is off, when storage is missing, or with no known providers', async () => {
    const fetchImpl = vi.fn(async () => okResponse([]));
    const base = {
      workerBaseUrl: 'https://w.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    };
    await refreshModelCatalog({ ...base, providers: ['anthropic'], storage: null });
    await refreshModelCatalog({ ...base, providers: ['not-a-provider'], storage });
    initFeatureFlags('standalone', { 'live-model-catalog': 'off' });
    await refreshModelCatalog({ ...base, providers: ['anthropic'], storage });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
