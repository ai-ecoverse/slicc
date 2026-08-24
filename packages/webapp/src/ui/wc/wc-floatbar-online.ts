/**
 * `wc-floatbar-online.ts` — drives `<slicc-floatbar>` status beacon attributes
 * from tray runtime statuses and the serving float kind.
 *
 * Three orthogonal channels (see `floatbar-status.ts` in webcomponents):
 *  - `connection` — tray link health (ring color)
 *  - `float-kind` — npx / extension / … (center icon)
 *  - `tray-role` — leader / follower (corner pip)
 *
 * Follower count stays in the pill's followers segment; the label names only
 * the float kind.
 */

import type { FloatbarConnection, FloatbarFloatKind } from '@slicc/webcomponents';
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
import { floatLabelForKind } from './wc-float-label.js';

export interface InstallFloatbarStatusOptions {
  floatKind: FloatbarFloatKind;
  /** Pill label; defaults to the float kind name. */
  label?: string;
}

/**
 * Drive floatbar status attrs from tray runtime statuses. Seeds immediately and
 * updates on every leader/follower transition. Returns an uninstall function.
 */
export function installFloatbarStatus(
  floatbar: HTMLElement,
  options: InstallFloatbarStatusOptions
): () => void {
  const label = options.label ?? floatLabelForKind(options.floatKind);
  floatbar.setAttribute('label', label);
  floatbar.setAttribute('float-kind', options.floatKind);

  let leader = getLeaderTrayRuntimeStatus();
  let follower = getFollowerTrayRuntimeStatus();

  const apply = (): void => {
    const merged = mergeTrayStatus(leader, follower);
    floatbar.setAttribute('connection', merged.connection);
    if (merged.trayRole === 'none') floatbar.removeAttribute('tray-role');
    else floatbar.setAttribute('tray-role', merged.trayRole);
    // Legacy boolean for callers/tests that still read `online`.
    floatbar.toggleAttribute(
      'online',
      merged.connection === 'live' || merged.connection === 'stalled'
    );
  };

  const unsubscribeLeader = subscribeToLeaderTrayRuntimeStatus((status) => {
    leader = status;
    apply();
  });
  const unsubscribeFollower = subscribeToFollowerTrayRuntimeStatus((status) => {
    follower = status;
    apply();
  });
  apply();
  return () => {
    unsubscribeLeader();
    unsubscribeFollower();
  };
}

/** @deprecated Prefer {@link installFloatbarStatus} with an explicit float kind. */
export function installFloatbarOnline(floatbar: HTMLElement): () => void {
  return installFloatbarStatus(floatbar, { floatKind: 'standalone' });
}

export function mergeTrayStatus(
  leader: LeaderTrayRuntimeStatus,
  follower: FollowerTrayRuntimeStatus
): { connection: FloatbarConnection; trayRole: 'none' | 'leader' | 'follower' } {
  if (leader.state !== 'inactive') {
    return {
      connection: mapLeaderConnection(leader),
      trayRole: 'leader',
    };
  }
  if (follower.state !== 'inactive') {
    return {
      connection: mapFollowerConnection(follower),
      trayRole: 'follower',
    };
  }
  return { connection: 'offline', trayRole: 'none' };
}

function mapLeaderConnection(status: LeaderTrayRuntimeStatus): FloatbarConnection {
  switch (status.state) {
    case 'connecting':
      return 'connecting';
    case 'leader':
      return 'live';
    case 'reconnecting':
      return 'reconnecting';
    case 'error':
      return 'error';
    default:
      return 'offline';
  }
}

function mapFollowerConnection(status: FollowerTrayRuntimeStatus): FloatbarConnection {
  if (status.stalled) return 'stalled';
  switch (status.state) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'live';
    case 'reconnecting':
      return 'reconnecting';
    case 'error':
      return 'error';
    default:
      return 'offline';
  }
}
