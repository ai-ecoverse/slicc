import { createLogger } from '../base/logger.js';
import {
  type RuntimeConfigStorage,
  stripFollowerMarkerFromHref,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';

const log = createLogger('follower-switch-out');

type RemovableStorage = RuntimeConfigStorage & { removeItem(key: string): void };

export interface FollowerSwitchOutDeps {
  storage: RemovableStorage;
  stopFollower: () => void;

  getHref: () => string;

  replaceHref: (url: string) => void;
  reload: () => void;
}

export function performFollowerSwitchOut(
  opts: { workerBaseUrl: string | null },
  deps: FollowerSwitchOutDeps
): void {
  deps.stopFollower();

  try {
    deps.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
    if (opts.workerBaseUrl === null) {
      deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
    } else {
      deps.storage.setItem(TRAY_WORKER_STORAGE_KEY, opts.workerBaseUrl);
    }
  } catch (err) {
    log.error('follower switch-out: storage write failed — state may revert on reload', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const href = deps.getHref();
    const stripped = stripFollowerMarkerFromHref(href);
    if (stripped !== href) {
      deps.replaceHref(stripped);
    }
  } catch (err) {
    log.error('follower switch-out: URL normalize failed — may re-enter follower on reload', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  deps.reload();
}
