/**
 * Tests for the LLM-proxy SW's thin-bridge config resolver.
 *
 * Pins the two-tier lookup contract: the `postMessage` cache wins when
 * present, and a cache miss falls back to parsing `bridge`/`bridgeToken`
 * from the controlling client's URL via the shared
 * `bridge-launch-params` constants. Without the fallback the SW would
 * lose thin-bridge mode on every eviction/restart and Bedrock + Adobe
 * requests would fail with the Cloudflare "Fetch proxy not available in
 * worker mode" 404 again.
 */

import { describe, expect, it } from 'vitest';
import {
  BridgeConfigCache,
  ExtensionDelegateCache,
  isBridgeConfigMessage,
  isBridgeFetchProxyUrl,
  isBridgeLocalApiUrl,
  isExtensionDelegateMessage,
  isExtensionFetchDelegateRequest,
  isPassthroughDestination,
  maySetSyncFsNonce,
  parseExtensionDelegateFromClientUrl,
  resolveBridgeConfig,
  resolveBridgeFromClientUrls,
  resolveExtensionDelegate,
  resolveFetchProxyTarget,
  SW_BRIDGE_CONFIG_MESSAGE,
  SW_EXTENSION_DELEGATE_MESSAGE,
  SW_EXTENSION_FETCH_MESSAGE,
} from '../../src/ui/llm-proxy-sw-config.js';

describe('resolveBridgeConfig', () => {
  it('returns null when there is no cache and no client URL', () => {
    expect(resolveBridgeConfig(null, null)).toBeNull();
    expect(resolveBridgeConfig({ apiBaseUrl: null, token: null }, null)).toBeNull();
  });

  it('prefers the cached values over the client URL', () => {
    const cached = { apiBaseUrl: 'http://localhost:5710', token: 'cached-token' };
    const clientUrl = 'https://www.sliccy.ai/?bridge=ws://localhost:9999/cdp&bridgeToken=url-token';
    const out = resolveBridgeConfig(cached, clientUrl);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'cached-token' });
  });

  it('strips a trailing slash from the cached apiBaseUrl', () => {
    const out = resolveBridgeConfig({ apiBaseUrl: 'http://localhost:5710/', token: 't' }, null);
    expect(out?.apiBaseUrl).toBe('http://localhost:5710');
  });

  it('falls back to parsing the controlling client URL when cache is empty', () => {
    const clientUrl =
      'https://www.sliccy.ai/?bridge=ws%3A%2F%2Flocalhost%3A5710%2Fcdp&bridgeToken=abc-123';
    const out = resolveBridgeConfig(null, clientUrl);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'abc-123' });
  });

  it('treats a partial cache (apiBaseUrl only) as a miss and falls back', () => {
    const out = resolveBridgeConfig(
      { apiBaseUrl: 'http://localhost:5710', token: null },
      'https://www.sliccy.ai/?bridge=ws://localhost:5711/cdp&bridgeToken=fallback-token'
    );
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5711', token: 'fallback-token' });
  });

  it('returns null when the client URL is unparseable', () => {
    expect(resolveBridgeConfig(null, 'not a url')).toBeNull();
  });

  it('returns null when the client URL lacks both bridge params', () => {
    expect(resolveBridgeConfig(null, 'https://www.sliccy.ai/?foo=bar')).toBeNull();
  });

  it('returns null when only one of the two params is present', () => {
    expect(
      resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp')
    ).toBeNull();
    expect(resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridgeToken=abc')).toBeNull();
  });

  it('returns null when the bridge URL cannot derive an api base', () => {
    // Bare hostname → URL parser fails → deriveBridgeApiBaseUrl → null.
    expect(
      resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridge=not-a-url&bridgeToken=t')
    ).toBeNull();
  });
});

