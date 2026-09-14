import type { FollowerHudRow } from '@slicc/webcomponents';
import type { ConnectedFollowerInfo } from '../shell/supplemental-commands/host-command.js';

export const FOLLOWERS_CHANGED_EVENT = 'slicc:followers-changed';

export function shortFollowerId(runtimeId: string): string {
  const unprefixed = runtimeId.replace(/^follower-/, '');
  return unprefixed.length > 12 ? `${unprefixed.slice(0, 8)}…` : unprefixed;
}

export function followerTypeLabel(follower: ConnectedFollowerInfo): string {
  if (follower.floatType === 'ios') return 'iOS';
  if (follower.floatType === 'electron') return 'Electron';
  if (follower.floatType === 'extension') return 'Extension';
  if (follower.floatType === 'standalone') return 'Standalone';
  return follower.runtime?.includes('cli') ? 'CLI' : 'Follower';
}

export function followerIcon(follower: ConnectedFollowerInfo): string {
  if (follower.floatType === 'ios') return 'smartphone';
  if (follower.floatType === 'electron' || follower.floatType === 'standalone') return 'monitor';
  if (follower.floatType === 'extension') return 'blocks';
  return follower.runtime?.includes('cli') ? 'terminal' : 'radio';
}

export function elapsedSince(connectedAt?: string, now: number = Date.now()): string | null {
  if (!connectedAt) return null;
  const timestamp = new Date(connectedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function followerStatus(follower: ConnectedFollowerInfo): 'active' | 'warn' | 'idle' {
  if (follower.health === 'stalled') return 'warn';
  if (follower.peerState === 'connecting') return 'idle';
  if (follower.peerState === 'connected' && follower.health === 'live') return 'active';
  return 'idle';
}

export function followerMeta(follower: ConnectedFollowerInfo, now: number = Date.now()): string {
  const state =
    follower.health === 'stalled'
      ? 'stalled'
      : follower.peerState === 'connecting'
        ? 'connecting'
        : 'connected';
  const age = elapsedSince(follower.connectedAt, now);
  return age ? `${state} ${age}` : state;
}

export function followerCapabilities(follower: ConnectedFollowerInfo): string[] {
  const chips: string[] = [];
  if (follower.exec) chips.push('can run commands');
  if (follower.cdp) chips.push('hosts tabs');
  return chips;
}

export function followerTitle(follower: ConnectedFollowerInfo): string {
  return `${followerTypeLabel(follower)} · ${shortFollowerId(follower.runtimeId)}`;
}

export function followerDetail(follower: ConnectedFollowerInfo): string | undefined {
  return follower.motd ?? follower.runtime ?? undefined;
}

export function toFollowerHudRows(
  followers: ConnectedFollowerInfo[],
  now: number = Date.now()
): FollowerHudRow[] {
  return followers.map((follower) => ({
    id: follower.runtimeId,
    icon: followerIcon(follower),
    title: followerTitle(follower),
    detail: followerDetail(follower),
    state: followerStatus(follower),
    stateText: followerMeta(follower, now),
    chips: followerCapabilities(follower),
  }));
}
