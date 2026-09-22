/**
 * Fatal-boot latch for the tray leader lock.
 *
 * Lives apart from `tray-leader-lock.ts` so the page entry can release the
 * lock without pulling the election implementation into the eager graph.
 * The lock module and `wc-tray` share this state.
 */

import { createLogger } from '../base/logger.js';

const log = createLogger('tray-leader-lock');

/**
 * Set when boot reaches the Failed-to-start path. A grant that arrives
 * after that — including a late promotion already queued — must drop the
 * lock instead of starting another leader on a dead tab.
 */
let bootAborted = false;

/** Release for the lock this document currently holds, if any. */
let heldRelease: (() => void) | null = null;

/**
 * Page-tray teardown registered by `wireWcTray`: stop the leader tray and
 * drop `state.lockRelease`. Fatal boot cannot see that closure directly.
 */
let fatalCleanup: (() => void) | null = null;

/**
 * Remember `release` as the lock this tab holds. The returned function is
 * what callers store; calling it clears the module slot so a later fatal
 * path does not release twice.
 */
export function bindHeldLeaderLock(release: () => void): () => void {
  const wrapped = (): void => {
    if (heldRelease === wrapped) heldRelease = null;
    release();
  };
  heldRelease = wrapped;
  return wrapped;
}

/** Register the tray teardown fatal boot runs. Replaces any previous registration. */
export function registerTrayLeaderFatalCleanup(cleanup: () => void): void {
  fatalCleanup = cleanup;
}

export function isTrayLeaderBootAborted(): boolean {
  return bootAborted;
}

/**
 * Failed-to-start path. Stops the leader tray (when wired) and releases the
 * Web Lock so a healthy tab's pending `navigator.locks` request can proceed.
 * Safe to call when this tab never acquired the lock.
 */
export function releaseTrayLeaderOnFatalBoot(): void {
  bootAborted = true;
  const cleanup = fatalCleanup;
  fatalCleanup = null;
  try {
    cleanup?.();
  } catch (err) {
    log.error('Fatal-boot leader teardown threw', err);
  }
  const release = heldRelease;
  heldRelease = null;
  release?.();
}

/** Test-only. Production boot never clears the abort flag. */
export function resetTrayLeaderFatalForTests(): void {
  bootAborted = false;
  heldRelease = null;
  fatalCleanup = null;
}
