/**
 * Shared presentation vocabulary for connected tray followers — the single
 * place that decides what a follower is CALLED, which icon it gets, and how
 * its connection state reads.
 *
 * Three surfaces render the same roster and must agree: the Monitor panel's
 * Followers section (`wc/wc-monitor.ts`, where these helpers originally
 * lived), the floatbar's hover HUD, and the sync dialog's Status tab. The
 * `ssh --list` / `host` text output is the fourth, deliberately-terser view.
 *
 * Pure and DOM-free so the copy is unit-testable; `elapsedSince` takes an
 * explicit `now` so tests don't race the clock.
 */

import type { FollowerHudRow } from '@slicc/webcomponents';
import type { ConnectedFollowerInfo } from '../shell/supplemental-commands/host-command.js';

/**
 * Window event the leader float dispatches whenever its follower roster
 * changes (`wc/wc-tray.ts` is the only producer). The floatbar reads the
 * roster directly; the sync dialog listens so its Status tab appears — and
 * its rows go live — while it is open.
 */
export const FOLLOWERS_CHANGED_EVENT = 'slicc:followers-changed';

/** `follower-a1b2c3d4e5f6` → `a1b2c3d4…`; short enough for a pill, long enough to tell two apart. */
export function shortFollowerId(runtimeId: string): string {
  const unprefixed = runtimeId.replace(/^follower-/, '');
  return unprefixed.length > 12 ? `${unprefixed.slice(0, 8)}…` : unprefixed;
}

/**
 * Human name for the follower kind. `deriveFloatType` only knows the four
 * browser-ish runtimes, so a `slicc-cli` follower arrives as `unknown` and is
 * recognised from its runtime tag instead.
 */
export function followerTypeLabel(follower: ConnectedFollowerInfo): string {
  if (follower.floatType === 'ios') return 'iOS';
  if (follower.floatType === 'electron') return 'Electron';
  if (follower.floatType === 'extension') return 'Extension';
  if (follower.floatType === 'standalone') return 'Standalone';
  return follower.runtime?.includes('cli') ? 'CLI' : 'Follower';
}

/** Lucide icon name for the follower kind. */
export function followerIcon(follower: ConnectedFollowerInfo): string {
  if (follower.floatType === 'ios') return 'smartphone';
  if (follower.floatType === 'electron' || follower.floatType === 'standalone') return 'monitor';
  if (follower.floatType === 'extension') return 'blocks';
  return follower.runtime?.includes('cli') ? 'terminal' : 'radio';
}

/** `4m` / `2h` / `3d` since `connectedAt`, or `null` when it wasn't reported. */
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

/** Dot color bucket: live, stalled, or still handshaking. */
export function followerStatus(follower: ConnectedFollowerInfo): 'active' | 'warn' | 'idle' {
  if (follower.health === 'stalled') return 'warn';
  if (follower.peerState === 'connecting') return 'idle';
  if (follower.peerState === 'connected' && follower.health === 'live') return 'active';
  return 'idle';
}

/** `connected 4m` / `stalled 12m` / `connecting`. */
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

/**
 * What this follower is allowed to do, in the user's words rather than the
 * tool's. `exec` is the one that matters for consent — a `slicc … follow
 * bash -c` follower is remote code execution by design — so it leads.
 */
export function followerCapabilities(follower: ConnectedFollowerInfo): string[] {
  const chips: string[] = [];
  if (follower.exec) chips.push('can run commands');
  if (follower.cdp) chips.push('hosts tabs');
  return chips;
}

/** Full display name: `iOS · phone-a1b2c3`. */
export function followerTitle(follower: ConnectedFollowerInfo): string {
  return `${followerTypeLabel(follower)} · ${shortFollowerId(follower.runtimeId)}`;
}

/** Secondary line: the follower's advertised MOTD, else its runtime tag. */
export function followerDetail(follower: ConnectedFollowerInfo): string | undefined {
  return follower.motd ?? follower.runtime ?? undefined;
}

/** Map the leader's roster onto the presentational rows the HUD renders. */
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
