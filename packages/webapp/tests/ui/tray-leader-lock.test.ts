import { describe, expect, it } from 'vitest';
import {
  type LeaderLockResult,
  type LockManagerLike,
  requestLeaderLock,
} from '../../src/ui/tray-leader-lock.js';

// ---------------------------------------------------------------------------
// In-memory LockManager fake (spec-accurate: callbacks queued async)
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fake that mirrors the Web Locks API semantics
 * relevant to `requestLeaderLock`: exclusive mode, `ifAvailable`, and
 * FIFO waiting.
 *
 * Callbacks are always invoked asynchronously via `queueMicrotask`
 * to match the real browser behavior — `navigator.locks.request`
 * never invokes its callback synchronously.
 */
function createFakeLockManager(): LockManagerLike {
  const held = new Map<string, { resolve: () => void }>();
  const waiters = new Map<string, Array<() => void>>();

  const release = (name: string): void => {
    held.delete(name);
    const queue = waiters.get(name);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      next();
    }
  };

  const mgr: LockManagerLike = {
    request(
      name: string,
      options: { mode: 'exclusive'; ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<void>
    ): Promise<void> {
      return new Promise<void>((outerResolve) => {
        // Queue via microtask to match real browser behavior.
        queueMicrotask(() => {
          if (options.ifAvailable) {
            if (held.has(name)) {
              // Lock unavailable — call with null per spec.
              void callback(null).then(outerResolve);
              return;
            }
            // Grant immediately.
            const cbPromise = callback({});
            held.set(name, { resolve: outerResolve });
            void cbPromise.then(() => {
              release(name);
              outerResolve();
            });
            return;
          }

          // Blocking request — wait until the lock is available.
          if (!held.has(name)) {
            const cbPromise = callback({});
            held.set(name, { resolve: outerResolve });
            void cbPromise.then(() => {
              release(name);
              outerResolve();
            });
            return;
          }

          // Enqueue a waiter.
          const queue = waiters.get(name) ?? [];
          queue.push(() => {
            const cbPromise = callback({});
            held.set(name, { resolve: outerResolve });
            void cbPromise.then(() => {
              release(name);
              outerResolve();
            });
          });
          waiters.set(name, queue);
        });
      });
    },
  };
  return mgr;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush microtasks so lock callbacks settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tray-leader-lock', () => {
  describe('requestLeaderLock', () => {
    it('first requester is granted immediately', async () => {
      const mgr = createFakeLockManager();
      const result = await requestLeaderLock('https://worker.example.com', mgr);
      expect(result.status).toBe('granted');
    });

    it('second requester is deferred', async () => {
      const mgr = createFakeLockManager();
      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const second = await requestLeaderLock('https://worker.example.com', mgr);
      expect(second.status).toBe('deferred');
    });

    it('releasing the first lock promotes the second requester', async () => {
      const mgr = createFakeLockManager();
      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const second = await requestLeaderLock('https://worker.example.com', mgr);
      expect(second.status).toBe('deferred');

      // Release the first.
      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      // The deferred waiter should now be promoted.
      const promoted = await (second as Extract<LeaderLockResult, { status: 'deferred' }>)
        .waitForPromotion;
      expect(promoted).toBeDefined();
      expect(typeof promoted.release).toBe('function');
    });

    it('different worker URLs do not contend', async () => {
      const mgr = createFakeLockManager();
      const a = await requestLeaderLock('https://a.example.com', mgr);
      const b = await requestLeaderLock('https://b.example.com', mgr);
      expect(a.status).toBe('granted');
      expect(b.status).toBe('granted');
    });

    it('release is idempotent', async () => {
      const mgr = createFakeLockManager();
      const result = await requestLeaderLock('https://worker.example.com', mgr);
      expect(result.status).toBe('granted');
      const { release } = result as Extract<LeaderLockResult, { status: 'granted' }>;
      release();
      release(); // should not throw
    });

    it('stop-and-restart re-acquires the lock', async () => {
      const mgr = createFakeLockManager();

      // First session.
      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');
      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      // Second session on the same URL.
      const second = await requestLeaderLock('https://worker.example.com', mgr);
      expect(second.status).toBe('granted');
    });

    it('leave-and-restart on a new worker releases old and acquires new', async () => {
      const mgr = createFakeLockManager();

      const old = await requestLeaderLock('https://old.example.com', mgr);
      expect(old.status).toBe('granted');
      (old as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      const next = await requestLeaderLock('https://new.example.com', mgr);
      expect(next.status).toBe('granted');
    });

    it('single tab, no contention — always granted', async () => {
      // Regression test: verifies the async ifAvailable path works
      // correctly when no other tab holds the lock.
      const mgr = createFakeLockManager();
      const result = await requestLeaderLock('https://solo.example.com', mgr);
      expect(result.status).toBe('granted');
      expect(typeof (result as Extract<LeaderLockResult, { status: 'granted' }>).release).toBe(
        'function'
      );
    });
  });

  describe('missing API fallback', () => {
    it('grants immediately when lockManager is null', async () => {
      const result = await requestLeaderLock('https://worker.example.com', null);
      expect(result.status).toBe('granted');
    });

    it('release is a no-op when lockManager is null', async () => {
      const result = await requestLeaderLock('https://worker.example.com', null);
      const { release } = result as Extract<LeaderLockResult, { status: 'granted' }>;
      release(); // should not throw
    });
  });
});
