import { describe, expect, it } from 'vitest';
import {
  acquireLeaderRole,
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

      // Opt in to promotion, then release the first.
      const promotionPromise = (
        second as Extract<LeaderLockResult, { status: 'deferred' }>
      ).waitForPromotion();
      await tick();
      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();

      const promoted = await promotionPromise;
      expect(promoted).toBeDefined();
      expect(typeof promoted.release).toBe('function');
    });

    it('an unconsumed deferred result leaves no phantom holder', async () => {
      // Regression for the leave/restart path: a deferred result whose
      // waitForPromotion() is never invoked must not queue a blocking
      // request — an eagerly-queued one would acquire the lock
      // unobserved when the holder releases and pin it forever,
      // deadlocking the election for every future tab.
      const mgr = createFakeLockManager();
      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const abandoned = await requestLeaderLock('https://worker.example.com', mgr);
      expect(abandoned.status).toBe('deferred');
      // Deliberately never call abandoned.waitForPromotion().

      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

      // A third requester must be granted — not queued behind a phantom.
      const third = await requestLeaderLock('https://worker.example.com', mgr);
      expect(third.status).toBe('granted');
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

  describe('acquireLeaderRole', () => {
    const URL = 'https://worker.example.com';

    it('leads immediately when the lock is free and intent holds', async () => {
      const mgr = createFakeLockManager();
      const granted: Array<() => void> = [];
      await acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => true,
        onGranted: (release) => granted.push(release),
      });
      expect(granted).toHaveLength(1);
    });

    it('releases without leading when shouldLead is false at initial grant', async () => {
      const mgr = createFakeLockManager();
      const granted: Array<() => void> = [];
      await acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => false,
        onGranted: (release) => granted.push(release),
      });
      expect(granted).toHaveLength(0);
      // The lock was released — a fresh requester is granted.
      const next = await requestLeaderLock(URL, mgr);
      expect(next.status).toBe('granted');
    });

    it('defers behind a holder and leads on late promotion when intent holds', async () => {
      const mgr = createFakeLockManager();
      const holder = await requestLeaderLock(URL, mgr);
      expect(holder.status).toBe('granted');

      const granted: Array<() => void> = [];
      const election = acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => true,
        onGranted: (release) => granted.push(release),
      });
      await tick();
      expect(granted).toHaveLength(0); // still deferred

      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;
      expect(granted).toHaveLength(1);
    });

    it('releases instead of leading when intent lapsed by promotion time', async () => {
      // Covers "user left the tray / became a follower while deferred":
      // the promotion fires but shouldLead now returns false, so the
      // lock must be released untouched — no leader starts.
      const mgr = createFakeLockManager();
      const holder = await requestLeaderLock(URL, mgr);

      let intent = true;
      const granted: Array<() => void> = [];
      const election = acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => intent,
        onGranted: (release) => granted.push(release),
      });
      await tick();

      intent = false; // user leaves the tray while deferred
      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;

      expect(granted).toHaveLength(0);
      // The promoted-then-released lock is free for the next requester.
      const next = await requestLeaderLock(URL, mgr);
      expect(next.status).toBe('granted');
    });

    it('leads immediately when the lock API is unavailable', async () => {
      const granted: Array<() => void> = [];
      await acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: null,
        shouldLead: () => true,
        onGranted: (release) => granted.push(release),
      });
      expect(granted).toHaveLength(1);
    });
  });
});
