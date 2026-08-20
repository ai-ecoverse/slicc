/**
 * Wire contract for the Atomics/SharedArrayBuffer fast path of the synchronous
 * bridges (fs + exec) — the isolated-leader alternative to the sync-XHR → SW →
 * BroadcastChannel transport (#2043).
 *
 * Shape: one `SharedArrayBuffer` per realm, allocated by the kernel-side
 * realm runner and handed to the realm in `RealmInitMsg.syncSab`. The realm
 * posts a structured request on its existing control port, then blocks in
 * `Atomics.wait` on the header's STATE word. The kernel-side responder
 * dispatches through the very same `dispatchSyncFs` / `dispatchSyncExec` the SW
 * path uses (same token, same ACL + sudo enforcement), writes the encoded
 * result into the data window and `Atomics.notify`s. A result larger than the
 * window is drained in rounds: every chunk is its own `sync-sab-next` post +
 * wait, so the kernel never needs `Atomics.waitAsync` and is never blocked.
 *
 * Dependency-free on purpose (constants + pure encode/decode + types): the
 * realm worker bundle and the kernel worker bundle both import it, and a
 * renamed constant must fail at compile time on both ends rather than desync at
 * runtime.
 *
 * Layout (little-endian Int32 header, then the byte window):
 *
 *   i32[STATE]   0 idle · 1 pending (realm waiting) · 2 ready (chunk written)
 *   i32[SEQ]     request serial echoed by the responder — a stale wake-up
 *                (a previous request's late chunk) is ignored by the realm
 *   i32[STATUS]  result kind — see `SAB_STATUS_*`
 *   i32[TOTAL]   total payload bytes for this request
 *   i32[CHUNK]   bytes valid in the window for this round
 *   i32[OFFSET]  payload offset this chunk starts at (echo of the request)
 */

import type { SyncExecRequest } from './sync-exec-dispatch.js';
import type { SyncFsRequest, SyncFsResult } from './sync-fs-dispatch.js';

/** Int32 slots reserved for the header (64 bytes). */
export const SAB_HEADER_I32 = 16;
export const SAB_HEADER_BYTES = SAB_HEADER_I32 * 4;

export const SAB_I_STATE = 0;
export const SAB_I_SEQ = 1;
export const SAB_I_STATUS = 2;
export const SAB_I_TOTAL = 3;
export const SAB_I_CHUNK = 4;
export const SAB_I_OFFSET = 5;

export const SAB_STATE_IDLE = 0;
export const SAB_STATE_PENDING = 1;
export const SAB_STATE_READY = 2;

export const SAB_STATUS_BYTES = 1;
export const SAB_STATUS_JSON = 2;
export const SAB_STATUS_VOID = 3;
export const SAB_STATUS_ERRNO = 4;

/**
 * Default window: 1 MiB of payload per round. A `readFileSync` of a 10 MB file
 * costs ten rounds (~10 postMessage hops) instead of a 10 MB allocation per
 * realm. Large enough that the snapshot's old 1 MB/file cap is a single round.
 */
export const SAB_DEFAULT_WINDOW_BYTES = 1024 * 1024;
/** Smallest useful buffer: header + one 4 KiB window. */
export const SAB_MIN_BYTES = SAB_HEADER_BYTES + 4096;

/** Realm → host: start a request. `id` is the realm's serial (also written to SEQ). */
export const SYNC_SAB_REQ_MSG = 'sync-sab-req';
/** Realm → host: the window was consumed, write the chunk at `offset`. */
export const SYNC_SAB_NEXT_MSG = 'sync-sab-next';

/**
 * The request body, WITHOUT the capability token. The port is private to one
 * realm, so the responder binds the host-minted token itself and never trusts
 * a token the realm supplies — a realm cannot name another realm's scope.
 */
export type SyncSabRequestBody = Omit<SyncFsRequest, 'token'> | Omit<SyncExecRequest, 'token'>;

export interface SyncSabReqMsg {
  type: typeof SYNC_SAB_REQ_MSG;
  id: number;
  req: SyncSabRequestBody;
}
export interface SyncSabNextMsg {
  type: typeof SYNC_SAB_NEXT_MSG;
  id: number;
  offset: number;
}

/** A result encoded for the window: a status word + flat payload bytes. */
export interface SabEncodedResult {
  status: number;
  payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Flatten a dispatch result into `{ status, payload }` for the window. */
export function encodeSabResult(result: SyncFsResult): SabEncodedResult {
  if (!result.ok) {
    return {
      status: SAB_STATUS_ERRNO,
      payload: encoder.encode(JSON.stringify({ errno: result.errno, message: result.message })),
    };
  }
  switch (result.kind) {
    case 'bytes':
      return { status: SAB_STATUS_BYTES, payload: result.bytes };
    case 'json':
      return { status: SAB_STATUS_JSON, payload: encoder.encode(JSON.stringify(result.json)) };
    default:
      return { status: SAB_STATUS_VOID, payload: new Uint8Array(0) };
  }
}

/**
 * Inverse of {@link encodeSabResult}. A malformed payload (responder bug,
 * torn write) decodes to an `EIO` errno result rather than throwing a bare
 * `SyntaxError` — the realm shim relies on `.code` being present.
 */
export function decodeSabResult(status: number, payload: Uint8Array): SyncFsResult {
  switch (status) {
    case SAB_STATUS_BYTES:
      return { ok: true, kind: 'bytes', bytes: payload };
    case SAB_STATUS_VOID:
      return { ok: true, kind: 'void' };
    case SAB_STATUS_JSON: {
      try {
        return { ok: true, kind: 'json', json: JSON.parse(decoder.decode(payload)) };
      } catch {
        return { ok: false, errno: 'EIO', message: 'sync-sab: malformed json payload' };
      }
    }
    case SAB_STATUS_ERRNO: {
      try {
        const parsed = JSON.parse(decoder.decode(payload)) as {
          errno?: unknown;
          message?: unknown;
        };
        const errno =
          typeof parsed.errno === 'string' && /^E[A-Z]+$/.test(parsed.errno) ? parsed.errno : 'EIO';
        return { ok: false, errno, message: String(parsed.message ?? errno) };
      } catch {
        return { ok: false, errno: 'EIO', message: 'sync-sab: malformed errno payload' };
      }
    }
    default:
      return { ok: false, errno: 'EIO', message: `sync-sab: unknown status ${status}` };
  }
}

/** Typed views over one shared buffer; both ends build the same pair. */
export interface SabViews {
  header: Int32Array;
  window: Uint8Array;
}

export function sabViews(sab: SharedArrayBuffer): SabViews {
  if (sab.byteLength < SAB_MIN_BYTES) {
    throw new Error(`sync-sab: buffer too small (${sab.byteLength} < ${SAB_MIN_BYTES})`);
  }
  return {
    header: new Int32Array(sab, 0, SAB_HEADER_I32),
    window: new Uint8Array(sab, SAB_HEADER_BYTES),
  };
}

/**
 * Is the Atomics/SAB fast path usable in THIS realm? True only where a
 * `SharedArrayBuffer` can be constructed (cross-origin isolated document, or
 * Node) — the realm side additionally requires a thread that may block (a
 * `DedicatedWorker`), which the runner decides per realm (`Realm.isolatedThread`).
 */
export function isSyncSabSupported(): boolean {
  if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
  // In a browser, SAB is only constructible under cross-origin isolation; in
  // Node it is always available. `crossOriginIsolated` is undefined in Node.
  const coi = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  return coi === undefined || coi === true;
}
