/**
 * Follower tray runtime status — mirrors the leader pattern in tray-leader.ts.
 *
 * Module-level variable holds the current follower state, updated by
 * FollowerTrayManager at key milestones. The `host` command reads it
 * to display follower status.
 */

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

function notifyFollowerListeners(): void {
  if (followerTrayRuntimeStatusListeners.size === 0) return;
  const snapshot = { ...followerTrayRuntimeStatus };
  for (const listener of followerTrayRuntimeStatusListeners) {
    try {
      listener(snapshot);
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
