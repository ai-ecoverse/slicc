/**
 * The two adapter-boundary guarantees, tested directly (#2276 slice B).
 *
 * Both are invisible until a transport misbehaves in production, which is
 * exactly when they matter, so they get their own tests rather than relying
 * on an adapter exercising them incidentally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('with a timeout', () => {
    // A stalled chunk fetch (an evicted asset, a dead network) never rejects
    // on its own — without a deadline the caller (the first privileged op a
    // scoop makes, on `initShellAndSkills`'s hot path) hangs forever
    // (round-1 review finding 3).
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects a never-resolving load once the deadline passes, and clears the slot so a later call retries', async () => {
      let attempts = 0;
      const load = vi.fn(() => {
        attempts += 1;
        return attempts === 1
          ? new Promise(() => {}) // never resolves
          : Promise.resolve({ value: 'loaded' });
      });
      const lazy = createLazyOps(load, 10_000);

      const pending = lazy();
      const assertion = expect(pending).rejects.toThrow('exceeded 10000ms');
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      await expect(lazy()).resolves.toEqual({ value: 'loaded' });
      expect(attempts).toBe(2);
    });

    it('does not fire the timeout once the load already settled', async () => {
      const load = vi.fn(() => Promise.resolve({ value: 1 }));
      const lazy = createLazyOps(load, 10_000);
      await expect(lazy()).resolves.toEqual({ value: 1 });
      // No pending rejection surfaces even after the deadline would have
      // elapsed — the timer was cleared on the resolved path.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(load).toHaveBeenCalledTimes(1);
    });
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
