import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_FLAG_STORAGE_KEY,
  getFeatureValue,
  initFeatureFlags,
} from '../../src/core/feature-flags.js';
import {
  featureFlagsRemoteCacheKey,
  hydrateFeatureFlagsFromRemote,
} from '../../src/core/feature-flags-remote.js';
import { TRAY_WORKER_STORAGE_KEY } from '../../src/scoops/tray-runtime-config.js';
import { resolveFeatureFlagsWorkerBaseUrl } from '../../src/ui/boot/setup-feature-flags.js';

function makeMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage());
  initFeatureFlags('standalone');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote feature flag hydration', () => {
  it('fetches the runtime float and initializes from payload.flags', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ float: 'default', flags: { 'experimental-settings': 'off' } })
    );

    await hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://flags.example/api/flags?float=standalone',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) })
    );
    expect(getFeatureValue('experimental-settings')).toBe('off');
    expect(localStorage.getItem(featureFlagsRemoteCacheKey('standalone'))).toBe(
      JSON.stringify({ 'experimental-settings': 'off' })
    );
  });

  it('keeps bundled defaults after an HTTP 500', async () => {
    await hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ error: 'failed' }, 500)
      ) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('on');
    expect(localStorage.getItem(featureFlagsRemoteCacheKey('standalone'))).toBeNull();
  });

  it('keeps bundled defaults after a network error', async () => {
    await hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('on');
  });

  it('keeps bundled defaults after a malformed body', async () => {
    await hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ float: 'standalone', flags: { 'experimental-settings': false } })
      ) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('on');
    expect(localStorage.getItem(featureFlagsRemoteCacheKey('standalone'))).toBeNull();
  });

  it('keeps bundled defaults after malformed JSON', async () => {
    await hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(
        async () =>
          new Response('{not-json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      ) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('on');
  });

  it('times out silently and aborts the request', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const hydration = hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await hydration;

    expect(signal?.aborted).toBe(true);
    expect(getFeatureValue('experimental-settings')).toBe('on');
  });

  it('hydrates from cache synchronously while offline', async () => {
    localStorage.setItem(
      featureFlagsRemoteCacheKey('standalone'),
      JSON.stringify({ 'experimental-settings': 'off' })
    );
    const hydration = hydrateFeatureFlagsFromRemote('standalone', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('off');
    await hydration;
    expect(getFeatureValue('experimental-settings')).toBe('off');
  });

  it('keeps the runtime Cherry float when the worker echoes default', async () => {
    localStorage.setItem(
      FEATURE_FLAG_STORAGE_KEY,
      JSON.stringify({ 'experimental-settings': 'on' })
    );

    await hydrateFeatureFlagsFromRemote('cherry', {
      workerBaseUrl: 'https://flags.example',
      fetchImpl: vi.fn(async () =>
        jsonResponse({ float: 'default', flags: { 'experimental-settings': 'off' } })
      ) as unknown as typeof fetch,
    });

    expect(getFeatureValue('experimental-settings')).toBe('off');
  });

  it('resolves the worker origin without routing through the local API bridge', () => {
    localStorage.setItem(TRAY_WORKER_STORAGE_KEY, 'https://configured-worker.example/');
    expect(
      resolveFeatureFlagsWorkerBaseUrl({
        locationHref: 'https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp',
        storage: localStorage,
        envBaseUrl: null,
        isDev: false,
      })
    ).toBe('https://configured-worker.example');
    localStorage.removeItem(TRAY_WORKER_STORAGE_KEY);
    expect(
      resolveFeatureFlagsWorkerBaseUrl({
        locationHref: 'https://custom-worker.example/?cherry=1',
        storage: localStorage,
        envBaseUrl: null,
        isDev: false,
      })
    ).toBe('https://custom-worker.example');
  });
});
