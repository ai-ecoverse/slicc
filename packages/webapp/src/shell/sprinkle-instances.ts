/**
 * Follower-reported sprinkle instances, mirrored into the kernel worker.
 *
 * `sprinkle list` runs in the kernel-worker shell, which has no live handle
 * on the leader's follower registry. Same problem `host` has, so the same
 * solution: the page writes the current per-runtime instance list into
 * `localStorage`, `installPageStorageSync` forwards it to the worker's
 * Map-backed shim, and the shell reads it back here.
 *
 * The list is *reported*, not inferred: each follower sends a
 * `sprinkle.instances` message naming the sprinkles it actually rendered
 * (`ui/sprinkle-follower-controller.ts`), so a follower whose render failed
 * does not show up as an instance. The leader's own open sprinkles are added
 * by the command itself from `mgr.opened()`.
 */

import type { SprinkleInstance } from './sprinkle-manager-handle.js';

/** Runtime id used for the leader's own rendered sprinkles. */
export const LEADER_RUNTIME_ID = 'leader';

// Written page-side by the leader tray's sprinkle-instances subscription and
// propagated to the kernel worker's shim by `installPageStorageSync`.
const SPRINKLE_INSTANCES_STORAGE_KEY = 'slicc.leaderSprinkleInstances';

/** Page-thread getter, set by the leader tray boot path when available. */
let instancesGetter: (() => SprinkleInstance[]) | null = null;

/**
 * Publish a live getter for the follower-reported instances. The page thread
 * has the registry in memory and can skip the shim round-trip.
 */
export function setFollowerSprinkleInstancesGetter(
  getter: (() => SprinkleInstance[]) | null
): void {
  instancesGetter = getter;
}

/**
 * Follower-reported instances, live getter first and the `localStorage` shim
 * second — the kernel worker only ever has the shim.
 */
export function getFollowerSprinkleInstances(): SprinkleInstance[] {
  if (instancesGetter) {
    try {
      return instancesGetter();
    } catch {
      // fall through to the shim — a throwing getter must not blank the list
    }
  }
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      SPRINKLE_INSTANCES_STORAGE_KEY
    );
    if (stored) return JSON.parse(stored) as SprinkleInstance[];
  } catch {
    // ignore parse errors — an unreadable mirror reports no follower instances
  }
  return [];
}

/**
 * Mirror the leader's follower-reported instance list into the shim so the
 * worker-side `sprinkle list` sees it. Best-effort, like the `host` mirror:
 * a missing `localStorage` or a quota error is swallowed.
 */
export function writeSprinkleInstancesToShim(
  instances: SprinkleInstance[],
  storage: Pick<Storage, 'setItem'> | undefined = (globalThis as { localStorage?: Storage })
    .localStorage
): void {
  try {
    storage?.setItem(SPRINKLE_INSTANCES_STORAGE_KEY, JSON.stringify(instances));
  } catch {
    // best-effort mirror — ignore quota / serialization failures
  }
}
