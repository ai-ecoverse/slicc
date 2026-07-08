/**
 * Same-origin leader election via the Web Locks API.
 *
 * Prevents two same-origin tabs from both running
 * `startPageLeaderTray` concurrently.  One exclusive lock per worker
 * base URL ensures at most one tab leads at a time; a second tab
 * defers until the first tab closes or releases the lock.
 *
 * When `navigator.locks` is unavailable (Node tests, some embedded
 * webviews), every caller is granted the lock immediately — preserving
 * the pre-election behavior.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('tray-leader-lock');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of requesting a leader lock. */
export type LeaderLockResult =
  | { status: 'granted'; release: () => void }
  | {
      status: 'deferred';
      /**
       * LAZY: no promotion request is queued until this is called.
       * Callers that do not want late promotion (e.g. the leave/restart
       * path) simply never call it — an eagerly-queued request would
       * otherwise acquire the lock unobserved when the current holder
       * releases and hold it forever (a phantom holder that deadlocks
       * the election origin-wide).
       */
      waitForPromotion: () => Promise<{ release: () => void }>;
    };

/**
 * Minimal subset of the Web Locks API consumed by this module.
 * Injectable so tests can supply an in-memory fake without real
 * browser locks.
 */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>
  ): Promise<void>;
  request(
    name: string,
    options: { mode: 'exclusive' },
    callback: (lock: unknown) => Promise<void>
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Lock key
// ---------------------------------------------------------------------------

function lockKey(workerBaseUrl: string): string {
  return `slicc-tray-leader:${workerBaseUrl}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a release function + a held promise pair.  The returned
 * promise stays pending until `release()` is called, which is how
 * `navigator.locks.request` keeps the lock held.
 */
function createHeldLock(): { release: () => void; heldPromise: Promise<void> } {
  let released = false;
  let resolveHeld: (() => void) | null = null;
  const heldPromise = new Promise<void>((r) => {
    resolveHeld = r;
  });
  const release = (): void => {
    if (released) return;
    released = true;
    resolveHeld?.();
  };
  return { release, heldPromise };
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Request exclusive leader ownership for `workerBaseUrl`.
 *
 * Returns a promise that resolves with:
 * - `'granted'` + `release()` — caller should start the leader and
 *   call `release()` when done (stop, leave, tab close).
 * - `'deferred'` + `waitForPromotion` — another tab already holds
 *   the lock.  `waitForPromotion` resolves when the other tab
 *   releases (late promotion).
 *
 * When `lockManager` is `null` (API missing) the caller is always
 * granted immediately — no election takes place.
 */
export async function requestLeaderLock(
  workerBaseUrl: string,
  lockManager: LockManagerLike | null
): Promise<LeaderLockResult> {
  if (!lockManager) {
    // Feature-detection fallback: start immediately.
    return { status: 'granted', release: () => {} };
  }

  const key = lockKey(workerBaseUrl);

  // Try to acquire with ifAvailable: true.  The callback is always
  // invoked asynchronously per the Web Locks spec — we await a
  // one-shot signal to learn the outcome.
  let grantedResolve!: (acquired: boolean) => void;
  const grantedPromise = new Promise<boolean>((r) => {
    grantedResolve = r;
  });

  const held = createHeldLock();

  // Fire-and-forget: the request callback keeps the lock held via
  // `held.heldPromise`.
  void lockManager.request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (lock === null) {
      // Lock unavailable — another tab holds it.
      grantedResolve(false);
      return Promise.resolve();
    }
    // Lock acquired — hold it until release() is called.
    grantedResolve(true);
    return held.heldPromise;
  });

  const acquired = await grantedPromise;

  if (acquired) {
    return { status: 'granted', release: held.release };
  }

  // Another tab is leading. Promotion is opt-in and lazy — the
  // blocking request is queued only when the caller invokes
  // `waitForPromotion()`.
  const waitForPromotion = (): Promise<{ release: () => void }> =>
    new Promise<{ release: () => void }>((resolve) => {
      const promotedHeld = createHeldLock();
      void lockManager.request(key, { mode: 'exclusive' }, () => {
        resolve({ release: promotedHeld.release });
        return promotedHeld.heldPromise;
      });
    });

  return { status: 'deferred', waitForPromotion };
}

/**
 * High-level election flow: acquire the lock for `workerBaseUrl` and
 * lead — or defer and lead later when the current holder releases.
 *
 * `shouldLead` is re-checked at every grant (initial and late
 * promotion): when it returns `false` the lock is released untouched
 * instead of starting a leader. This is the intent guard — by the time
 * a deferred tab is promoted, the user may have joined as a follower,
 * left the tray entirely (storage cleared), or switched worker URLs.
 *
 * `onGranted(release)` runs only while the lock is held and
 * `shouldLead()` passed; the caller starts the leader and keeps
 * `release` for its stop/leave paths.
 */
export async function acquireLeaderRole(opts: {
  workerBaseUrl: string;
  lockManager: LockManagerLike | null;
  shouldLead: () => boolean;
  onGranted: (release: () => void) => void;
}): Promise<void> {
  const result = await requestLeaderLock(opts.workerBaseUrl, opts.lockManager);

  if (result.status === 'granted') {
    if (!opts.shouldLead()) {
      result.release();
      return;
    }
    opts.onGranted(result.release);
    return;
  }

  // Deferred — another tab is leading. Prod log gate is ERROR, so this
  // must be `error` to be operator-visible.
  log.error(
    'Another tab is already leading on this tray worker — ' +
      'deferring leader start until the other tab releases the lock.'
  );

  const { release } = await result.waitForPromotion();
  if (!opts.shouldLead()) {
    release();
    return;
  }
  log.error('Late promotion: this tab is now the tray leader.');
  opts.onGranted(release);
}

/**
 * Return a `LockManagerLike` for the current environment, or `null`
 * when the Web Locks API is unavailable.
 */
export function getDefaultLockManager(): LockManagerLike | null {
  if (
    typeof navigator !== 'undefined' &&
    navigator.locks &&
    typeof navigator.locks.request === 'function'
  ) {
    return navigator.locks as unknown as LockManagerLike;
  }
  return null;
}
