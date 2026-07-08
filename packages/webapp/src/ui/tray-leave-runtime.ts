/**
 * Page-side executor for `slicc:tray-leave` events and the panel-RPC
 * `tray-leave` op. Pure relative to its injected `TrayLeaveDeps` — the
 * actual page state (`pageLeaderTray`, `pageFollowerTray`, `layout`,
 * `sprinkleManager`) lives in `main.ts` and is threaded through via
 * getters / setters / callbacks so this file is unit-testable.
 *
 * Storage update order is load-bearing: the leader-restart branch
 * writes `TRAY_WORKER_STORAGE_KEY` only AFTER the leader's `ready`
 * promise resolves, so both synchronous throws from `startLeader` and
 * asynchronous failures (timeout, auth, WebRTC init) leave the
 * runtime fully dormant (both keys cleared) instead of persisting a
 * stale leader-on-failed-worker config that the next page reload
 * would try to revive.
 */

import type { TrayLeaveResult } from '../scoops/tray-leave.js';
import { TRAY_JOIN_STORAGE_KEY, TRAY_WORKER_STORAGE_KEY } from '../scoops/tray-runtime-config.js';

/** Minimal logger surface — matches `createLogger` shape but loose enough for tests. */
export interface TrayLeaveLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Minimal storage surface — `window.localStorage` is the production target. */
export interface TrayLeaveStorage {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A live tray handle (leader or follower) — we only need a `stop()` for
 * teardown. The real `PageLeaderTrayHandle` / `PageFollowerTrayHandle`
 * are super-types of this and pass freely.
 */
export interface TrayLeaveStoppable {
  stop(): void;
}

/**
 * Extended handle for leader restarts — adds a `ready` signal so
 * `performTrayLeave` can await actual connection before persisting.
 */
export interface TrayLeaveReadyHandle extends TrayLeaveStoppable {
  /** Resolves when the leader has connected; rejects on failure. */
  readonly ready: Promise<unknown>;
}

export interface TrayLeaveDeps<TLeaderHandle extends TrayLeaveReadyHandle> {
  /** Read the current leader handle. Returns `null` when not a leader. */
  getLeader(): TLeaderHandle | null;
  /** Replace the leader handle reference (used to null on stop / set after restart). */
  setLeader(handle: TLeaderHandle | null): void;
  /** Read the current follower handle. */
  getFollower(): TrayLeaveStoppable | null;
  /** Replace the follower handle reference. */
  setFollower(handle: TrayLeaveStoppable | null): void;
  /**
   * Start a fresh leader tray on the given worker. Returns the new
   * handle synchronously; the handle's `ready` promise resolves once
   * the leader has connected. Synchronous throws and async `ready`
   * rejections are both caught and rolled back by the executor.
   */
  startLeader(workerBaseUrl: string): TLeaderHandle;
  /** Clear callbacks the orchestrator exposes for follower count / reset. */
  clearLeaderHooks(): void;
  /** Wire callbacks against the new leader handle. */
  wireLeaderHooks(handle: TLeaderHandle): void;
  /** Storage to keep aligned with the post-leave runtime state. */
  storage: TrayLeaveStorage;
  /** Logger for failures (stop throws, storage throws, leader-restart fails). */
  log: TrayLeaveLogger;
}

export interface PerformTrayLeaveOptions {
  /**
   * `null` → leave entirely, return `{ kind: 'left', … }` (or `noop`).
   * Non-empty string → switch into leader mode on this worker, return
   * `{ kind: 'switched', … }`. Callers MUST pre-normalize via
   * `normalizeTrayWorkerBaseUrl` — this layer treats `''` as a valid
   * non-null URL.
   */
  workerBaseUrl: string | null;
  /**
   * Optional correlation id forwarded into failure log meta so panel /
   * worker / shell entries can be matched up across rapid retries.
   */
  requestId?: string;
}

/**
 * Stop whichever tray role this runtime is currently in, update
 * storage, and — when `workerBaseUrl !== null` — start a fresh leader
 * tray. Returns a discriminated `TrayLeaveResult` so the shell
 * formatter and the panel-RPC consumer narrow exhaustively.
 *
 * Throws when the leader restart fails: at that point the previous
 * tray is already stopped and storage is rolled back to "fully
 * dormant", so the rethrow surfaces to the caller as "stop succeeded,
 * restart failed" rather than "tray is left in a half-state".
 */
export async function performTrayLeave<TLeaderHandle extends TrayLeaveReadyHandle>(
  opts: PerformTrayLeaveOptions,
  deps: TrayLeaveDeps<TLeaderHandle>
): Promise<TrayLeaveResult> {
  const previousMode: 'leader' | 'follower' | 'inactive' = deps.getLeader()
    ? 'leader'
    : deps.getFollower()
      ? 'follower'
      : 'inactive';

  // Null refs FIRST so any reentrant code (cached getters consumed
  // mid-teardown, microtasks queued against the old leader, etc.) sees
  // the post-teardown state.
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

  // Always clear the join key — leaving (kind: 'left') and switching
  // (kind: 'switched') both drop any follower role.
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

  // Leader-restart branch: storage write happens AFTER the leader's
  // `ready` promise resolves. Both synchronous throws from
  // `startLeader` and asynchronous failures roll back to
  // fully-dormant storage so the next page reload doesn't try to
  // revive a stale leader on a dead worker.
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

  // Install the handle so the leader can function during connection
  // (receive signaling, set up peers). Undone on async failure below.
  deps.setLeader(newHandle);
  deps.wireLeaderHooks(newHandle);

  // Await readiness — leader.start() already has its own connect
  // timeout (LEADER_TRAY_CONNECT_TIMEOUT_MS = 10s), so no extra
  // race is needed here.
  try {
    await newHandle.ready;
  } catch (err) {
    rollbackAfterReadyFailure(newHandle, deps, err, newWorkerBaseUrl, requestId);
    throw err;
  }

  // Success-path reentrancy guard, mirroring the failure path: a
  // concurrent call may have replaced (switch) or stopped (leave) this
  // leader during the await window — that call now owns runtime state
  // AND storage. Writing our worker URL here would resurrect a leader
  // the user just left/replaced on the next reload (the exact stale-
  // persisted-state class this executor exists to prevent). Skip the
  // write; report `switched` because this call's switch did succeed —
  // final state belongs to the superseding call.
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

/**
 * Async-failure rollback for the leader-restart branch: tear down the
 * partially-started leader and roll back to fully-dormant state. Guards
 * against reentrancy — a concurrent `performTrayLeave` call may have
 * already replaced the leader during the await window, in which case
 * only the failed handle is stopped and the superseding call's
 * leader/hooks/storage are left untouched.
 */
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

/**
 * Storage writes can throw in sandboxed contexts (incognito with
 * `localStorage` blocked, sandbox iframes). Log via `deps.log` and
 * continue — the runtime is in the correct state, only the boot-time
 * persistence is out of step (next reload will boot stale, log entry
 * surfaces the skew). `kind` labels which write failed so log entries
 * are actionable; `requestId` correlates with the panel-RPC / shell
 * entry that drove this leave.
 */
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
