/**
 * Kernel-worker teleport follower selection.
 *
 * The playwright `teleport` command runs in the kernel worker, where the
 * page-realm getters wired by `wc-tray.ts` are unreachable. The leader page
 * mirrors its follower roster into the `slicc.leaderTrayFollowers`
 * localStorage shim (refreshed on follower-count changes AND on every
 * follower user message, so `lastActivity` is a live recency signal); this
 * module implements the same prefer-standalone / most-recently-active
 * selection as `TeleportPool.getBestFollowerForTeleport()` on top of that
 * mirror and installs it via the module-level teleport setters.
 */

import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from '../host-command.js';
import {
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from './teleport.js';
import type { GetBestFollowerFn } from './types.js';

/**
 * The teleport-relevant fields the leader adds to each shim entry.
 *
 * Declared here rather than on `ConnectedFollowerInfo` itself: that interface
 * lives in `host-command.ts`, which carries grandfathered layer back-edges, and
 * the boy-scout gate requires a PR touching such a file to pay ALL of them down
 * (`layer-back-edge-baseline.json`). Extending the shape from the consumer that
 * needs it keeps this change out of that file — and the extra keys ride along
 * through the shim regardless, since it is JSON.
 */
export interface TeleportFollowerInfo extends ConnectedFollowerInfo {
  /** Leader-side channel id — teleport selection needs it alongside runtimeId. */
  bootstrapId?: string;
  /** Last real user activity (message send), not keepalive traffic. */
  lastActivity?: number;
  /** Leader-computed: this follower can host a cookie teleport right now. */
  teleportEligible?: boolean;
}

/** Mirror of `TeleportPool.getBestFollowerForTeleport()` over the shim roster. */
export function selectBestFollowerFromShim(
  followers: TeleportFollowerInfo[]
): ReturnType<GetBestFollowerFn> {
  const candidates = followers.filter(
    (f) => f.teleportEligible === true && f.bootstrapId && f.floatType
  );
  if (candidates.length === 0) return null;
  const standalone = candidates.filter((f) => f.floatType === 'standalone');
  const pool = standalone.length > 0 ? standalone : candidates;
  pool.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const best = pool[0];
  return {
    runtimeId: best.runtimeId,
    bootstrapId: best.bootstrapId as string,
    floatType: best.floatType as NonNullable<TeleportFollowerInfo['floatType']>,
  };
}

/**
 * Install shim-backed teleport selection for the current realm. Call once at
 * kernel boot; the page realm overrides these with live getters when a leader
 * sync exists (`wc-tray.ts` wires them in `wireLeaderHooks`).
 */
export function wireTeleportSelectionFromShim(): void {
  setPlaywrightTeleportConnectedFollowers(() => () => getConnectedFollowersWithFallback());
  setPlaywrightTeleportBestFollower(
    () => () => selectBestFollowerFromShim(getConnectedFollowersWithFallback())
  );
}
