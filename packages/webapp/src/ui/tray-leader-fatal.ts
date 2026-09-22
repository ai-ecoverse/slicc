import { createLogger } from '../base/logger.js';

const log = createLogger('tray-leader-lock');

let bootAborted = false;

let heldRelease: (() => void) | null = null;

let fatalCleanup: (() => void) | null = null;

export function bindHeldLeaderLock(release: () => void): () => void {
  const wrapped = (): void => {
    if (heldRelease === wrapped) heldRelease = null;
    release();
  };
  heldRelease = wrapped;
  return wrapped;
}

export function registerTrayLeaderFatalCleanup(cleanup: () => void): void {
  fatalCleanup = cleanup;
}

export function isTrayLeaderBootAborted(): boolean {
  return bootAborted;
}

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

export function resetTrayLeaderFatalForTests(): void {
  bootAborted = false;
  heldRelease = null;
  fatalCleanup = null;
}
