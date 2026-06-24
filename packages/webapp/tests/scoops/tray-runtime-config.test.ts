import { describe, expect, it, vi } from 'vitest';

import {
  buildTrayLaunchUrl,
  buildTrayUrlValue,
  buildTrayWorkerUrl,
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  fetchRuntimeConfig,
  hasStoredTrayJoinUrl,
  normalizeTrayWorkerBaseUrl,
  parseTrayJoinUrlValue,
  parseTrayUrlValue,
  type RuntimeConfigStorage,
  resolveFollowerJoinUrl,
  resolveTrayRuntimeConfig,
  resolveTrayWorkerBaseUrl,
  storeTrayJoinUrl,
  stripFollowerMarkerFromHref,
  TRAY_JOIN_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';

class MemoryStorage implements RuntimeConfigStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('tray-runtime-config', () => {
  it('normalizes tray worker base URLs and rejects invalid values', () => {
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/')).toBe(
      'https://tray.example.com'
    );
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/base///')).toBe(
      'https://tray.example.com/base'
    );
    expect(normalizeTrayWorkerBaseUrl('not-a-url')).toBeNull();
  });

  it('builds worker endpoint URLs relative to the configured base URL', () => {
    expect(buildTrayWorkerUrl('https://tray.example.com/base', '/tray')).toBe(
      'https://tray.example.com/base/tray'
    );
    expect(buildTrayWorkerUrl('https://tray.example.com', 'controller/token')).toBe(
      'https://tray.example.com/controller/token'
    );
  });

  it('parses and builds tray values with an optional tray id', () => {
    expect(buildTrayUrlValue('https://tray.example.com/base')).toBe(
      'https://tray.example.com/base'
    );
    expect(buildTrayUrlValue('https://tray.example.com/base', 'tray-123')).toBe(
      'https://tray.example.com/base/tray/tray-123'
    );
    expect(parseTrayUrlValue('https://tray.example.com/base/tray/tray-123')).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-123',
      joinUrl: null,
    });
    expect(parseTrayUrlValue('https://tray.example.com/base')).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: null,
      joinUrl: null,
    });
    expect(parseTrayUrlValue('https://tray.example.com/base/join/tray-join.secret')).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });
    expect(parseTrayUrlValue('not-a-url')).toBeNull();
  });

  it('validates tray join URLs and strips hash/query noise', () => {
    expect(
      parseTrayJoinUrlValue('https://tray.example.com/base/join/tray-join.secret?via=share#copied')
    ).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });
    expect(parseTrayJoinUrlValue('https://tray.example.com/base/tray/tray-123')).toBeNull();
  });

  it('stores normalized tray join URLs for later runtime resolution', () => {
    const storage = new MemoryStorage();

    expect(
      storeTrayJoinUrl(storage, 'https://tray.example.com/base/join/tray-join.secret?from=share')
    ).toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });
    expect(storage.getItem('slicc.trayJoinUrl')).toBe(
      'https://tray.example.com/base/join/tray-join.secret'
    );
    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe('https://tray.example.com/base');
  });

  it('detects whether a normalized tray join URL is stored', () => {
    const storage = new MemoryStorage();

    expect(hasStoredTrayJoinUrl(storage)).toBe(false);

    storeTrayJoinUrl(storage, 'https://tray.example.com/base/join/tray-join.secret?share=1');
    expect(hasStoredTrayJoinUrl(storage)).toBe(true);
  });

  it('builds launch URLs with the canonical tray parameter and removes legacy query params', () => {
    expect(
      buildTrayLaunchUrl(
        'http://localhost:3000/?scoop=cone&trayWorkerUrl=https://old.example.com&lead=https://older.example.com',
        'https://tray.example.com/base',
        'tray-123'
      )
    ).toBe(
      'http://localhost:3000/?scoop=cone&tray=https%3A%2F%2Ftray.example.com%2Fbase%2Ftray%2Ftray-123'
    );
  });

  it('prefers query and server runtime config over stored and build defaults', async () => {
    const storage = new MemoryStorage();
    storage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    const resolved = await resolveTrayWorkerBaseUrl({
      locationHref: 'http://localhost:3000/?tray=https://query.example.com/base/tray/tray-123',
      storage,
      envBaseUrl: 'https://env.example.com',
      runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com' }),
    });

    expect(resolved).toBe('https://query.example.com/base');
    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe('https://query.example.com/base');
  });

  it('resolves join-launch query state without losing the worker base URL', async () => {
    const storage = new MemoryStorage();

    await expect(
      resolveTrayRuntimeConfig({
        locationHref:
          'http://localhost:3000/?tray=https://tray.example.com/base/join/tray-join.secret',
        storage,
        envBaseUrl: 'https://env.example.com',
        runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com' }),
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });

    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe('https://tray.example.com/base');
  });

  it('resolves a join URL from the page path (worker-served webapp)', async () => {
    const storage = new MemoryStorage();

    await expect(
      resolveTrayRuntimeConfig({
        locationHref:
          'https://slicc-tray-hub-staging.minivelos.workers.dev/join/tray-id.secret-token',
        storage,
        envBaseUrl: null,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://slicc-tray-hub-staging.minivelos.workers.dev',
      trayId: 'tray-id',
      joinUrl: 'https://slicc-tray-hub-staging.minivelos.workers.dev/join/tray-id.secret-token',
    });

    expect(storage.getItem('slicc.trayJoinUrl')).toBe(
      'https://slicc-tray-hub-staging.minivelos.workers.dev/join/tray-id.secret-token'
    );
    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe(
      'https://slicc-tray-hub-staging.minivelos.workers.dev'
    );
  });

  it('prefers query param join URL over path-based join URL', async () => {
    const storage = new MemoryStorage();

    await expect(
      resolveTrayRuntimeConfig({
        locationHref:
          'https://worker.dev/join/path-tray.path-secret?tray=https://other.dev/join/query-tray.query-secret',
        storage,
        envBaseUrl: null,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://other.dev',
      trayId: 'query-tray',
      joinUrl: 'https://other.dev/join/query-tray.query-secret',
    });
  });

  it('resolves stored tray join state before server, stored leader, or env defaults', async () => {
    const storage = new MemoryStorage();
    storeTrayJoinUrl(storage, 'https://tray.example.com/base/join/tray-join.secret');
    storage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    await expect(
      resolveTrayRuntimeConfig({
        locationHref: 'http://localhost:3000/',
        storage,
        envBaseUrl: 'https://env.example.com',
        runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com' }),
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-join',
      joinUrl: 'https://tray.example.com/base/join/tray-join.secret',
    });
  });

  it('continues to recognize the legacy lead and trayWorkerUrl query parameters for backward compatibility', async () => {
    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref:
          'http://localhost:3000/?lead=https://legacy-lead.example.com/base/tray/tray-123',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe('https://legacy-lead.example.com/base');

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:3000/?trayWorkerUrl=https://legacy.example.com/',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe('https://legacy.example.com');
  });

  it('falls back to the server runtime config, then stored config, then build config, then runtime default', async () => {
    const serverStorage = new MemoryStorage();
    serverStorage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:3000/',
        storage: serverStorage,
        envBaseUrl: 'https://env.example.com',
        defaultWorkerBaseUrl: DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com/' }),
      })
    ).resolves.toBe('https://server.example.com');

    const storedOnlyStorage = new MemoryStorage();
    storedOnlyStorage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'chrome-extension://abc/index.html',
        storage: storedOnlyStorage,
        envBaseUrl: 'https://env.example.com',
        defaultWorkerBaseUrl: DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe('https://stored.example.com');

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'chrome-extension://abc/index.html',
        storage: new MemoryStorage(),
        envBaseUrl: 'https://env.example.com/',
        defaultWorkerBaseUrl: DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe('https://env.example.com');

    const defaultOnlyStorage = new MemoryStorage();

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:5710/',
        storage: defaultOnlyStorage,
        envBaseUrl: null,
        defaultWorkerBaseUrl: DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe(DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL);

    expect(defaultOnlyStorage.getItem('slicc.trayWorkerBaseUrl')).toBe(
      DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL
    );
  });

  it('uses runtime-mode defaults only when no stronger override exists', async () => {
    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:5710/',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        defaultWorkerBaseUrl: DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe(DEFAULT_STAGING_TRAY_WORKER_BASE_URL);

    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:5710/',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        defaultWorkerBaseUrl: DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBe(DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL);
  });

  it('returns null when runtime config cannot provide a worker URL', async () => {
    await expect(
      resolveTrayWorkerBaseUrl({
        locationHref: 'http://localhost:3000/',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        runtimeConfigFetcher: async () => null,
      })
    ).resolves.toBeNull();
  });

  it('resolves a tray join URL from the server runtime config (e.g. Electron auto-discovery)', async () => {
    const storage = new MemoryStorage();

    await expect(
      resolveTrayRuntimeConfig({
        locationHref: 'http://localhost:49742/electron',
        storage,
        envBaseUrl: null,
        runtimeConfigFetcher: async () => ({
          trayWorkerBaseUrl: null,
          trayJoinUrl: 'https://tray.example.com/base/join/tray-id.secret-token',
        }),
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-id',
      joinUrl: 'https://tray.example.com/base/join/tray-id.secret-token',
    });

    // Should persist both the join URL and worker base URL
    expect(storage.getItem('slicc.trayJoinUrl')).toBe(
      'https://tray.example.com/base/join/tray-id.secret-token'
    );
    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe('https://tray.example.com/base');
  });

  it('prefers server join URL over server worker base URL', async () => {
    await expect(
      resolveTrayRuntimeConfig({
        locationHref: 'http://localhost:49742/electron',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        runtimeConfigFetcher: async () => ({
          trayWorkerBaseUrl: 'https://other.example.com',
          trayJoinUrl: 'https://tray.example.com/base/join/tray-id.secret',
        }),
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-id',
      joinUrl: 'https://tray.example.com/base/join/tray-id.secret',
    });
  });

  it('falls back to server worker base URL when server join URL is absent', async () => {
    await expect(
      resolveTrayRuntimeConfig({
        locationHref: 'http://localhost:49742/electron',
        storage: new MemoryStorage(),
        envBaseUrl: null,
        runtimeConfigFetcher: async () => ({
          trayWorkerBaseUrl: 'https://tray.example.com',
          trayJoinUrl: null,
        }),
      })
    ).resolves.toEqual({
      workerBaseUrl: 'https://tray.example.com',
      trayId: null,
      joinUrl: null,
    });
  });

  it('fetches runtime config from the local runtime endpoint when available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ trayWorkerBaseUrl: 'https://tray.example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toEqual({
      trayWorkerBaseUrl: 'https://tray.example.com',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/runtime-config', {
      cache: 'no-store',
      headers: {},
    });
  });

  it('swallows runtime config fetch failures and returns null', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toBeNull();
  });
});

