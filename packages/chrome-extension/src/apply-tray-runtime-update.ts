/**
 * Pure helper that owns the storage-update + dispatch logic for the
 * offscreen document's two tray-runtime entry points (`refresh-tray-runtime`
 * panel relay and `__slicc_setTrayRuntime` in-offscreen hook). Extracted
 * from `offscreen.ts` so the branching invariants can be unit-tested
 * without standing up the full offscreen runtime.
 */

import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../webapp/src/scoops/tray-runtime-config.js';

export interface TrayRuntimeStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ApplyTrayRuntimeUpdateDeps {
  storage: TrayRuntimeStorage;
  /**
   * Stop whatever leader/follower the offscreen currently runs. Called
   * synchronously when both `joinUrl` and `workerBaseUrl` are `null`.
   * MUST NOT defer to `syncTrayRuntime` here: the resolver's
   * `defaultWorkerBaseUrl` fallback would silently rebuild a leader on
   * the production worker.
   */
  stopTrayRuntime: () => void;
  /**
   * Set the resolver's cached key to the post-stop equivalent of
   * `JSON.stringify(null)` so a subsequent call with the same dormant
   * state early-outs at `nextTrayRuntimeKey === activeTrayRuntimeKey`.
   * Implemented by `offscreen.ts` as a closure over its `activeTrayRuntimeKey`
   * local; passed in here so the function stays pure.
   */
  resetTrayRuntimeKey: () => void;
  /** The async resolver-driven update (start follower or leader as appropriate). */
  syncTrayRuntime: () => Promise<void>;
}

/**
 * Update the offscreen's tray-runtime localStorage and either
 * short-circuit to a full stop (both args `null`) or re-run
 * `syncTrayRuntime`.
 *
 * Per-arg semantics:
 *   - `string` (non-empty) → write the value.
 *   - `joinUrl: null` → clear the join key.
 *   - `workerBaseUrl: null` → clear the worker key ONLY when `joinUrl`
 *     is also `null` (leave-entirely). A worker-clear without a
 *     join-clear is semantically impossible — a follower needs a worker
 *     URL to talk to the leader, so the panel envelope never sends
 *     this combination. The asymmetric predicate enforces the invariant
 *     at the wire boundary.
 *   - `undefined` (either arg) → leave that key untouched. Matches the
 *     wire envelope `joinUrl?: string | null` / `workerBaseUrl?: string | null`.
 */
export async function applyTrayRuntimeUpdate(
  joinUrl: string | null | undefined,
  workerBaseUrl: string | null | undefined,
  deps: ApplyTrayRuntimeUpdateDeps
): Promise<void> {
  if (typeof joinUrl === 'string' && joinUrl) {
    deps.storage.setItem(TRAY_JOIN_STORAGE_KEY, joinUrl);
  } else if (joinUrl === null) {
    deps.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
  }
  if (typeof workerBaseUrl === 'string' && workerBaseUrl) {
    deps.storage.setItem(TRAY_WORKER_STORAGE_KEY, workerBaseUrl);
  } else if (workerBaseUrl === null && joinUrl === null) {
    deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
  }

  if (joinUrl === null && workerBaseUrl === null) {
    deps.stopTrayRuntime();
    deps.resetTrayRuntimeKey();
    return;
  }

  await deps.syncTrayRuntime();
}
