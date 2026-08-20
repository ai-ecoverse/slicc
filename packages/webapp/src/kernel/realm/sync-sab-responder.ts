/**
 * Kernel-side responder for the Atomics/SharedArrayBuffer sync bridge (#2043).
 *
 * Attached by `attachRealmHost` to ONE realm's control port, bound to that
 * realm's host-minted capability token. A `sync-sab-req` runs through the very
 * same `dispatchSyncFs` / `dispatchSyncExec` the SW transport uses — the token
 * resolves to the realm's gated `ctx.fs` / `ctx.exec`, so ACLs, sudo prompts
 * and errno fidelity are identical — and the encoded result is streamed into
 * the shared window one chunk per round. The realm is parked in `Atomics.wait`
 * meanwhile; this thread never blocks.
 *
 * Security: the request body carries NO token. The port is private to the
 * realm (a targeted `worker.postMessage`, not a broadcast), so "which realm
 * sent this" is answered by which responder received it — the token is
 * injected here from the host, never read from the realm. A realm therefore
 * cannot address another realm's scope, and a forged `id` can at worst replay
 * its own pending payload.
 *
 * Per-request state is a pending payload keyed by the realm serial `id`,
 * retained until the realm has drained the last chunk or a TTL elapses (a
 * realm that timed out mid-drain never sends `sync-sab-next`).
 */

import { dispatchSyncExec, isSyncExecRequest, type SyncExecRequest } from './sync-exec-dispatch.js';
import { dispatchSyncFs, type SyncFsRequest, type SyncFsResult } from './sync-fs-dispatch.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS, SYNC_FS_REQUEST_TIMEOUT_MS } from './sync-fs-wire.js';
import {
  encodeSabResult,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_STATE_READY,
  type SabViews,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabNextMsg,
  type SyncSabReqMsg,
  sabViews,
} from './sync-sab-wire.js';

/** Listener surface the responder needs from the realm port. */
export interface SabPortLike {
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

export interface SyncSabResponderHandle {
  /** Detach + drop pending payloads. Idempotent. */
  dispose(): void;
}

interface PendingPayload {
  status: number;
  payload: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

/** Retain an undrained payload at least as long as any realm-side wait can last. */
const PENDING_TTL_MS = Math.max(SYNC_FS_REQUEST_TIMEOUT_MS, SYNC_EXEC_MAX_TIMEOUT_MS) + 5_000;

export interface SyncSabResponderOptions {
  /** Override the dispatchers (tests). Production uses the token-scoped ones. */
  dispatch?: (req: SyncFsRequest | SyncExecRequest) => Promise<SyncFsResult>;
}

/**
 * Install the responder on `port` for the realm that owns `token`.
 */
export function attachSyncSabResponder(
  port: SabPortLike,
  sab: SharedArrayBuffer,
  token: string,
  opts: SyncSabResponderOptions = {}
): SyncSabResponderHandle {
  const views: SabViews = sabViews(sab);
  const { header, window } = views;
  const pending = new Map<number, PendingPayload>();
  let disposed = false;

  const dispatch =
    opts.dispatch ??
    ((req: SyncFsRequest | SyncExecRequest) =>
      isSyncExecRequest(req) ? dispatchSyncExec(req) : dispatchSyncFs(req));

  function drop(id: number): void {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
  }

  /** Copy one chunk into the window and wake the realm. */
  function publish(id: number, entry: PendingPayload, offset: number): void {
    const chunk = Math.min(window.byteLength, entry.payload.byteLength - offset);
    if (chunk > 0) window.set(entry.payload.subarray(offset, offset + chunk));
    Atomics.store(header, SAB_I_STATUS, entry.status);
    Atomics.store(header, SAB_I_TOTAL, entry.payload.byteLength);
    Atomics.store(header, SAB_I_CHUNK, chunk);
    Atomics.store(header, SAB_I_OFFSET, offset);
    Atomics.store(header, SAB_I_SEQ, id);
    Atomics.store(header, SAB_I_STATE, SAB_STATE_READY);
    Atomics.notify(header, SAB_I_STATE);
    // Last chunk delivered → nothing left to drain.
    if (offset + chunk >= entry.payload.byteLength) drop(id);
  }

  function settle(id: number, result: SyncFsResult): void {
    if (disposed) return;
    const { status, payload } = encodeSabResult(result);
    // Replace any stale entry under the same serial (cannot happen for a
    // well-behaved realm — serials are monotonic — but never leak a timer).
    drop(id);
    const entry: PendingPayload = {
      status,
      payload,
      timer: setTimeout(() => drop(id), PENDING_TTL_MS),
    };
    pending.set(id, entry);
    publish(id, entry, 0);
  }

  const handler = (event: MessageEvent): void => {
    const data = event.data as
      | { type?: unknown; id?: unknown; req?: unknown; offset?: unknown }
      | undefined;
    if (!data || typeof data.id !== 'number') return;
    if (data.type === SYNC_SAB_NEXT_MSG) {
      const entry = pending.get(data.id);
      const offset = (data as Partial<SyncSabNextMsg>).offset;
      if (
        !entry ||
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > entry.payload.byteLength
      ) {
        // Unknown serial or a nonsense offset: answer with an errno so the
        // realm fails closed instead of waiting out its budget.
        settle(data.id, { ok: false, errno: 'EIO', message: 'sync-sab: bad continuation' });
        return;
      }
      publish(data.id, entry, offset);
      return;
    }
    if (data.type !== SYNC_SAB_REQ_MSG || !data.req || typeof data.req !== 'object') return;
    const id = data.id;
    // Bind the HOST's token — whatever the realm may have put in the body is
    // discarded by the spread order below.
    const body = (data as SyncSabReqMsg).req;
    const req = { ...body, token } as SyncFsRequest | SyncExecRequest;
    let dispatched: Promise<SyncFsResult>;
    try {
      dispatched = dispatch(req);
    } catch (err) {
      settle(id, {
        ok: false,
        errno: 'EIO',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void dispatched.then(
      (result) => settle(id, result),
      (err) =>
        settle(id, {
          ok: false,
          errno: 'EIO',
          message: err instanceof Error ? err.message : String(err),
        })
    );
  };

  port.addEventListener('message', handler);
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', handler);
      for (const id of [...pending.keys()]) drop(id);
    },
  };
}
