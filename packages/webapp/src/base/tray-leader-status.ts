/**
 * Leader tray runtime status registry — the singleton the LeaderTrayManager
 * updates and everything else reads.
 *
 * Lives in `base/` (the bottom rung of the layer stack) so `shell/` can read
 * it without importing UP into `scoops/` (#2537) — the same shape as
 * `base/permissions-surface-registry.ts`. The 800-line manager that DRIVES
 * this state stays in `scoops/tray-leader.ts` and re-exports these symbols
 * under their established names; only the state itself moved down.
 *
 * The registry MUST stay a single module instance: whichever realm runs the
 * manager sets the global here, and every other layer reads that same one.
 * Mirror of `base/tray-follower-status.ts`.
 */

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

export function getLeaderTrayRuntimeStatus(): LeaderTrayRuntimeStatus {
  return {
    ...leaderTrayRuntimeStatus,
    session: leaderTrayRuntimeStatus.session ? { ...leaderTrayRuntimeStatus.session } : null,
  };
}

/**
 * Key for the page→worker `localStorage` shim mirroring the leader tray
 * status. Defined in `base/tray-role.ts` (which `uname -n` reads from a layer
 * below this one) and re-exported here under its established name.
 */
export { LEADER_STATUS_STORAGE_KEY };

/**
 * Leader tray status with a `localStorage` fallback for the standalone
 * kernel-worker thread: when the worker's own module global is `inactive`
 * (because the page is the only side that actually runs `LeaderTrayManager`),
 * read the shim value that `main.ts` keeps current via
 * `subscribeToLeaderTrayRuntimeStatus`. Extension mode keeps the module
 * global as the source of truth because the offscreen runs the manager.
 *
 * Shared by `host-command.ts` and the `/licks-ws` `tray_status` reply so
 * `host`, `host reset/leave`, and the node-server's `/api/tray-status`
 * agree on what the leader status is.
 */
export function getLeaderStatusWithFallback(): LeaderTrayRuntimeStatus {
  const moduleStatus = getLeaderTrayRuntimeStatus();
  if (moduleStatus.state !== 'inactive') return moduleStatus;
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LEADER_STATUS_STORAGE_KEY
    );
    if (stored) {
      const parsed = JSON.parse(stored) as LeaderTrayRuntimeStatus;
      if (parsed?.state && parsed.state !== 'inactive') return parsed;
    }
  } catch {
    // ignore parse errors
  }
  return moduleStatus;
}

type LeaderTrayRuntimeStatusListener = (status: LeaderTrayRuntimeStatus) => void;
const leaderTrayRuntimeStatusListeners = new Set<LeaderTrayRuntimeStatusListener>();

/**
 * Subscribe to leader tray status changes. Called synchronously after
 * each update with the new (deep-copied) status. Returns an unsubscribe
 * function. The extension offscreen runtime uses this to mirror status
 * into the side-panel context, where the avatar popover lives.
 */
export function subscribeToLeaderTrayRuntimeStatus(
  listener: LeaderTrayRuntimeStatusListener
): () => void {
  leaderTrayRuntimeStatusListeners.add(listener);
  return () => {
    leaderTrayRuntimeStatusListeners.delete(listener);
  };
}

/**
 * Replace the leader tray status singleton and notify subscribers.
 * Exported so the extension panel can mirror updates pushed from the
 * offscreen document; the local manager calls this internally too.
 *
 * Each listener receives a fresh deep-copied snapshot so a listener
 * that mutates its argument can't change what later listeners observe.
 * Iterating a copy of the listener set means an unsubscribe / subscribe
 * during dispatch doesn't perturb the in-flight delivery either.
 */
export function setLeaderTrayRuntimeStatus(status: LeaderTrayRuntimeStatus): void {
  leaderTrayRuntimeStatus = {
    ...status,
    session: status.session ? { ...status.session } : null,
  };
  if (leaderTrayRuntimeStatusListeners.size === 0) return;
  for (const listener of [...leaderTrayRuntimeStatusListeners]) {
    try {
      listener(getLeaderTrayRuntimeStatus());
    } catch {
      // Listener errors must not break the manager's state machine.
    }
  }
}