describe('resolveBridgeFromClientUrls', () => {
  it('returns the cached config without inspecting any candidate URLs', () => {
    const cached = { apiBaseUrl: 'http://localhost:5710/', token: 'cached-token' };
    const out = resolveBridgeFromClientUrls(cached, [
      'about:blank',
      'https://www.sliccy.ai/?bridge=ws://localhost:9999/cdp&bridgeToken=other',
    ]);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'cached-token' });
  });

  it('falls back to a window client URL when the worker client URL has no params', () => {
    // First candidate mimics the kernel DedicatedWorker (no bridge params);
    // second is the page window URL carrying the launch params. The
    // resolver must skip the worker entry and pick up the window entry.
    const out = resolveBridgeFromClientUrls(null, [
      'http://localhost:5710/kernel-worker.js',
      'https://www.sliccy.ai/?bridge=ws%3A%2F%2Flocalhost%3A5710%2Fcdp&bridgeToken=abc-123',
    ]);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'abc-123' });
  });

  it('returns the first candidate that carries the launch params', () => {
    const out = resolveBridgeFromClientUrls(null, [
      'https://www.sliccy.ai/?bridge=ws://localhost:5711/cdp&bridgeToken=first',
      'https://www.sliccy.ai/?bridge=ws://localhost:5712/cdp&bridgeToken=second',
    ]);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5711', token: 'first' });
  });

  it('returns null when no candidate carries launch params and the cache is empty', () => {
    expect(
      resolveBridgeFromClientUrls(null, [
        'http://localhost:5710/kernel-worker.js',
        'https://www.sliccy.ai/?foo=bar',
        null,
      ])
    ).toBeNull();
  });

  it('treats a partial cache (apiBaseUrl only) as a miss and consults the candidates', () => {
    const out = resolveBridgeFromClientUrls({ apiBaseUrl: 'http://localhost:5710', token: null }, [
      'http://localhost:5710/kernel-worker.js',
      'https://www.sliccy.ai/?bridge=ws://localhost:5711/cdp&bridgeToken=fallback-token',
    ]);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5711', token: 'fallback-token' });
  });

  it('returns null when given an empty candidate list and no cache', () => {
    expect(resolveBridgeFromClientUrls(null, [])).toBeNull();
  });
});

describe('resolveFetchProxyTarget', () => {
  it('returns the same-origin path when no bridge config is in effect', () => {
    expect(resolveFetchProxyTarget('/api/fetch-proxy', null)).toBe('/api/fetch-proxy');
  });

  it('prepends the local node-server origin in thin-bridge mode', () => {
    expect(
      resolveFetchProxyTarget('/api/fetch-proxy', {
        apiBaseUrl: 'http://localhost:5710',
        token: 'abc',
      })
    ).toBe('http://localhost:5710/api/fetch-proxy');
  });
});

describe('isBridgeFetchProxyUrl', () => {
  it('matches the bridge /api/fetch-proxy on the configured origin', () => {
    expect(
      isBridgeFetchProxyUrl('http://localhost:5710/api/fetch-proxy', 'http://localhost:5710')
    ).toBe(true);
  });

  it('matches regardless of trailing slash on the bridge base URL', () => {
    expect(
      isBridgeFetchProxyUrl('http://localhost:5710/api/fetch-proxy', 'http://localhost:5710/')
    ).toBe(true);
  });

  it('ignores query strings on the target URL', () => {
    expect(
      isBridgeFetchProxyUrl('http://localhost:5710/api/fetch-proxy?x=1', 'http://localhost:5710')
    ).toBe(true);
  });

  it('rejects a different path under the same origin', () => {
    expect(
      isBridgeFetchProxyUrl('http://localhost:5710/api/something-else', 'http://localhost:5710')
    ).toBe(false);
  });

  it('rejects a different origin even if the path matches', () => {
    expect(
      isBridgeFetchProxyUrl('https://api.openai.com/api/fetch-proxy', 'http://localhost:5710')
    ).toBe(false);
  });

  it('rejects different ports on the same host', () => {
    expect(
      isBridgeFetchProxyUrl('http://localhost:5711/api/fetch-proxy', 'http://localhost:5710')
    ).toBe(false);
  });

  it('honors the optional fetchProxyPath override', () => {
    expect(
      isBridgeFetchProxyUrl(
        'http://localhost:5710/api/other-proxy',
        'http://localhost:5710',
        '/api/other-proxy'
      )
    ).toBe(true);
  });

  it('returns false for unparseable inputs', () => {
    expect(isBridgeFetchProxyUrl('not a url', 'http://localhost:5710')).toBe(false);
    expect(isBridgeFetchProxyUrl('http://localhost:5710/api/fetch-proxy', 'not a url')).toBe(false);
  });
});

