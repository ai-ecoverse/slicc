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
}

let followerTrayRuntimeStatus: FollowerTrayRuntimeStatus = {
  state: 'inactive',
  joinUrl: null,
  trayId: null,
  error: null,
  lastPingTime: null,
  reconnectAttempts: 0,
};

export function getFollowerTrayRuntimeStatus(): FollowerTrayRuntimeStatus {
  return { ...followerTrayRuntimeStatus };
}

export function setFollowerTrayRuntimeStatus(status: FollowerTrayRuntimeStatus): void {
  followerTrayRuntimeStatus = { ...status };
}

/** Reset reconnect attempt counter to 0, preserving other fields. */
export function resetReconnectAttempts(): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, reconnectAttempts: 0 };
}

/** Update the lastPingTime timestamp, preserving other fields. */
export function setFollowerLastPingTime(timestamp: number): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, lastPingTime: timestamp };
}
