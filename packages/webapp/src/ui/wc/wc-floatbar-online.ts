/**
 * `wc-floatbar-online.ts` — the single producer for `slicc-floatbar`'s
 * `online` attribute (#1707: the component API existed, storybook exercised
 * it, and nothing in the app ever drove it — the dot never lit and the pill
 * tooltip always read "offline").
 *
 * Semantics: the dot means "this float has a live tray link" — it is lit
 * while this page is LEADING a tray (reachable by followers) or FOLLOWING
 * one (connected to a leader). A purely local float with no tray shows no
 * dot, which is truthful: nothing is linked to it.
 *
 * A leader stall (`stalled` overlay) deliberately keeps the dot lit: the
 * data channel is open and recovers on its own — a stalled follower is
 * still `connected` (see `tray-follower-status.ts`).
 *
 * Every mount installs the same helper: the no-kernel follower
 * (`wc-follower.ts`) and the kernel float (`wc-tray.ts`, which handles both
 * roles). In each float the inactive role's status simply stays `inactive`,
 * so one OR across both statuses is correct everywhere.
 */

import {
  type FollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import {
  getLeaderTrayRuntimeStatus,
  type LeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';

/**
 * Drive `floatbar`'s `online` attribute from the tray runtime statuses.
 * Seeds the current state immediately and updates on every transition.
 * Returns an uninstall function that stops both subscriptions.
 */
export function installFloatbarOnline(floatbar: HTMLElement): () => void {
  let leaderOnline = isLeaderOnline(getLeaderTrayRuntimeStatus());
  let followerOnline = isFollowerOnline(getFollowerTrayRuntimeStatus());
  const apply = (): void => {
    floatbar.toggleAttribute('online', leaderOnline || followerOnline);
  };
  const unsubscribeLeader = subscribeToLeaderTrayRuntimeStatus((status) => {
    leaderOnline = isLeaderOnline(status);
    apply();
  });
  const unsubscribeFollower = subscribeToFollowerTrayRuntimeStatus((status) => {
    followerOnline = isFollowerOnline(status);
    apply();
  });
  apply();
  return () => {
    unsubscribeLeader();
    unsubscribeFollower();
  };
}

function isLeaderOnline(status: LeaderTrayRuntimeStatus): boolean {
  return status.state === 'leader';
}

function isFollowerOnline(status: FollowerTrayRuntimeStatus): boolean {
  return status.state === 'connected';
}
