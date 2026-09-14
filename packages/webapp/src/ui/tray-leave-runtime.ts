import type { TrayLeaveResult } from '../scoops/tray-leave.js';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from '../scoops/tray-runtime-config.js';

export interface TrayLeaveLogMeta {
  requestId?: string;

  error?: string;

  workerBaseUrl?: string;

  kind?: string;
}

export interface TrayLeaveLogger {
  error(message: string, meta?: TrayLeaveLogMeta): void;
}

export interface TrayLeaveStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TrayLeaveStoppable {
  stop(): void;
}

export interface TrayLeaveReadyHandle extends TrayLeaveStoppable {
  readonly ready: Promise<unknown>;
}

export interface TrayLeaveDeps<TLeaderHandle extends TrayLeaveReadyHandle> {
  getLeader(): TLeaderHandle | null;

  setLeader(handle: TLeaderHandle | null): void;

  getFollower(): TrayLeaveStoppable | null;

  setFollower(handle: TrayLeaveStoppable | null): void;

  startLeader(workerBaseUrl: string): TLeaderHandle;

  clearLeaderHooks(): void;

  wireLeaderHooks(handle: TLeaderHandle): void;

  storage: TrayLeaveStorage;

  log: TrayLeaveLogger;
}

export interface PerformTrayLeaveOptions {
  workerBaseUrl: string | null;

  requestId?: string;
}

export async function performTrayLeave<TLeaderHandle extends TrayLeaveReadyHandle>(
  opts: PerformTrayLeaveOptions,
  deps: TrayLeaveDeps<TLeaderHandle>
): Promise<TrayLeaveResult> {
  const previousMode: 'leader' | 'follower' | 'inactive' = deps.getLeader()
    ? 'leader'
    : deps.getFollower()
      ? 'follower'
      : 'inactive';

  const leaderToStop = deps.getLeader();
  deps.setLeader(null);
  const followerToStop = deps.getFollower();
  deps.setFollower(null);
  deps.clearLeaderHooks();

  const { requestId } = opts;

  try {
    leaderToStop?.stop();
  } catch (err) {
    deps.log.error('Leader stop threw during tray-leave — resources may have leaked', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    followerToStop?.stop();
  } catch (err) {
    deps.log.error('Follower stop threw during tray-leave — resources may have leaked', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  writeStorage(
    () => deps.storage.removeItem(TRAY_JOIN_STORAGE_KEY),
    deps.log,
    'join-clear',
    requestId
  );

  if (opts.workerBaseUrl === null) {
    writeStorage(
      () => deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY),
      deps.log,
      'worker-clear',
      requestId
    );
    if (previousMode === 'inactive') {
      return { kind: 'noop' };
    }
    return { kind: 'left', previousMode };
  }

  const newWorkerBaseUrl = opts.workerBaseUrl;
  let newHandle: TLeaderHandle;
  try {
    newHandle = deps.startLeader(newWorkerBaseUrl);
  } catch (err) {
    deps.log.error('startLeader failed during tray-leave — runtime is now dormant', {
      workerBaseUrl: newWorkerBaseUrl,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    writeStorage(
      () => deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY),
      deps.log,
      'worker-clear-on-failure',
      requestId
    );
    throw err;
  }

  deps.setLeader(newHandle);
  deps.wireLeaderHooks(newHandle);

  try {
    await newHandle.ready;
  } catch (err) {
    rollbackAfterReadyFailure(newHandle, deps, err, newWorkerBaseUrl, requestId);
    throw err;
  }

  if (deps.getLeader() !== newHandle) {
    deps.log.error('Leader superseded during connect — skipping storage write', {
      workerBaseUrl: newWorkerBaseUrl,
      requestId,
    });
    return { kind: 'switched', previousMode, workerBaseUrl: newWorkerBaseUrl };
  }

  writeStorage(
    () => deps.storage.setItem(TRAY_WORKER_STORAGE_KEY, newWorkerBaseUrl),
    deps.log,
    'worker-set',
    requestId
  );

  return { kind: 'switched', previousMode, workerBaseUrl: newWorkerBaseUrl };
}

function rollbackAfterReadyFailure<TLeaderHandle extends TrayLeaveReadyHandle>(
  newHandle: TLeaderHandle,
  deps: TrayLeaveDeps<TLeaderHandle>,
  err: unknown,
  newWorkerBaseUrl: string,
  requestId: string | undefined
): void {
  const stillOurs = deps.getLeader() === newHandle;
  try {
    newHandle.stop();
  } catch (stopErr) {
    deps.log.error('Leader stop threw during async-failure rollback — resources may have leaked', {
      requestId,
      error: stopErr instanceof Error ? stopErr.message : String(stopErr),
    });
  }
  if (stillOurs) {
    deps.setLeader(null);
    deps.clearLeaderHooks();
    writeStorage(
      () => deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY),
      deps.log,
      'worker-clear-on-async-failure',
      requestId
    );
  }
  deps.log.error('Leader ready failed during tray-leave — runtime is now dormant', {
    workerBaseUrl: newWorkerBaseUrl,
    requestId,
    error: err instanceof Error ? err.message : String(err),
  });
}

function writeStorage(
  op: () => void,
  log: TrayLeaveLogger,
  kind: string,
  requestId: string | undefined
): void {
  try {
    op();
  } catch (err) {
    log.error('tray-leave storage write failed', {
      kind,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
