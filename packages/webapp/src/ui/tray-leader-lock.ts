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
  | { status: 'deferred'; waitForPromotion: Promise<{ release: () => void }> };

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
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Request exclusive leader ownership for `workerBaseUrl`.
 *
 * - If the lock is available the caller is immediately `'granted'` and
 *   must call `release()` when done (stop, leave, tab close).
 * - If another tab already holds the lock the caller gets `'deferred'`
 *   with a `waitForPromotion` promise that resolves when the other tab
 *   releases the lock (late promotion).
 * - When `lockManager` is `null` (API missing) the caller is always
 *   granted immediately — no election takes place.
 */
export function requestLeaderLock(
  workerBaseUrl: string,
  lockManager: LockManagerLike | null
): LeaderLockResult {
  if (!lockManager) {
    // Feature-detection fallback: start immediately.
    return { status: 'granted', release: () => {} };
  }

  const key = lockKey(workerBaseUrl);

  // Shared mutable state between the two request callbacks below.
  // `resolveHeld` controls how long the lock is held (resolving it
  // releases the lock).  `released` prevents double-release.
  let resolveHeld: (() => void) | null = null;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    resolveHeld?.();
  };

  // 1. Optimistic try — ifAvailable: true.
  let immediatelyAvailable: boolean | null = null;

  // We need to know synchronously-ish whether the lock was granted.
  // `navigator.locks.request` with `ifAvailable` resolves the outer
  // promise as soon as the callback returns; if the lock was
  // unavailable the callback receives `null`.
  const tryPromise = lockManager.request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (lock === null) {
      immediatelyAvailable = false;
      return Promise.resolve();
    }
    immediatelyAvailable = true;
    return new Promise<void>((resolve) => {
      resolveHeld = resolve;
    });
  });

  // `ifAvailable` resolves synchronously in spec-compliant browsers
  // when the lock is granted, so `immediatelyAvailable` is set by now
  // on the happy path.  But we also handle the (theoretical) case
  // where the microtask hasn't run yet by treating it as deferred.
  if (immediatelyAvailable === true) {
    return { status: 'granted', release };
  }

  // 2. Lock is held by another tab — or we couldn't tell yet.
  log.error(
    'Another tab is already leading on this tray worker — ' +
      'deferring leader start until the other tab releases the lock.'
  );

  // Queue a blocking request that resolves when the lock becomes
  // available (the other tab closed, crashed, or released).
  const waitForPromotion = new Promise<{ release: () => void }>((resolve) => {
    // Reset mutable state for the promoted lock session.
    released = false;
    resolveHeld = null;

    // The non-ifAvailable request blocks until the lock is available.
    void lockManager.request(key, { mode: 'exclusive' }, () => {
      log.error('Late promotion: this tab is now the tray leader.');
      const promotedRelease = (): void => {
        if (released) return;
        released = true;
        resolveHeld?.();
      };
      resolve({ release: promotedRelease });
      return new Promise<void>((r) => {
        resolveHeld = r;
      });
    });
  });

  // Suppress unhandled-rejection for the fire-and-forget tryPromise.
  tryPromise.catch(() => {});

  return { status: 'deferred', waitForPromotion };
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
