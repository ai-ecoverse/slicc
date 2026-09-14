import { FOLLOWER_STATUS_STORAGE_KEY } from './tray-role.js';

export interface FollowerTrayRuntimeStatus {
  state: 'inactive' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  joinUrl: string | null;
  trayId: string | null;
  error: string | null;

  lastPingTime: number | null;

  reconnectAttempts: number;

  attachAttempts: number;

  lastAttachCode: string | null;

  connectingSince: number | null;

  lastError: string | null;

  stalled?: boolean;
}

let followerTrayRuntimeStatus: FollowerTrayRuntimeStatus = {
  state: 'inactive',
  joinUrl: null,
  trayId: null,
  error: null,
  lastPingTime: null,
  reconnectAttempts: 0,
  attachAttempts: 0,
  lastAttachCode: null,
  connectingSince: null,
  lastError: null,
};

export function getFollowerTrayRuntimeStatus(): FollowerTrayRuntimeStatus {
  return { ...followerTrayRuntimeStatus };
}

export { FOLLOWER_STATUS_STORAGE_KEY };

export function getFollowerStatusWithFallback(): FollowerTrayRuntimeStatus {
  const moduleStatus = getFollowerTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      FOLLOWER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as FollowerTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') return parsed;
    }
  } catch {}
  return moduleStatus;
}

type FollowerTrayRuntimeStatusListener = (status: FollowerTrayRuntimeStatus) => void;
const followerTrayRuntimeStatusListeners = new Set<FollowerTrayRuntimeStatusListener>();

export function subscribeToFollowerTrayRuntimeStatus(
  listener: FollowerTrayRuntimeStatusListener
): () => void {
  followerTrayRuntimeStatusListeners.add(listener);
  return () => {
    followerTrayRuntimeStatusListeners.delete(listener);
  };
}

function notifyFollowerListeners(): void {
  if (followerTrayRuntimeStatusListeners.size === 0) return;
  for (const listener of [...followerTrayRuntimeStatusListeners]) {
    try {
      listener({ ...followerTrayRuntimeStatus });
    } catch {}
  }
}

export function setFollowerTrayRuntimeStatus(status: FollowerTrayRuntimeStatus): void {
  followerTrayRuntimeStatus = { ...status };
  notifyFollowerListeners();
}

export function resetReconnectAttempts(): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, reconnectAttempts: 0 };
  notifyFollowerListeners();
}

export function setFollowerLastPingTime(timestamp: number): void {
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, lastPingTime: timestamp };
  notifyFollowerListeners();
}

export function setFollowerStalled(stalled: boolean): void {
  if (followerTrayRuntimeStatus.stalled === stalled) return;
  followerTrayRuntimeStatus = { ...followerTrayRuntimeStatus, stalled };
  notifyFollowerListeners();
}
