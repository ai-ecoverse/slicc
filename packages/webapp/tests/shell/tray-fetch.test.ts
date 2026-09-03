import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setBridgeToken,
  setChromeExtensionRealm,
  setLocalApiBaseUrl,
} from '../../src/base/api-endpoint.js';
import { createTrayFetch } from '../../src/shell/tray-fetch.js';

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
    const restore = stubChromeRuntime('extension');
    try {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const holder = { call: wrapped };
      await expect(holder.call('https://example.com/x')).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);
      expect(inner.mock.calls[0]?.[0]).toBe('https://example.com/x');
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
