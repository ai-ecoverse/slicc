/**
 * Tests for the kernel-worker fetch wrapper.
 *
 * Pins the same-origin-only stamping behavior so a future refactor
 * can't reintroduce the cross-origin CORS preflight that wedged
 * Pyodide / ImageMagick on strict CDNs.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  type FetchFn,
  isBridgeFetchProxyTarget,
  isSameOrigin,
  makeSameOriginBypassFetch,
} from '../../src/kernel/kernel-worker-fetch-bypass.js';

const SELF_ORIGIN = 'http://localhost:5710';

function captureOrig(): {
  fn: FetchFn;
  calls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
} {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fn: FetchFn = vi.fn(async (input, init) => {
    calls.push({ input, init });
    return new Response('ok');
  });
  return { fn, calls };
}

function getHeader(init: RequestInit | undefined, key: string): string | null {
  if (!init?.headers) return null;
  return new Headers(init.headers).get(key);
}

describe('isSameOrigin', () => {
  it('matches absolute same-origin URLs', () => {
    expect(isSameOrigin(`${SELF_ORIGIN}/api/foo`, SELF_ORIGIN)).toBe(true);
  });

  it('treats relative URLs as same-origin', () => {
    expect(isSameOrigin('/api/foo', SELF_ORIGIN)).toBe(true);
    expect(isSameOrigin('foo/bar', SELF_ORIGIN)).toBe(true);
  });

  it('rejects cross-origin absolute URLs', () => {
    expect(isSameOrigin('https://cdn.jsdelivr.net/npm/x.wasm', SELF_ORIGIN)).toBe(false);
    expect(isSameOrigin('http://localhost:5711/foo', SELF_ORIGIN)).toBe(false);
  });

  it('treats a URL object the same as a string', () => {
    expect(isSameOrigin(new URL('/foo', SELF_ORIGIN), SELF_ORIGIN)).toBe(true);
    expect(isSameOrigin(new URL('https://cdn.jsdelivr.net/x'), SELF_ORIGIN)).toBe(false);
  });

  it('handles Request objects', () => {
    expect(isSameOrigin(new Request(`${SELF_ORIGIN}/api`), SELF_ORIGIN)).toBe(true);
    expect(isSameOrigin(new Request('https://api.openai.com/v1'), SELF_ORIGIN)).toBe(false);
  });

  it('defaults to same-origin for unparseable inputs', () => {
    // Empty string is a relative URL; resolves to SELF_ORIGIN/.
    expect(isSameOrigin('', SELF_ORIGIN)).toBe(true);
  });
});

describe('makeSameOriginBypassFetch', () => {
  it('stamps x-bypass-llm-proxy: 1 on same-origin requests', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN);
    await wrapped('/api/fetch-proxy');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('1');
  });

  it('leaves cross-origin requests untouched — no header, no CORS preflight surprise', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN);
    await wrapped('https://cdn.jsdelivr.net/npm/foo.wasm');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBeNull();
    // `init` should be passed through verbatim (we explicitly pass nothing here)
    expect(calls[0].init).toBeUndefined();
  });

  it('preserves caller-set bypass header on same-origin without overwriting', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN);
    await wrapped('/api/x', { headers: { 'x-bypass-llm-proxy': 'custom' } });
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('custom');
  });

  it('preserves other headers on same-origin requests', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN);
    await wrapped('/api/x', { headers: { 'content-type': 'application/json' } });
    expect(getHeader(calls[0].init, 'content-type')).toBe('application/json');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('1');
  });

  it('handles init.headers passed as a Headers instance (not just a plain object)', async () => {
    // Real fetch callers (proxiedFetch, every pi-ai provider via
    // their SDK) construct `Headers` first. A refactor to
    // `{ ...init?.headers }` would silently drop those entries
    // because Headers isn't enumerable as a plain object.
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN);
    const headers = new Headers();
    headers.set('authorization', 'Bearer token');
    headers.set('content-type', 'application/json');
    await wrapped('/api/x', { headers });
    expect(getHeader(calls[0].init, 'authorization')).toBe('Bearer token');
    expect(getHeader(calls[0].init, 'content-type')).toBe('application/json');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('1');
  });

  it('returns the original fetch unchanged when selfOrigin is missing', async () => {
    const { fn } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, undefined);
    expect(wrapped).toBe(fn);
  });

  it('stamps x-bypass-llm-proxy on cross-origin calls to the known bridge /api/fetch-proxy', async () => {
    // Thin-bridge: hosted-leader UI calls the local node-server's
    // /api/fetch-proxy across origins. Stamping the bypass header tells
    // the page-installed SW to leave the request alone (preserving the
    // caller's X-Target-URL byte-for-byte).
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => 'http://localhost:5711');
    await wrapped('http://localhost:5711/api/fetch-proxy', {
      headers: { 'X-Target-URL': 'https://api.openai.com/v1' },
    });
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('1');
    expect(getHeader(calls[0].init, 'X-Target-URL')).toBe('https://api.openai.com/v1');
  });

  it('does NOT stamp on cross-origin calls to the bridge origin if the path is different', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => 'http://localhost:5711');
    await wrapped('http://localhost:5711/some-other-route');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBeNull();
  });

  it('does NOT stamp on cross-origin CDN calls regardless of bridge config', async () => {
    // Regression: stamping the header on a CDN call would trip CORS
    // preflight (jsdelivr et al reject custom headers).
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => 'http://localhost:5711');
    await wrapped('https://cdn.jsdelivr.net/npm/x.wasm');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBeNull();
  });

  it('does NOT stamp when the bridge-origin getter returns null', async () => {
    // Outside thin-bridge mode the wrapper falls back to same-origin-only
    // stamping. Same as the no-getter behavior — confirms the getter is
    // consulted per-call and a null return doesn't error.
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => null);
    await wrapped('http://localhost:5711/api/fetch-proxy');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBeNull();
  });

  it('re-evaluates the bridge-origin getter on every call', async () => {
    // The boot path runs `setLocalApiBaseUrl(...)` AFTER `installFetchBypass`,
    // so a one-shot snapshot at construction time would miss the bridge
    // origin on the very first proxied-fetch call.
    let bridgeOrigin: string | null = null;
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => bridgeOrigin);
    await wrapped('http://localhost:5711/api/fetch-proxy');
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBeNull();
    bridgeOrigin = 'http://localhost:5711';
    await wrapped('http://localhost:5711/api/fetch-proxy');
    expect(getHeader(calls[1].init, 'x-bypass-llm-proxy')).toBe('1');
  });

  it('tolerates a throwing bridge-origin getter without breaking the request', async () => {
    const { fn, calls } = captureOrig();
    const wrapped = makeSameOriginBypassFetch(fn, SELF_ORIGIN, () => {
      throw new Error('boom');
    });
    // Same-origin call should still succeed unaffected.
    await expect(wrapped('/api/x')).resolves.toBeInstanceOf(Response);
    expect(getHeader(calls[0].init, 'x-bypass-llm-proxy')).toBe('1');
  });
});

describe('isBridgeFetchProxyTarget', () => {
  it('matches the bridge /api/fetch-proxy URL', () => {
    expect(
      isBridgeFetchProxyTarget(
        'http://localhost:5711/api/fetch-proxy',
        'http://localhost:5711',
        SELF_ORIGIN
      )
    ).toBe(true);
  });

  it('rejects a different path on the bridge origin', () => {
    expect(
      isBridgeFetchProxyTarget(
        'http://localhost:5711/api/other',
        'http://localhost:5711',
        SELF_ORIGIN
      )
    ).toBe(false);
  });

  it('rejects a different origin even with the matching path', () => {
    expect(
      isBridgeFetchProxyTarget(
        'http://localhost:5710/api/fetch-proxy',
        'http://localhost:5711',
        SELF_ORIGIN
      )
    ).toBe(false);
  });

  it('handles Request objects', () => {
    expect(
      isBridgeFetchProxyTarget(
        new Request('http://localhost:5711/api/fetch-proxy'),
        'http://localhost:5711',
        SELF_ORIGIN
      )
    ).toBe(true);
  });

  it('returns false on unparseable bridge origin', () => {
    expect(
      isBridgeFetchProxyTarget('http://localhost:5711/api/fetch-proxy', 'not a url', SELF_ORIGIN)
    ).toBe(false);
  });
});
