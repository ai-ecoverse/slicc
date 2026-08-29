/**
 * Follower tray runtime status — mirrors the leader pattern in
 * `base/tray-leader-status.ts`.
 *
 * Module-level variable holds the current follower state, updated by
 * FollowerTrayManager at key milestones. The `host` command reads it
 * to display follower status.
 *
 * Lives in `base/` (the bottom rung of the layer stack) so `shell/` can read
 * it without importing UP into `scoops/` (#2537) — the same shape as
 * `base/permissions-surface-registry.ts`. The registry MUST stay a single
 * module instance: whichever realm runs the manager sets the global here, and
 * every other layer reads the same one. `scoops/tray-follower-status.ts`
 * re-exports these symbols for existing callers.
 */

import { FOLLOWER_STATUS_STORAGE_KEY } from './tray-role.js';

export interface FollowerTrayRuntimeStatus {
  state: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  joinUrl: string | null;
  trayId: string | null;
  error: string | null;
  /** Timestamp (ms since epoch) of the last successful ping roundtrip, or null if none yet. */
  lastPingTime: number | null;
  /** Number of reconnect attempts since last successful connection. 0 when connected. */
  reconnectAttempts: number;
  /** Number of attach POST attempts during the connecting phase. */
  attachAttempts: number;
  /** Last action code received from the worker (e.g. 'LEADER_NOT_ELECTED', 'LEADER_CONNECTED'). */
  lastAttachCode: string | null;
  /** Timestamp (ms since epoch) when the connecting phase started, or null if not connecting. */
  connectingSince: number | null;
  /** Last error message encountered during attach/bootstrap (more specific than `error`). */
  lastError: string | null;
  /**
   * The leader has stopped answering keepalive pings but its data channel is
   * still open — it is busy, not gone (see `data-channel-keepalive.ts`). The
   * connection is intact and recovers on its own, so this is deliberately NOT
   * a `state` variant: a stalled follower is still `connected`.
   *
   * Optional because it is a transient overlay maintained by
   * {@link setFollowerStalled}, like `lastPingTime` — not part of the status
   * every producer constructs.
   */
  stalled?: boolean;
}

let followerTrayRuntimeStatus: FollowerTrayRuntimeStatus = {
  state: 'inactive',
  joinUrl: null,
  trayId: null,
  error: null,
  lastPingTime: null,
  reconnectAttempts: 0,
  attachAttempts: 0,
  lastAttachCode: null,
  connectingSince: null,
  lastError: null,
};

export function getFollowerTrayRuntimeStatus(): FollowerTrayRuntimeStatus {
  return { ...followerTrayRuntimeStatus };
}

/**
 * Key for the page→worker `localStorage` shim mirroring the follower tray
 * status. Defined in `base/tray-role.ts` and re-exported here under its
 * established name. Symmetric with `LEADER_STATUS_STORAGE_KEY`.
 */
export { FOLLOWER_STATUS_STORAGE_KEY };

/**
 * Follower tray status with a `localStorage` fallback for the standalone
 * kernel-worker thread. The worker never runs the `FollowerSyncManager`
 * (it lives on the page), so the worker's module global is permanently
 * `inactive`. When it is, read the shim value that `wc-tray.ts` keeps
 * current. Extension/offscreen mode keeps the module global as the source
 * of truth because the offscreen runs the manager there (the page mirror
 * pushes a non-inactive global, so the fallback is never consulted).
 *
 * Mirror of `getLeaderStatusWithFallback`. The worker-side `host` command
 * reads this so it reports `status: follower (connected)` while following,
 * instead of falling through to the leader path and printing
 * `status: inactive`.
 */
export function getFollowerStatusWithFallback(): FollowerTrayRuntimeStatus {
  const moduleStatus = getFollowerTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      FOLLOWER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as FollowerTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') return parsed;
    }
  } catch {
    // ignore parse errors
  }
  return moduleStatus;
}

type FollowerTrayRuntimeStatusListener = (status: FollowerTrayRuntimeStatus) => void;
const followerTrayRuntimeStatusListeners = new Set<FollowerTrayRuntimeStatusListener>();

/**
 * Subscribe to follower tray status changes. Mirrors the leader-side
 * subscriber API in tray-leader.ts; used by the extension offscreen
 * runtime to push status into the side-panel context.
 */
export function subscribeToFollowerTrayRuntimeStatus(
  listener: FollowerTrayRuntimeStatusListener
): () => void {
  followerTrayRuntimeStatusListeners.add(listener);
  return () => {
    followerTrayRuntimeStatusListeners.delete(listener);
  };
}

// Each listener receives a fresh shallow copy so a listener that mutates
// its argument can't change what later listeners observe. Iterating a
// copy of the listener set means an unsubscribe / subscribe during
// dispatch doesn't perturb the in-flight delivery either. (Status
// fields are flat scalars, so a shallow copy is a full deep copy here.)
function notifyFollowerListeners(): void {
  if (followerTrayRuntimeStatusListeners.size === 0) return;
  for (const listener of [...followerTrayRuntimeStatusListeners]) {
    try {
      listener({ ...followerTrayRuntimeStatus });
    } catch {
      // Listener errors must not break the manager's state machine.
    }
  }
}

export function setFollowerTrayRuntimeStatus(status: FollowerTrayRuntimeStatus): void {
  followerTrayRuntimeStatus = { ...status };
  notifyFollowerListeners();
}

/** Reset reconnect attempt counter to 0, preserving other fields. */
export function resetReconnectAttempts(): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, reconnectAttempts: 0 };
  notifyFollowerListeners();
}

/** Update the lastPingTime timestamp, preserving other fields. */
export function setFollowerLastPingTime(timestamp: number): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, lastPingTime: timestamp };
  notifyFollowerListeners();
}

/** Flag/clear the transient "leader is busy" state, preserving other fields. */
export function setFollowerStalled(stalled: boolean): void {
  if (followerTrayRuntimeStatus.stalled === stalled) return;
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, stalled };
  notifyFollowerListeners();
}
