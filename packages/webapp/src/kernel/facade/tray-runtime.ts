import {
  type FollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import {
  getLeaderTrayRuntimeStatus,
  type LeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import type { TrayRuntimeStatusMsg } from '../messages.js';

export type TrayRuntimeSnapshot = Pick<TrayRuntimeStatusMsg, 'leader' | 'follower'>;

/** Read and defensively project the tray runtime singletons onto their wire shape. */
export function buildTrayRuntimeSnapshot(): TrayRuntimeSnapshot {
  return projectTrayRuntimeStatus(getLeaderTrayRuntimeStatus(), getFollowerTrayRuntimeStatus());
}

export function projectTrayRuntimeStatus(
  leader: LeaderTrayRuntimeStatus,
  follower: FollowerTrayRuntimeStatus
): TrayRuntimeSnapshot {
  return {
    leader: {
      state: leader.state,
      session: leader.session
        ? {
            workerBaseUrl: leader.session.workerBaseUrl,
            trayId: leader.session.trayId,
            createdAt: leader.session.createdAt,
            controllerId: leader.session.controllerId,
            controllerUrl: leader.session.controllerUrl,
            joinUrl: leader.session.joinUrl,
            webhookUrl: leader.session.webhookUrl,
            ...(leader.session.leaderKey !== undefined
              ? { leaderKey: leader.session.leaderKey }
              : {}),
            ...(leader.session.leaderWebSocketUrl !== undefined
              ? { leaderWebSocketUrl: leader.session.leaderWebSocketUrl }
              : {}),
            runtime: leader.session.runtime,
          }
        : null,
      error: leader.error ?? null,
      reconnectAttempts: leader.reconnectAttempts ?? 0,
    },
    follower: {
      state: follower.state,
      joinUrl: follower.joinUrl,
      trayId: follower.trayId,
      error: follower.error,
      lastError: follower.lastError,
      reconnectAttempts: follower.reconnectAttempts,
      attachAttempts: follower.attachAttempts,
      lastAttachCode: follower.lastAttachCode,
      connectingSince: follower.connectingSince,
      lastPingTime: follower.lastPingTime,
    },
  };
}