describe('isBridgeLocalApiUrl', () => {
  it('matches /api/da-sign-and-forward at the bridge origin', () => {
    expect(
      isBridgeLocalApiUrl('http://localhost:5710/api/da-sign-and-forward', 'http://localhost:5710')
    ).toBe(true);
  });

  it('matches /api/s3-sign-and-forward at the bridge origin', () => {
    expect(
      isBridgeLocalApiUrl('http://localhost:5710/api/s3-sign-and-forward', 'http://localhost:5710')
    ).toBe(true);
  });

  it('matches /api/fetch-proxy at the bridge origin', () => {
    expect(
      isBridgeLocalApiUrl('http://localhost:5710/api/fetch-proxy', 'http://localhost:5710')
    ).toBe(true);
  });

  it('rejects a non-/api/ path at the bridge origin', () => {
    expect(isBridgeLocalApiUrl('http://localhost:5710/preview/foo', 'http://localhost:5710')).toBe(
      false
    );
  });

  it('rejects an /api/ path on a different origin', () => {
    expect(
      isBridgeLocalApiUrl('http://localhost:5711/api/da-sign-and-forward', 'http://localhost:5710')
    ).toBe(false);
  });

  it('returns false for unparseable inputs', () => {
    expect(isBridgeLocalApiUrl('not a url', 'http://localhost:5710')).toBe(false);
    expect(isBridgeLocalApiUrl('http://localhost:5710/api/da-sign-and-forward', 'not a url')).toBe(
      false
    );
  });
});

describe('isBridgeConfigMessage', () => {
  it('accepts the tagged message shape', () => {
    expect(
      isBridgeConfigMessage({
        type: SW_BRIDGE_CONFIG_MESSAGE,
        apiBaseUrl: 'http://localhost:5710',
        token: 'abc',
      })
    ).toBe(true);
  });

  it('rejects unrelated messages', () => {
    expect(isBridgeConfigMessage(null)).toBe(false);
    expect(isBridgeConfigMessage(undefined)).toBe(false);
    expect(isBridgeConfigMessage('string')).toBe(false);
    expect(isBridgeConfigMessage({ type: 'something-else' })).toBe(false);
    expect(isBridgeConfigMessage({})).toBe(false);
  });
});

describe('BridgeConfigCache', () => {
  it('returns null for an unknown client id', () => {
    const cache = new BridgeConfigCache();
    expect(cache.get('client-a')).toBeNull();
  });

  it('returns null when called with a null/undefined/empty client id', () => {
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'a' });
    expect(cache.get(null)).toBeNull();
    expect(cache.get(undefined)).toBeNull();
    expect(cache.get('')).toBeNull();
  });

  it('stores a config and returns it (trimming the trailing slash on apiBaseUrl)', () => {
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710/', token: 'tok-a' });
    expect(cache.get('client-a')).toEqual({
      apiBaseUrl: 'http://localhost:5710',
      token: 'tok-a',
    });
  });

  it('treats a partial payload (null apiBaseUrl or token) as a delete', () => {
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    cache.set('client-a', { apiBaseUrl: null, token: 'tok-a' });
    expect(cache.get('client-a')).toBeNull();

    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: null });
    expect(cache.get('client-a')).toBeNull();
  });

  it('ignores set() calls with an empty client id', () => {
    const cache = new BridgeConfigCache();
    cache.set('', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    expect(cache.size()).toBe(0);
  });

  it('isolates two clients so posting from B does not corrupt A', () => {
    // Regression for the multi-tab collision: previously the SW kept a
    // single module-level pair of `cachedBridgeApiBaseUrl` /
    // `cachedBridgeToken`, so when leader tab B (different bridge /
    // token because it was launched on a different node-server port)
    // posted its config, leader tab A's subsequent LLM / curl
    // requests started flowing to tab B's bridge with tab B's token.
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    cache.set('client-b', { apiBaseUrl: 'http://localhost:5711', token: 'tok-b' });
    expect(cache.get('client-a')).toEqual({
      apiBaseUrl: 'http://localhost:5710',
      token: 'tok-a',
    });
    expect(cache.get('client-b')).toEqual({
      apiBaseUrl: 'http://localhost:5711',
      token: 'tok-b',
    });
  });

  it('overwrites a single client without disturbing other clients', () => {
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    cache.set('client-b', { apiBaseUrl: 'http://localhost:5711', token: 'tok-b' });
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5712', token: 'tok-a2' });
    expect(cache.get('client-a')).toEqual({
      apiBaseUrl: 'http://localhost:5712',
      token: 'tok-a2',
    });
    expect(cache.get('client-b')).toEqual({
      apiBaseUrl: 'http://localhost:5711',
      token: 'tok-b',
    });
  });

  it('clears one client without affecting the others', () => {
    const cache = new BridgeConfigCache();
    cache.set('client-a', { apiBaseUrl: 'http://localhost:5710', token: 'tok-a' });
    cache.set('client-b', { apiBaseUrl: 'http://localhost:5711', token: 'tok-b' });
    cache.delete('client-a');
    expect(cache.get('client-a')).toBeNull();
    expect(cache.get('client-b')).toEqual({
      apiBaseUrl: 'http://localhost:5711',
      token: 'tok-b',
    });
    expect(cache.size()).toBe(1);
  });
});

