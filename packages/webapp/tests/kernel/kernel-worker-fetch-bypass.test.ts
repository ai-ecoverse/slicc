/**
 * Tests for the kernel-worker fetch wrapper.
 *
 * Pins the same-origin-only stamping behavior so a future refactor
 * can't reintroduce the cross-origin CORS preflight that wedged
 * Pyodide / ImageMagick on strict CDNs.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isSameOrigin,
  makeSameOriginBypassFetch,
  type FetchFn,
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
});
