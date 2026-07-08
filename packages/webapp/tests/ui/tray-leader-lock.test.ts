import { describe, expect, it } from 'vitest';
import {
  type LeaderLockResult,
  type LockManagerLike,
  requestLeaderLock,
} from '../../src/ui/tray-leader-lock.js';

// ---------------------------------------------------------------------------
// In-memory LockManager fake
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fake that mirrors the Web Locks API semantics
 * relevant to `requestLeaderLock`: exclusive mode, `ifAvailable`, and
 * FIFO waiting.
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
      if (options.ifAvailable) {
        if (held.has(name)) {
          // Lock unavailable — call with null per spec.
          return callback(null);
        }
        // Grant immediately.
        const cbPromise = callback({});
        // The lock is held until the callback's returned promise
        // resolves.
        held.set(name, {
          resolve: () => {
            /* replaced below */
          },
        });
        void cbPromise.then(() => release(name));
        // Replace the resolve so external code can trigger it.
        return new Promise<void>((resolve) => {
          held.set(name, { resolve });
          void cbPromise.then(resolve);
        });
      }

      // Blocking request — wait until the lock is available.
      if (!held.has(name)) {
        const cbPromise = callback({});
        held.set(name, {
          resolve: () => {
            /* replaced below */
          },
        });
        void cbPromise.then(() => release(name));
        return new Promise<void>((resolve) => {
          held.set(name, { resolve });
          void cbPromise.then(resolve);
        });
      }

      // Enqueue a waiter.
      return new Promise<void>((outerResolve) => {
        const queue = waiters.get(name) ?? [];
        queue.push(() => {
          const cbPromise = callback({});
          held.set(name, {
            resolve: () => {
              /* replaced below */
            },
          });
          void cbPromise.then(() => release(name));
          void cbPromise.then(outerResolve);
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          held.set(name, { resolve: outerResolve });
        });
        waiters.set(name, queue);
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
    it('first requester is granted immediately', () => {
      const mgr = createFakeLockManager();
      const result = requestLeaderLock('https://worker.example.com', mgr);
      expect(result.status).toBe('granted');
    });

    it('second requester is deferred', () => {
      const mgr = createFakeLockManager();
      const first = requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const second = requestLeaderLock('https://worker.example.com', mgr);
      expect(second.status).toBe('deferred');
    });

    it('releasing the first lock promotes the second requester', async () => {
      const mgr = createFakeLockManager();
      const first = requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const second = requestLeaderLock('https://worker.example.com', mgr);
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

    it('different worker URLs do not contend', () => {
      const mgr = createFakeLockManager();
      const a = requestLeaderLock('https://a.example.com', mgr);
      const b = requestLeaderLock('https://b.example.com', mgr);
      expect(a.status).toBe('granted');
      expect(b.status).toBe('granted');
    });

    it('release is idempotent', () => {
      const mgr = createFakeLockManager();
      const result = requestLeaderLock('https://worker.example.com', mgr);
      expect(result.status).toBe('granted');
      const { release } = result as Extract<LeaderLockResult, { status: 'granted' }>;
      release();
      release(); // should not throw
    });

    it('stop-and-restart re-acquires the lock', async () => {
      const mgr = createFakeLockManager();

      // First session.
      const first = requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');
      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      // Second session on the same URL.
      const second = requestLeaderLock('https://worker.example.com', mgr);
      expect(second.status).toBe('granted');
    });

    it('leave-and-restart on a new worker releases old and acquires new', async () => {
      const mgr = createFakeLockManager();

      const old = requestLeaderLock('https://old.example.com', mgr);
      expect(old.status).toBe('granted');
      (old as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      const next = requestLeaderLock('https://new.example.com', mgr);
      expect(next.status).toBe('granted');
    });
  });

  describe('missing API fallback', () => {
    it('grants immediately when lockManager is null', () => {
      const result = requestLeaderLock('https://worker.example.com', null);
      expect(result.status).toBe('granted');
    });

    it('release is a no-op when lockManager is null', () => {
      const result = requestLeaderLock('https://worker.example.com', null);
      const { release } = result as Extract<LeaderLockResult, { status: 'granted' }>;
      release(); // should not throw
    });
  });
});
