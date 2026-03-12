import { describe, expect, it, vi } from 'vitest';

import {
  buildTrayWorkerUrl,
  fetchRuntimeConfig,
  normalizeTrayWorkerBaseUrl,
  resolveTrayWorkerBaseUrl,
  type RuntimeConfigStorage,
} from './tray-runtime-config.js';

class MemoryStorage implements RuntimeConfigStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('tray-runtime-config', () => {
  it('normalizes tray worker base URLs and rejects invalid values', () => {
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/')).toBe('https://tray.example.com');
    expect(normalizeTrayWorkerBaseUrl('https://tray.example.com/base///')).toBe('https://tray.example.com/base');
    expect(normalizeTrayWorkerBaseUrl('not-a-url')).toBeNull();
  });

  it('builds worker endpoint URLs relative to the configured base URL', () => {
    expect(buildTrayWorkerUrl('https://tray.example.com/base', '/tray')).toBe('https://tray.example.com/base/tray');
    expect(buildTrayWorkerUrl('https://tray.example.com', 'controller/token')).toBe('https://tray.example.com/controller/token');
  });

  it('prefers query and server runtime config over stored and build defaults', async () => {
    const storage = new MemoryStorage();
    storage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    const resolved = await resolveTrayWorkerBaseUrl({
      locationHref: 'http://localhost:3000/?trayWorkerUrl=https://query.example.com/',
      storage,
      envBaseUrl: 'https://env.example.com',
      runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com' }),
    });

    expect(resolved).toBe('https://query.example.com');
    expect(storage.getItem('slicc.trayWorkerBaseUrl')).toBe('https://query.example.com');
  });

  it('falls back to the server runtime config, then stored config, then build config', async () => {
    const serverStorage = new MemoryStorage();
    serverStorage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    await expect(resolveTrayWorkerBaseUrl({
      locationHref: 'http://localhost:3000/',
      storage: serverStorage,
      envBaseUrl: 'https://env.example.com',
      runtimeConfigFetcher: async () => ({ trayWorkerBaseUrl: 'https://server.example.com/' }),
    })).resolves.toBe('https://server.example.com');

    const storedOnlyStorage = new MemoryStorage();
    storedOnlyStorage.setItem('slicc.trayWorkerBaseUrl', 'https://stored.example.com');

    await expect(resolveTrayWorkerBaseUrl({
      locationHref: 'chrome-extension://abc/index.html',
      storage: storedOnlyStorage,
      envBaseUrl: 'https://env.example.com',
      runtimeConfigFetcher: async () => null,
    })).resolves.toBe('https://stored.example.com');

    await expect(resolveTrayWorkerBaseUrl({
      locationHref: 'chrome-extension://abc/index.html',
      storage: new MemoryStorage(),
      envBaseUrl: 'https://env.example.com/',
      runtimeConfigFetcher: async () => null,
    })).resolves.toBe('https://env.example.com');
  });

  it('returns null when runtime config cannot provide a worker URL', async () => {
    await expect(resolveTrayWorkerBaseUrl({
      locationHref: 'http://localhost:3000/',
      storage: new MemoryStorage(),
      envBaseUrl: null,
      runtimeConfigFetcher: async () => null,
    })).resolves.toBeNull();
  });

  it('fetches runtime config from the local runtime endpoint when available', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ trayWorkerBaseUrl: 'https://tray.example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toEqual({ trayWorkerBaseUrl: 'https://tray.example.com' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/runtime-config', { cache: 'no-store' });
  });

  it('swallows runtime config fetch failures and returns null', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    await expect(fetchRuntimeConfig(fetchImpl)).resolves.toBeNull();
  });
});
