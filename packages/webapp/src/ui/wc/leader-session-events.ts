export const LEADER_RUN_NEW_SESSION_EVENT = 'slicc:leader-run-new-session';

export const LEADER_BROADCAST_SNAPSHOT_EVENT = 'slicc:leader-broadcast-snapshot';

export interface LeaderRunNewSessionDetail {
  action: 'save' | 'skip' | 'erase';
}