describe('resolveFollowerJoinUrl', () => {
  const JOIN = 'https://www.sliccy.ai/join/tray-1.cap-token';

  it('resolves a join URL on the current path', () => {
    expect(resolveFollowerJoinUrl(JOIN, null)).toBe(JOIN);
  });

  it('resolves a join URL passed via the ?tray= query (node-server --join shape)', () => {
    const href = `http://localhost:5710/?tray=${encodeURIComponent(JOIN)}`;
    expect(resolveFollowerJoinUrl(href, null)).toBe(JOIN);
  });

  it('resolves a stored join URL when the page URL has none', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN });
    expect(resolveFollowerJoinUrl('http://localhost:5710/', storage)).toBe(JOIN);
  });

  it('returns null for a leader …/tray/<id> session URL (joinUrl is null)', () => {
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai/base/tray/tray-1';
    expect(resolveFollowerJoinUrl(href, null)).toBeNull();
  });

  it('returns null for a worker-only config with no join URL', () => {
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai/base';
    expect(resolveFollowerJoinUrl(href, null)).toBeNull();
  });

  it('returns null when nothing is present', () => {
    expect(resolveFollowerJoinUrl('http://localhost:5710/', null)).toBeNull();
  });

  it('does NOT let a stored join URL hijack an explicit ?tray= lead launch', () => {
    // A profile that previously followed has a persisted join URL…
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN });
    // …but the current launch is `--lead` (?tray=<workerBaseUrl>, no join token).
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai';
    expect(resolveFollowerJoinUrl(href, storage)).toBeNull();
  });

  it('does NOT let a stored join URL hijack a /tray/<id> leader session URL', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN });
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai/base/tray/tray-1';
    expect(resolveFollowerJoinUrl(href, storage)).toBeNull();
  });

  it('still resumes from a stored join URL when the URL carries no tray intent', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN });
    expect(resolveFollowerJoinUrl('http://localhost:5710/', storage)).toBe(JOIN);
  });
});

