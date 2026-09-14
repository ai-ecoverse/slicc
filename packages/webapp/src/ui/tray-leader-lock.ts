import { createLogger } from '../base/logger.js';

const log = createLogger('tray-leader-lock');

export type LeaderLockResult =
  | { status: 'granted'; release: () => void }
  | {
      status: 'deferred';

      waitForPromotion: () => Promise<{ release: () => void }>;
    };

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

function lockKey(workerBaseUrl: string): string {
  return `slicc-tray-leader:${workerBaseUrl}`;
}

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

export async function requestLeaderLock(
  workerBaseUrl: string,
  lockManager: LockManagerLike | null
): Promise<LeaderLockResult> {
  if (!lockManager) {
    return { status: 'granted', release: () => {} };
  }

  const key = lockKey(workerBaseUrl);

  let grantedResolve!: (acquired: boolean) => void;
  const grantedPromise = new Promise<boolean>((r) => {
    grantedResolve = r;
  });

  const held = createHeldLock();

  void lockManager.request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (lock === null) {
      grantedResolve(false);
      return Promise.resolve();
    }

    grantedResolve(true);
    return held.heldPromise;
  });

  const acquired = await grantedPromise;

  if (acquired) {
    return { status: 'granted', release: held.release };
  }

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
