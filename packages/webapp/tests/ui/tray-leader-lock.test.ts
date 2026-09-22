import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLeaderRole,
  type LeaderLockResult,
  type LockManagerLike,
  registerTrayLeaderFatalCleanup,
  releaseTrayLeaderOnFatalBoot,
  requestLeaderLock,
  resetTrayLeaderFatalForTests,
} from '../../src/ui/tray-leader-lock.js';

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
        queueMicrotask(() => {
          if (options.ifAvailable) {
            if (held.has(name)) {
              void callback(null).then(outerResolve);
              return;
            }

            const cbPromise = callback({});
            held.set(name, { resolve: outerResolve });
            void cbPromise.then(() => {
              release(name);
              outerResolve();
            });
            return;
          }

          if (!held.has(name)) {
            const cbPromise = callback({});
            held.set(name, { resolve: outerResolve });
            void cbPromise.then(() => {
              release(name);
              outerResolve();
            });
            return;
          }

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

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('tray-leader-lock', () => {
  afterEach(() => {
    resetTrayLeaderFatalForTests();
  });
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
      const mgr = createFakeLockManager();
      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');

      const abandoned = await requestLeaderLock('https://worker.example.com', mgr);
      expect(abandoned.status).toBe('deferred');

      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

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
      release();
    });

    it('stop-and-restart re-acquires the lock', async () => {
      const mgr = createFakeLockManager();

      const first = await requestLeaderLock('https://worker.example.com', mgr);
      expect(first.status).toBe('granted');
      (first as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await tick();

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
      release();
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
      expect(granted).toHaveLength(0);

      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;
      expect(granted).toHaveLength(1);
    });

    it('releases instead of leading when intent lapsed by promotion time', async () => {
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

      intent = false;
      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;

      expect(granted).toHaveLength(0);

      const next = await requestLeaderLock(URL, mgr);
      expect(next.status).toBe('granted');
    });

    it('releases a held lock on fatal boot so the next tab can lead', async () => {
      const mgr = createFakeLockManager();
      const granted: Array<() => void> = [];
      const stopped = vi.fn();
      registerTrayLeaderFatalCleanup(stopped);
      await acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => true,
        onGranted: (release) => granted.push(release),
      });
      expect(granted).toHaveLength(1);

      releaseTrayLeaderOnFatalBoot();

      expect(stopped).toHaveBeenCalledTimes(1);
      const next = await requestLeaderLock(URL, mgr);
      expect(next.status).toBe('granted');
    });

    it('drops a late promotion that arrives after fatal boot', async () => {
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
      expect(granted).toHaveLength(0);

      releaseTrayLeaderOnFatalBoot();
      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;

      expect(granted).toHaveLength(0);
      const next = await requestLeaderLock(URL, mgr);
      expect(next.status).toBe('granted');
    });

    it('pauses only while deferred, then ends the wait on promotion', async () => {
      const mgr = createFakeLockManager();
      const holder = await requestLeaderLock(URL, mgr);
      const onDeferred = vi.fn();
      const onDeferredEnd = vi.fn();
      const election = acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => true,
        onDeferred,
        onDeferredEnd,
        onGranted: () => {},
      });
      await tick();
      expect(onDeferred).toHaveBeenCalledTimes(1);
      expect(onDeferredEnd).not.toHaveBeenCalled();
      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;
      expect(onDeferredEnd).toHaveBeenCalledTimes(1);
    });

    it('ends the wait even when promotion is declined', async () => {
      const mgr = createFakeLockManager();
      const holder = await requestLeaderLock(URL, mgr);
      const onDeferredEnd = vi.fn();
      const election = acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: mgr,
        shouldLead: () => false,
        onDeferredEnd,
        onGranted: () => {},
      });
      await tick();
      (holder as Extract<LeaderLockResult, { status: 'granted' }>).release();
      await election;
      expect(onDeferredEnd).toHaveBeenCalledTimes(1);
    });

    it('does not report deferral when the lock is free', async () => {
      const onDeferred = vi.fn();
      await acquireLeaderRole({
        workerBaseUrl: URL,
        lockManager: createFakeLockManager(),
        shouldLead: () => true,
        onDeferred,
        onGranted: () => {},
      });
      expect(onDeferred).not.toHaveBeenCalled();
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
