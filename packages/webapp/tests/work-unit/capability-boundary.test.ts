/**
 * The two adapter-boundary guarantees, tested directly (#2276 slice B).
 *
 * Both are invisible until a transport misbehaves in production, which is
 * exactly when they matter, so they get their own tests rather than relying
 * on an adapter exercising them incidentally.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLazyOps, guardCapability } from '../../src/work-unit/capability/boundary.js';
import {
  createRestCapabilityBroker,
  isCapabilityFailure,
} from '../../src/work-unit/capability/index.js';

describe('createLazyOps', () => {
  it('loads once and reuses the result', async () => {
    const load = vi.fn(() => Promise.resolve({ value: 1 }));
    const lazy = createLazyOps(load);
    expect(await lazy()).toEqual({ value: 1 });
    expect(await lazy()).toEqual({ value: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejection — one bad chunk load must not poison the broker', async () => {
    // A `promise ??= import(...)` caches the failure, so a single evicted
    // asset after a deploy would break every later operation for the life of
    // the tab. The retry is the whole point of this helper.
    let attempts = 0;
    const lazy = createLazyOps(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
        : Promise.resolve({ value: 'loaded' });
    });
    await expect(lazy()).rejects.toThrow('Failed to fetch');
    expect(await lazy()).toEqual({ value: 'loaded' });
    expect(attempts).toBe(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const load = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ value: 1 }), 5)));
    const lazy = createLazyOps(load);
    await Promise.all([lazy(), lazy(), lazy()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('guardCapability', () => {
  it('passes a typed result through untouched', async () => {
    const result = await guardCapability('secrets', 'set', () =>
      Promise.resolve({ ok: true as const, value: undefined })
    );
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('turns a rejection into a CapabilityFailure naming the operation', async () => {
    const result = await guardCapability('network', 'crossOriginFetch', () =>
      Promise.reject(new Error('chunk load failed'))
    );
    expect(isCapabilityFailure(result)).toBe(true);
    if (isCapabilityFailure(result)) {
      expect(result.capability).toBe('network');
      expect(result.operation).toBe('crossOriginFetch');
      expect(result.message).toBe('chunk load failed');
    }
  });

  it('survives a thrown non-Error', async () => {
    const result = await guardCapability('mounts', 'signRequest', () => {
      throw 'a bare string';
    });
    expect(isCapabilityFailure(result)).toBe(true);
    if (isCapabilityFailure(result)) expect(result.message).toBe('a bare string');
  });
});

describe('the boundary holds for a body that fails after its headers landed', () => {
  it('reports a rejected arrayBuffer as a failure, not as a throw', async () => {
    const broker = createRestCapabilityBroker({
      resolveUrl: (path) => path,
      fetchImpl: (async () =>
        ({
          status: 200,
          ok: true,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/octet-stream' }),
          arrayBuffer: () => Promise.reject(new Error('connection reset mid-body')),
        }) as unknown as Response) as typeof fetch,
    });
    const result = await broker.network.crossOriginFetch({ url: 'https://example.test/big' });
    expect(isCapabilityFailure(result)).toBe(true);
    if (isCapabilityFailure(result)) {
      expect(result.message).toContain('connection reset mid-body');
      expect(result.status).toBe(200);
    }
  });
});
