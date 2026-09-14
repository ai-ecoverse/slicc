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

  label?: string;
}

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
