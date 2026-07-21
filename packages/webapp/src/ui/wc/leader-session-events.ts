/**
 * Window-event contract for the leader-side follower-new-session relay between
 * `wc-tray` (the tray `LeaderSyncManager`) and `wc-live` (which owns the
 * freezer + `runNewSession`). The two handlers live in different files and are
 * wired only over the DOM, so a bare string dispatched in one and listened for
 * in the other could silently desync on a typo — no unit test crosses that
 * seam. Sharing the names (and the payload type) makes the contract
 * compile-checked instead.
 *
 * Flow: a follower's freezer new-chat → `LeaderSyncManager.onFollowerNewSession`
 * (`wc-tray`) dispatches {@link LEADER_RUN_NEW_SESSION_EVENT} → `wc-live` runs
 * the same `runNewSession` a local click runs (archive + `clearAllMessages`) →
 * dispatches {@link LEADER_BROADCAST_SNAPSHOT_EVENT} → `wc-tray` broadcasts the
 * cleared snapshot so every connected follower drops the stale chat.
 */

/** Leader relays a follower's freezer new-chat to `wc-live`'s `runNewSession`. */
export const LEADER_RUN_NEW_SESSION_EVENT = 'slicc:leader-run-new-session';
/** `wc-live` asks `wc-tray` to broadcast the cleared snapshot to all followers. */
export const LEADER_BROADCAST_SNAPSHOT_EVENT = 'slicc:leader-broadcast-snapshot';

/** `detail` payload carried by {@link LEADER_RUN_NEW_SESSION_EVENT}. */
export interface LeaderRunNewSessionDetail {
  action: 'save' | 'skip' | 'erase';
}
