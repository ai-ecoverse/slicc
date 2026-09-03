import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setBridgeToken,
  setChromeExtensionRealm,
  setLocalApiBaseUrl,
} from '../../src/base/api-endpoint.js';
import { createTrayFetch, TrayProxyFetchError } from '../../src/shell/tray-fetch.js';

describe('createTrayFetch', () => {
  // Browsers reject `fetch` calls whose `this` is not the global Window /
  // WorkerGlobalScope, throwing "Illegal invocation". The leader stores the
  // returned function on `this.fetchImpl` and invokes it as a method, so
  // returning a bare reference to `fetch` would rebind `this` to the
  // LeaderTrayManager and break every request. The wrappers below assert that
  // the returned function tolerates an arbitrary `this` for both the
  // extension and standalone branches.
  const stubChromeRuntime = (mode: 'extension' | 'standalone') => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    if (mode === 'extension') {
      (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'test' } };
    } else {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
    // `getChromeExtensionRealm()` caches its answer per realm (#2276); force
    // a fresh read of the stub above instead of the previous test's cached
    // value, and reset the cache back to "unresolved" on restore so later
    // describe blocks re-probe their own stub.
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
    // A mock created via `vi.fn()` never throws on a rebound `this` — nothing
    // in vitest's node environment does — so a test that only checks the
    // RESULT can't tell a correct wrapper from a regressed one that returns
    // `fetchImpl` bare. Assert `this` directly instead, and invoke the
    // wrapper the way `LeaderTrayManager` actually does: as `this.fetchImpl
    // (url)`, a method call on an object property, not a bare call.
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
      // Real `fetch()` rejects any `this` that isn't Window/WorkerGlobalScope
      // ("Illegal invocation"). `holder` failing this assertion is exactly
      // the regression the wrapping arrow function exists to prevent.
      expect(capturedThis === undefined || capturedThis === globalThis).toBe(true);
      expect(capturedThis).not.toBe(holder);
    } finally {
      restore();
    }
  });

  it('routes cross-origin requests through the fetch proxy in non-extension mode', async () => {
    const restore = stubChromeRuntime('standalone');
    try {
      // Non-extension branch already wraps fetch in an arrow, so this case
      // existed pre-fix; included to lock in the existing behavior alongside
      // the new method-call invariant above.
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const holder = { call: wrapped };
      await expect(holder.call('https://tray.example.com/tray')).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);
      // Standalone branch routes off-origin requests through /api/fetch-proxy.
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
      // Called with the ORIGINAL url — not routed through /api/fetch-proxy.
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
  // Mirrors signed-fetch / http-broker / transformers-env: cover legacy
  // same-origin + the three thin-bridge cases so the `apiHeaders` /
  // `resolveApiUrl` wiring in `trayFetch` can't silently regress.
  // Standalone branch only — the extension branch bypasses /api/fetch-proxy
  // entirely (CDP-proxied), so thin-bridge headers don't apply there.
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
    // Force a fresh read of the deleted-chrome stub above (#2276's cache
    // otherwise carries over whatever the previous describe block set).
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
    // apiHeaders attaches the token ONLY when both base AND token are set.
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
    // Symmetric to the proxied-fetch rule: the token is a cross-origin
    // capability and must not leak on the loopback / bundled-UI path.
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