describe('parseExtensionDelegateFromClientUrl', () => {
  it('returns the extension id for a pinned leader-tab URL', () => {
    const out = parseExtensionDelegateFromClientUrl(
      'https://www.sliccy.ai/?slicc=leader&ext=abc123'
    );
    expect(out).toEqual({ extensionId: 'abc123' });
  });

  it('returns null when slicc=leader is missing', () => {
    expect(parseExtensionDelegateFromClientUrl('https://www.sliccy.ai/?ext=abc123')).toBeNull();
  });

  it('returns null when ext is missing or empty', () => {
    expect(parseExtensionDelegateFromClientUrl('https://www.sliccy.ai/?slicc=leader')).toBeNull();
    expect(
      parseExtensionDelegateFromClientUrl('https://www.sliccy.ai/?slicc=leader&ext=')
    ).toBeNull();
  });

  it('returns null for null / unparseable URLs', () => {
    expect(parseExtensionDelegateFromClientUrl(null)).toBeNull();
    expect(parseExtensionDelegateFromClientUrl('::not a url::')).toBeNull();
  });
});

describe('resolveExtensionDelegate', () => {
  it('prefers the cached value over client URLs', () => {
    const out = resolveExtensionDelegate({ extensionId: 'cached' }, [
      'https://www.sliccy.ai/?slicc=leader&ext=fromurl',
    ]);
    expect(out).toEqual({ extensionId: 'cached' });
  });

  it('falls back to scanning candidate client URLs', () => {
    const out = resolveExtensionDelegate(null, [
      'https://www.sliccy.ai/kernel-worker.js',
      'https://www.sliccy.ai/?slicc=leader&ext=fromurl',
    ]);
    expect(out).toEqual({ extensionId: 'fromurl' });
  });

  it('returns null when neither cache nor URLs resolve', () => {
    expect(resolveExtensionDelegate(null, [null, 'https://www.sliccy.ai/'])).toBeNull();
  });
});

describe('isExtensionDelegateMessage', () => {
  it('accepts the tagged config message', () => {
    expect(
      isExtensionDelegateMessage({ type: SW_EXTENSION_DELEGATE_MESSAGE, extensionId: 'abc' })
    ).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isExtensionDelegateMessage(null)).toBe(false);
    expect(isExtensionDelegateMessage({ type: 'other' })).toBe(false);
  });
});

describe('isExtensionFetchDelegateRequest', () => {
  it('accepts a well-formed envelope', () => {
    expect(
      isExtensionFetchDelegateRequest({
        type: SW_EXTENSION_FETCH_MESSAGE,
        requestId: 'r1',
        extensionId: 'abc',
        request: { url: 'https://x', method: 'POST', headers: {} },
      })
    ).toBe(true);
  });

  it('rejects when fields are missing or wrong type', () => {
    expect(isExtensionFetchDelegateRequest(null)).toBe(false);
    expect(isExtensionFetchDelegateRequest({ type: SW_EXTENSION_FETCH_MESSAGE })).toBe(false);
    expect(
      isExtensionFetchDelegateRequest({ type: 'other', extensionId: 'abc', request: {} })
    ).toBe(false);
    expect(
      isExtensionFetchDelegateRequest({
        type: SW_EXTENSION_FETCH_MESSAGE,
        extensionId: 5,
        request: {},
      })
    ).toBe(false);
  });
});

