/**
 * Tests for the warm Pyodide realm pool (`py-realm-pool.ts`).
 *
 * Fake realms: the pool only needs `controlPort` + `terminate()`, so
 * these tests use no-op ports and spy on `terminate` to assert
 * warm-reuse (factory called once), FIFO queueing past the
 * concurrency limit, SIGKILL-style eviction + lazy replacement, and
 * idle-TTL drop — without booting Pyodide.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createPyRealmPool } from '../../../src/kernel/realm/py-realm-pool.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import type { Realm, RealmFactory } from '../../../src/kernel/realm/realm-runner.js';

const ctx = {} as CommandContext;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeFakeRealm(): Realm {
  const port: RealmPortLike = {
    postMessage: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { controlPort: port, terminate: vi.fn() };
}

function trackingFactory(): RealmFactory {
  return vi.fn(async ({ kind }) => {
    if (kind !== 'py') throw new Error('only py');
    return makeFakeRealm();
  });
}

describe('PyRealmPool', () => {
  it('reuses a warm idle worker across sequential checkouts (factory called once)', async () => {
    const factory = trackingFactory();
    const pool = createPyRealmPool({ factory, warmIdle: 1, maxConcurrent: 2, idleTtlMs: 0 });
    const l1 = await pool.checkout(ctx);
    l1.release();
    const l2 = await pool.checkout(ctx);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(l2.realm).toBe(l1.realm);
    pool.dispose();
  });

  it('creates up to maxConcurrent, queues the rest FIFO, and hands reused workers to waiters', async () => {
    const factory = trackingFactory();
    const pool = createPyRealmPool({ factory, warmIdle: 2, maxConcurrent: 2, idleTtlMs: 0 });
    const l1 = await pool.checkout(ctx);
    const l2 = await pool.checkout(ctx);
    expect(factory).toHaveBeenCalledTimes(2);

    const order: string[] = [];
    let l3: Awaited<ReturnType<typeof pool.checkout>> | undefined;
    let l4: Awaited<ReturnType<typeof pool.checkout>> | undefined;
    void pool.checkout(ctx).then((l) => {
      l3 = l;
      order.push('c');
    });
    void pool.checkout(ctx).then((l) => {
      l4 = l;
      order.push('d');
    });
    await flush();
    expect(pool.stats().waiting).toBe(2);
    expect(l3).toBeUndefined();

    l1.release();
    await flush();
    l2.release();
    await flush();

    expect(factory).toHaveBeenCalledTimes(2); // reused, not recreated
    expect(l3?.realm).toBe(l1.realm);
    expect(l4?.realm).toBe(l2.realm);
    expect(order).toEqual(['c', 'd']); // FIFO
    pool.dispose();
  });

  it('evicts a worker (terminate) and lazily creates a replacement for a queued waiter', async () => {
    const factory = trackingFactory();
    const pool = createPyRealmPool({ factory, warmIdle: 1, maxConcurrent: 1, idleTtlMs: 0 });
    const l1 = await pool.checkout(ctx);
    let l2: Awaited<ReturnType<typeof pool.checkout>> | undefined;
    void pool.checkout(ctx).then((l) => {
      l2 = l;
    });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);

    l1.evict();
    await flush();
    expect(l1.realm.terminate).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2); // lazy replacement
    expect(l2).toBeDefined();
    expect(l2?.realm).not.toBe(l1.realm);
    pool.dispose();
  });

  it('evict with no waiters drops the worker; the next checkout creates a fresh one', async () => {
    const factory = trackingFactory();
    const pool = createPyRealmPool({ factory, warmIdle: 1, maxConcurrent: 2, idleTtlMs: 0 });
    const l1 = await pool.checkout(ctx);
    l1.evict();
    expect(l1.realm.terminate).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toMatchObject({ idle: 0, busy: 0 });
    const l2 = await pool.checkout(ctx);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(l2.realm).not.toBe(l1.realm);
    pool.dispose();
  });

  it('keeps warmIdle workers warm and drops extras after the idle TTL', async () => {
    vi.useFakeTimers();
    try {
      const factory = trackingFactory();
      const pool = createPyRealmPool({ factory, warmIdle: 1, maxConcurrent: 3, idleTtlMs: 1000 });
      const l1 = await pool.checkout(ctx);
      const l2 = await pool.checkout(ctx);
      l1.release();
      l2.release();
      expect(pool.stats().idle).toBe(2);

      vi.advanceTimersByTime(1001);
      expect(pool.stats().idle).toBe(1); // one warm survivor
      expect(l2.realm.terminate).toHaveBeenCalledTimes(1); // extra dropped
      expect(l1.realm.terminate).not.toHaveBeenCalled();
      pool.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose terminates idle + busy workers and rejects pending waiters', async () => {
    const factory = trackingFactory();
    const pool = createPyRealmPool({ factory, warmIdle: 1, maxConcurrent: 1, idleTtlMs: 0 });
    const l1 = await pool.checkout(ctx);
    let rejected = false;
    void pool.checkout(ctx).catch(() => {
      rejected = true;
    });
    await flush();
    pool.dispose();
    await flush();
    expect(l1.realm.terminate).toHaveBeenCalledTimes(1);
    expect(rejected).toBe(true);
    await expect(pool.checkout(ctx)).rejects.toThrow(/disposed/);
  });
});
