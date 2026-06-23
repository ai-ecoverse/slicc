import {
  type RuntimeConfigStorage,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';

type RemovableStorage = RuntimeConfigStorage & { removeItem(key: string): void };

export interface FollowerSwitchOutDeps {
  storage: RemovableStorage;
  stopFollower: () => void;
  reload: () => void;
}

/**
 * Switch a no-kernel follower out of follower mode by REWRITING storage and
 * RELOADING (a no-worker follower cannot promote to leader in place — the
 * leader path needs the kernel worker). `workerBaseUrl: null` → stop following
 * (boot plain standalone); a worker URL → become leader on next boot.
 */
export function performFollowerSwitchOut(
  opts: { workerBaseUrl: string | null },
  deps: FollowerSwitchOutDeps
): void {
  deps.stopFollower();
  deps.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
  if (opts.workerBaseUrl === null) {
    deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
  } else {
    deps.storage.setItem(TRAY_WORKER_STORAGE_KEY, opts.workerBaseUrl);
  }
  deps.reload();
}
