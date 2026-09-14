import { LEADER_STATUS_STORAGE_KEY } from './tray-role.js';

export interface LeaderTraySession {
  workerBaseUrl: string;
  trayId: string;
  createdAt: string;
  controllerId: string;
  controllerUrl: string;
  joinUrl: string;
  webhookUrl: string;
  leaderKey?: string;
  leaderWebSocketUrl?: string | null;
  runtime: string;

  coneId?: string;
}

export interface LeaderTrayRuntimeStatus {
  state: 'inactive' | 'connecting' | 'leader' | 'reconnecting' | 'error';
  session: LeaderTraySession | null;
  error: string | null;
  reconnectAttempts?: number;
}

let leaderTrayRuntimeStatus: LeaderTrayRuntimeStatus = {
  state: 'inactive',
  session: null,
  error: null,
};

function statusSession(session: LeaderTraySession | null): LeaderTraySession | null {
  if (!session) return null;
  return {
    workerBaseUrl: session.workerBaseUrl,
    trayId: session.trayId,
    createdAt: session.createdAt,
    controllerId: session.controllerId,
    controllerUrl: session.controllerUrl,
    joinUrl: session.joinUrl,
    webhookUrl: session.webhookUrl,
    runtime: session.runtime,
    ...(session.leaderKey !== undefined ? { leaderKey: session.leaderKey } : {}),
    ...(session.leaderWebSocketUrl !== undefined
      ? { leaderWebSocketUrl: session.leaderWebSocketUrl }
      : {}),
    ...(session.coneId !== undefined ? { coneId: session.coneId } : {}),
  };
}

export function getLeaderTrayRuntimeStatus(): LeaderTrayRuntimeStatus {
  return {
    ...leaderTrayRuntimeStatus,
    session: statusSession(leaderTrayRuntimeStatus.session),
  };
}

export { LEADER_STATUS_STORAGE_KEY };

export function getLeaderStatusWithFallback(): LeaderTrayRuntimeStatus {
  const moduleStatus = getLeaderTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as LeaderTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') {
        return { ...parsed, session: statusSession(parsed.session) };
      }
    }
  } catch {}
  return moduleStatus;
}

type LeaderTrayRuntimeStatusListener = (status: LeaderTrayRuntimeStatus) => void;
const leaderTrayRuntimeStatusListeners = new Set<LeaderTrayRuntimeStatusListener>();

export function subscribeToLeaderTrayRuntimeStatus(
  listener: LeaderTrayRuntimeStatusListener
): () => void {
  leaderTrayRuntimeStatusListeners.add(listener);
  return () => {
    leaderTrayRuntimeStatusListeners.delete(listener);
  };
}

export function setLeaderTrayRuntimeStatus(status: LeaderTrayRuntimeStatus): void {
  leaderTrayRuntimeStatus = {
    ...status,
    session: statusSession(status.session),
  };
  if (leaderTrayRuntimeStatusListeners.size === 0) return;
  for (const listener of [...leaderTrayRuntimeStatusListeners]) {
    try {
      listener(getLeaderTrayRuntimeStatus());
    } catch {}
  }
}
