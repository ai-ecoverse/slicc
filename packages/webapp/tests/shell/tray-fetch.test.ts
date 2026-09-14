import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setBridgeToken,
  setChromeExtensionRealm,
  setLocalApiBaseUrl,
} from '../../src/base/api-endpoint.js';
import { createTrayFetch, TrayProxyFetchError } from '../../src/shell/tray-fetch.js';

describe('createTrayFetch', () => {
  const stubChromeRuntime = (mode: 'extension' | 'standalone') => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    if (mode === 'extension') {
      (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'test' } };
    } else {
      delete (globalThis as { chrome?: unknown }).chrome;
    }

    setChromeExtensionRealm(mode === 'extension');
    return () => {
      if (original === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        (globalThis as { chrome?: unknown }).chrome = original;
      }
      setChromeExtensionRealm(null);
    };
  };

  it('preserves the underlying fetch when invoked as a method (extension branch)', async () => {
    const restore = stubChromeRuntime('extension');
    try {
      let capturedThis: unknown = 'not called';
      const inner = function (this: unknown, url: RequestInfo | URL): Promise<Response> {
        capturedThis = this;
        return Promise.resolve(new Response('ok'));
      } as typeof fetch;
      const wrapped = createTrayFetch(inner);
      const holder = { fetchImpl: wrapped };
      await expect(holder.fetchImpl('https://example.com/x')).resolves.toBeInstanceOf(Response);

      expect(capturedThis === undefined || capturedThis === globalThis).toBe(true);
      expect(capturedThis).not.toBe(holder);
    } finally {
      restore();
    }
  });

  it('routes cross-origin requests through the fetch proxy in non-extension mode', async () => {
    const restore = stubChromeRuntime('standalone');
    try {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const holder = { call: wrapped };
      await expect(holder.call('https://tray.example.com/tray')).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);

      expect(inner.mock.calls[0]?.[0]).toBe('/api/fetch-proxy');
    } finally {
      restore();
    }
  });

  it('throws TrayProxyFetchError when the response is tagged X-Proxy-Error — what shouldRecreateTray keys on', async () => {
    const restore = stubChromeRuntime('standalone');
    try {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('{"error":"tray worker unreachable"}', {
          status: 502,
          headers: { 'X-Proxy-Error': '1' },
        })
      );
      const wrapped = createTrayFetch(inner);
      await expect(wrapped('https://tray.example.com/tray')).rejects.toThrow(TrayProxyFetchError);
    } finally {
      restore();
    }
  });

  it('calls fetchImpl directly for a same-origin target, never /api/fetch-proxy', async () => {
    const restore = stubChromeRuntime('standalone');
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'https://leader.example' },
    };
    try {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const sameOriginUrl = 'https://leader.example/tray/status';
      await expect(wrapped(sameOriginUrl)).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);

      expect(inner.mock.calls[0]?.[0]).toBe(sameOriginUrl);
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = originalWindow;
      }
      restore();
    }
  });
});

describe('createTrayFetch — thin-bridge URL + token', () => {
  let restoreChrome: () => void;

  beforeEach(() => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    delete (globalThis as { chrome?: unknown }).chrome;
    restoreChrome = () => {
      if (original === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        (globalThis as { chrome?: unknown }).chrome = original;
      }
    };

    setChromeExtensionRealm(false);
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  afterEach(() => {
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    setChromeExtensionRealm(null);
    restoreChrome();
  });

  it('legacy / same-origin: routes cross-origin requests to relative /api/fetch-proxy with no X-Bridge-Token', async () => {
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const wrapped = createTrayFetch(inner);
    await wrapped('https://tray.example.com/tray');
    const [url, init] = inner.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/fetch-proxy');
    const headers = init.headers as Headers;
    expect(headers.get('X-Bridge-Token')).toBeNull();
    expect(headers.get('X-Target-URL')).toBe('https://tray.example.com/tray');
  });

  it('thin-bridge: routes to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const wrapped = createTrayFetch(inner);
    await wrapped('https://tray.example.com/tray');
    const [url, init] = inner.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5710/api/fetch-proxy');
    const headers = init.headers as Headers;
    expect(headers.get('X-Bridge-Token')).toBe('abc-123');
    expect(headers.get('X-Target-URL')).toBe('https://tray.example.com/tray');
  });

  it('thin-bridge: base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const wrapped = createTrayFetch(inner);
    await wrapped('https://tray.example.com/tray');
    const [url, init] = inner.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:5710/api/fetch-proxy');
    const headers = init.headers as Headers;
    expect(headers.get('X-Bridge-Token')).toBeNull();
  });

  it('token set but no base → relative path, X-Bridge-Token omitted', async () => {
    setBridgeToken('abc-123');
    const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const wrapped = createTrayFetch(inner);
    await wrapped('https://tray.example.com/tray');
    const [url, init] = inner.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/fetch-proxy');
    const headers = init.headers as Headers;
    expect(headers.get('X-Bridge-Token')).toBeNull();
  });
});
