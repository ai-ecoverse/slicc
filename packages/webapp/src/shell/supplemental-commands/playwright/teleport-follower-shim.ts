import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from '../host-command.js';
import {
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from './teleport.js';
import type { GetBestFollowerFn } from './types.js';

export interface TeleportFollowerInfo extends ConnectedFollowerInfo {
  bootstrapId?: string;

  lastActivity?: number;

  teleportEligible?: boolean;
}

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

export function wireTeleportSelectionFromShim(): void {
  setPlaywrightTeleportConnectedFollowers(() => () => getConnectedFollowersWithFallback());
  setPlaywrightTeleportBestFollower(
    () => () => selectBestFollowerFromShim(getConnectedFollowersWithFallback())
  );
}
