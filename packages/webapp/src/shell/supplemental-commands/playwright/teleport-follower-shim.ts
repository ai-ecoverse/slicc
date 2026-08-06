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

/** Mirror of `TeleportPool.getBestFollowerForTeleport()` over the shim roster. */
export function selectBestFollowerFromShim(
  followers: ConnectedFollowerInfo[]
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
    floatType: best.floatType as NonNullable<ConnectedFollowerInfo['floatType']>,
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
