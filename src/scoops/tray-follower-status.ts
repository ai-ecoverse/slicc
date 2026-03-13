/**
 * Follower tray runtime status — mirrors the leader pattern in tray-leader.ts.
 *
 * Module-level variable holds the current follower state, updated by
 * FollowerTrayManager at key milestones. The `host` command reads it
 * to display follower status.
 */

export interface FollowerTrayRuntimeStatus {
  state: 'inactive' | 'connecting' | 'connected' | 'error';
  joinUrl: string | null;
  trayId: string | null;
  error: string | null;
}

let followerTrayRuntimeStatus: FollowerTrayRuntimeStatus = {
  state: 'inactive',
  joinUrl: null,
  trayId: null,
  error: null,
};

export function getFollowerTrayRuntimeStatus(): FollowerTrayRuntimeStatus {
  return { ...followerTrayRuntimeStatus };
}

export function setFollowerTrayRuntimeStatus(status: FollowerTrayRuntimeStatus): void {
  followerTrayRuntimeStatus = { ...status };
}
