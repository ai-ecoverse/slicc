import { describe, expect, it } from 'vitest';
import {
  BridgeConfigCache,
  createNonceWaiter,
  ExtensionDelegateCache,
  filterAuthorizedProxyClients,
  isBridgeConfigMessage,
  isBridgeFetchProxyUrl,
  isBridgeLocalApiUrl,
  isExtensionDelegateMessage,
  isExtensionFetchDelegateRequest,
  isPassthroughDestination,
  maySetProxyConfig,
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
    expect(
      resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridge=not-a-url&bridgeToken=t')
    ).toBeNull();
  });

  it('rejects a non-loopback bridge host (#2963 — SW parser must apply the #2939 loopback guard)', () => {
    for (const host of [
      'attacker.example',
      'bridge.example',
      '169.254.169.254',
      '10.0.0.5',
      'localhost.attacker.example',
      '127.0.0.1.attacker.example',
    ]) {
      const clientUrl = `https://www.sliccy.ai/?bridge=${encodeURIComponent(
        `wss://${host}/cdp`
      )}&bridgeToken=deadbeef`;
      expect(resolveBridgeConfig(null, clientUrl), host).toBeNull();
    }
  });

  it('accepts every loopback spelling a launcher may emit on the fallback path', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]']) {
      const clientUrl = `https://www.sliccy.ai/?bridge=${encodeURIComponent(
        `ws://${host}:5710/cdp`
      )}&bridgeToken=x`;
      expect(resolveBridgeConfig(null, clientUrl), host).toEqual({
        apiBaseUrl: `http://${host}:5710`,
        token: 'x',
      });
    }
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

  it('skips a non-loopback candidate on the window-enumeration fallback (#2963)', () => {
    expect(
      resolveBridgeFromClientUrls(null, [
        'http://localhost:5710/kernel-worker.js',
        'https://www.sliccy.ai/?bridge=wss://attacker.example/cdp&bridgeToken=deadbeef',
      ])
    ).toBeNull();
  });

  it('prefers a later loopback candidate over an earlier non-loopback one', () => {
    const out = resolveBridgeFromClientUrls(null, [
      'https://www.sliccy.ai/?bridge=wss://attacker.example/cdp&bridgeToken=evil',
      'https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp&bridgeToken=good',
    ]);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'good' });
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
  it('accepts ONLY a top-level window client — the leader page', () => {
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'top-level', id: 'a' })).toBe(true);
  });

  it('rejects a realm/kernel WORKER client (the reintroduced-escape vector)', () => {
    expect(maySetSyncFsNonce({ type: 'worker', id: 'w' })).toBe(false);
    expect(maySetSyncFsNonce({ type: 'worker', frameType: 'none', id: 'w' })).toBe(false);
  });

  it('rejects a NESTED window client (a srcdoc sprinkle/dip iframe) — Finding 1', () => {
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'nested', id: 'f' })).toBe(false);
  });

  it('rejects an AUXILIARY window client (window.open from an allow-popups sprinkle)', () => {
    expect(maySetSyncFsNonce({ type: 'window', frameType: 'auxiliary', id: 'b' })).toBe(false);
  });

  it('rejects non-Client sources (ServiceWorker / MessagePort / null)', () => {
    expect(maySetSyncFsNonce(null)).toBe(false);
    expect(maySetSyncFsNonce(undefined)).toBe(false);
    expect(maySetSyncFsNonce({ id: 'x' })).toBe(false);
    expect(maySetSyncFsNonce({ type: 'window' })).toBe(false);
  });
});

describe('maySetProxyConfig (bridge-config security gate)', () => {
  it('accepts only the top-level leader window', () => {
    expect(maySetProxyConfig({ type: 'window', frameType: 'top-level', id: 'leader' })).toBe(true);
    expect(maySetProxyConfig({ type: 'worker', id: 'realm' })).toBe(false);
    expect(maySetProxyConfig({ type: 'window', frameType: 'nested', id: 'sprinkle' })).toBe(false);
    expect(maySetProxyConfig({ type: 'window', frameType: 'auxiliary', id: 'popup' })).toBe(false);
    expect(maySetProxyConfig(null)).toBe(false);
  });

  it('filters URL fallbacks and delegate candidates to top-level windows', () => {
    const leader = { type: 'window', frameType: 'top-level', url: 'https://leader.test/' };
    const clients = [
      leader,
      { type: 'window', frameType: 'nested', url: 'https://nested.test/?bridge=evil' },
      { type: 'window', frameType: 'auxiliary', url: 'https://popup.test/?ext=evil' },
      { type: 'worker', frameType: 'none', url: 'https://worker.test/' },
    ];

    expect(filterAuthorizedProxyClients(clients)).toEqual([leader]);
  });
});

describe('createNonceWaiter (cold-start fix C)', () => {
  it('resolves a pending wait as soon as notify() fires (before the timeout)', async () => {
    const w = createNonceWaiter();
    let done = false;

    const p = w.wait(60_000).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    w.notify();
    await p;
    expect(done).toBe(true);
  });

  it('resolves on timeout when no notify arrives (never hangs)', async () => {
    const w = createNonceWaiter();
    await expect(w.wait(10)).resolves.toBeUndefined();
  });

  it('notify() resolves every concurrent waiter', async () => {
    const w = createNonceWaiter();
    const a = w.wait(60_000);
    const b = w.wait(60_000);
    w.notify();
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  it('a notify() with no pending waiter is a no-op (later wait still times out)', async () => {
    const w = createNonceWaiter();
    w.notify();
    await expect(w.wait(10)).resolves.toBeUndefined();
  });
});