describe('ExtensionDelegateCache', () => {
  it('stores and reads per-client extension ids', () => {
    const cache = new ExtensionDelegateCache();
    cache.set('client-a', { extensionId: 'ext-a' });
    cache.set('client-b', { extensionId: 'ext-b' });
    expect(cache.get('client-a')).toEqual({ extensionId: 'ext-a' });
    expect(cache.get('client-b')).toEqual({ extensionId: 'ext-b' });
    expect(cache.size()).toBe(2);
  });

  it('a null extensionId deletes the entry', () => {
    const cache = new ExtensionDelegateCache();
    cache.set('client-a', { extensionId: 'ext-a' });
    cache.set('client-a', { extensionId: null });
    expect(cache.get('client-a')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('returns null for unknown / empty client ids', () => {
    const cache = new ExtensionDelegateCache();
    expect(cache.get(null)).toBeNull();
    expect(cache.get('missing')).toBeNull();
  });
});

/**
 * Regression: a plain cross-origin `<img>` inside a sprinkle's srcdoc
 * iframe was getting swept into the proxy rewrite alongside genuine
 * `fetch()`/XHR calls. Images don't need CORS bypass or secret injection,
 * but the worker deployment's `/api/fetch-proxy` always dead-stubs with
 * 404 ("Fetch proxy not available in worker mode") — so any sprinkle with
 * an external image 404'd. Only `fetch()`/XHR (empty `destination`) should
 * ever be rewritten.
 */
describe('isPassthroughDestination', () => {
  it('exempts image, font, and other passive resource loads', () => {
    for (const destination of [
      'image',
      'font',
      'style',
      'video',
      'audio',
      'track',
      'iframe',
      'object',
      'embed',
    ]) {
      expect(isPassthroughDestination(destination)).toBe(true);
    }
  });

  it('does not exempt fetch()/XHR calls (empty destination)', () => {
    expect(isPassthroughDestination('')).toBe(false);
  });

  it('does not exempt document/script/worker loads', () => {
    expect(isPassthroughDestination('document')).toBe(false);
    expect(isPassthroughDestination('script')).toBe(false);
    expect(isPassthroughDestination('worker')).toBe(false);
  });
});

describe('maySetSyncFsNonce (sync-fs channel-nonce security gate)', () => {
  it('accepts ONLY a top-level (or auxiliary) window client — the leader page', () => {
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'top-level', id: 'a' })).toBe(true);
    // window.open()'d popout — still a real top-level browsing context.
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'auxiliary', id: 'b' })).toBe(true);
  });

  it('rejects a realm/kernel WORKER client (the reintroduced-escape vector)', () => {
    // A realm is a controlled `worker` client; if it could set the nonce it
    // would repoint the channel and harvest every realm's token.
    expect(maySetSyncFsNonce({ type: 'worker', id: 'w' })).toBe(false);
    expect(maySetSyncFsNonce({ type: 'worker', frameType: 'none', id: 'w' })).toBe(false);
  });

  it('rejects a NESTED window client (a srcdoc sprinkle/dip iframe) — Finding 1', () => {
    // A same-origin allow-same-origin srcdoc sprinkle/dip is a `window` client
    // but a nested browsing context; it must not repoint the global nonce.
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'nested', id: 'f' })).toBe(false);
  });

  it('rejects non-Client sources (ServiceWorker / MessagePort / null)', () => {
    expect(maySetSyncFsNonce(null)).toBe(false);
    expect(maySetSyncFsNonce(undefined)).toBe(false);
    expect(maySetSyncFsNonce({ id: 'x' })).toBe(false); // no type
    expect(maySetSyncFsNonce({ type: 'window' })).toBe(false); // no frameType
  });
});