describe('stripFollowerMarkerFromHref', () => {
  const JOIN = 'https://www.sliccy.ai/join/tray-1.cap-token';

  it('strips a …/join/<token> path so the URL no longer resolves as a follower', () => {
    const stripped = stripFollowerMarkerFromHref(JOIN);
    expect(stripped).toBe('https://www.sliccy.ai/');
    // Round-trip: the canonical entry shape no longer re-selects follower mode.
    expect(resolveFollowerJoinUrl(stripped, null)).toBeNull();
  });

  it('strips a …/base/join/<token> path back to the base prefix', () => {
    const stripped = stripFollowerMarkerFromHref('https://host.example/base/join/tok');
    expect(stripped).toBe('https://host.example/base');
    expect(resolveFollowerJoinUrl(stripped, null)).toBeNull();
  });

  it('strips the ?tray= query param (node-server --join shape)', () => {
    const href = `http://localhost:5710/?tray=${encodeURIComponent(JOIN)}`;
    const stripped = stripFollowerMarkerFromHref(href);
    expect(stripped).toBe('http://localhost:5710/');
    expect(resolveFollowerJoinUrl(stripped, null)).toBeNull();
  });

  it('leaves a URL with no follower marker unchanged', () => {
    expect(stripFollowerMarkerFromHref('https://www.sliccy.ai/')).toBe('https://www.sliccy.ai/');
  });

  it('returns the input unchanged when it is not a parseable URL', () => {
    expect(stripFollowerMarkerFromHref('not a url')).toBe('not a url');
  });
});
