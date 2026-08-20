/**
 * Realm-side client for the Atomics/SharedArrayBuffer sync bridge (#2043).
 *
 * Runs INSIDE the realm's DedicatedWorker on a cross-origin-isolated leader.
 * Each op posts a structured request over the realm's control port and blocks
 * the realm thread in `Atomics.wait` until the kernel-side responder
 * (`sync-sab-responder.ts`) has written the answer into the shared window.
 * There is no Service Worker, no HTTP, no BroadcastChannel and no snapshot cap
 * on this path; the per-op cost is one postMessage hop plus a memcpy per
 * window-sized chunk.
 *
 * The fs surface implements the SAME {@link SyncFsXhrMutatingBridge} the SW
 * transport does, so `createSyncFsBridge` (the `fs` shim) is transport-blind;
 * the exec surface is a {@link SyncExecTransport} plugged into
 * `createSyncExecXhrBridge`, which keeps its cache-coherence dance.
 *
 * Failure semantics match `sync-xhr.ts`: every transport fault (timeout, stale
 * wake-up, torn header) throws an `Error` with a POSIX `.code` — never a hang,
 * never a bare error — and a dispatch errno is rethrown with its own code.
 */

import type { SyncExecRequestPayload } from './sync-exec-dispatch.js';
import { SYNC_EXEC_CHANNEL, type SyncExecResultPayload } from './sync-exec-dispatch.js';
import type { SyncExecTransport } from './sync-exec-xhr-bridge.js';
import type { SyncFsResult } from './sync-fs-dispatch.js';
import { SYNC_EXEC_XHR_MARGIN_MS, SYNC_FS_REQUEST_TIMEOUT_MS } from './sync-fs-wire.js';
import type { SyncFsBridgeStat, SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';
import {
  decodeSabResult,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_STATE_IDLE,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  type SabViews,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabNextMsg,
  type SyncSabReqMsg,
  type SyncSabRequestBody,
  sabViews,
} from './sync-sab-wire.js';
import { syncXhrError } from './sync-xhr.js';

/** The one port method the transport needs; `RealmPortLike` satisfies it. */
export interface SabPostLike {
  postMessage(message: unknown): void;
}

export interface SyncSabTransport {
  /** Issue one blocking round-trip and return the decoded dispatch result. */
  call(req: SyncSabRequestBody, timeoutMs: number, label: string): SyncFsResult;
}

/** Blocking-wait seam so tests can observe/replace `Atomics.wait`. */
export type AtomicsWaitLike = (
  typedArray: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => 'ok' | 'not-equal' | 'timed-out';

/**
 * Build the transport over `sab`. `port` is the realm's control port (the
 * same one the async RPC rides); the kernel-side responder is attached to the
 * other end by `attachRealmHost`.
 */
export function createSyncSabTransport(
  sab: SharedArrayBuffer,
  port: SabPostLike,
  deps: { wait?: AtomicsWaitLike; now?: () => number } = {}
): SyncSabTransport {
  const views: SabViews = sabViews(sab);
  const { header, window } = views;
  const wait: AtomicsWaitLike = deps.wait ?? ((a, i, v, t) => Atomics.wait(a, i, v, t));
  const now = deps.now ?? (() => performance.now());
  let seq = 0;

  /**
   * Block until the responder has written a chunk for `id`, or the deadline
   * passes. A wake-up carrying another request's SEQ (a late chunk from a
   * request that already timed out) is ignored and the wait resumes.
   */
  function awaitReady(id: number, deadline: number, label: string): void {
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw syncXhrError('ETIMEDOUT', label);
      // `not-equal` means the responder already flipped STATE before we got
      // here — proceed to the checks below exactly as after a genuine wake.
      wait(header, SAB_I_STATE, SAB_STATE_PENDING, remaining);
      if (
        Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY &&
        Atomics.load(header, SAB_I_SEQ) === id
      ) {
        return;
      }
      if (Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY) {
        // Stale chunk for a previous serial: re-arm and keep waiting.
        Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
      }
    }
  }

  return {
    call(req, timeoutMs, label): SyncFsResult {
      const id = ++seq;
      const deadline = now() + timeoutMs;
      let out: Uint8Array | null = null;
      let status = 0;
      let offset = 0;
      try {
        for (;;) {
          Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
          const msg: SyncSabReqMsg | SyncSabNextMsg =
            offset === 0
              ? { type: SYNC_SAB_REQ_MSG, id, req }
              : { type: SYNC_SAB_NEXT_MSG, id, offset };
          try {
            port.postMessage(msg);
          } catch {
            throw syncXhrError('EIO', label);
          }
          awaitReady(id, deadline, label);
          const total = Atomics.load(header, SAB_I_TOTAL);
          const chunk = Atomics.load(header, SAB_I_CHUNK);
          const at = Atomics.load(header, SAB_I_OFFSET);
          if (at !== offset || chunk < 0 || total < 0 || offset + chunk > total) {
            throw syncXhrError('EIO', label);
          }
          if (out === null) {
            status = Atomics.load(header, SAB_I_STATUS);
            out = new Uint8Array(total);
          }
          out.set(window.subarray(0, chunk), offset);
          offset += chunk;
          if (offset >= total) break;
          // A zero-length chunk with bytes outstanding would spin forever.
          if (chunk === 0) throw syncXhrError('EIO', label);
        }
      } finally {
        Atomics.store(header, SAB_I_STATE, SAB_STATE_IDLE);
      }
      return decodeSabResult(status, out);
    },
  };
}

function errnoError(code: string, path: string): Error & { code: string } {
  return syncXhrError(code, `sync-sab bridge, '${path}'`);
}

function isStat(json: unknown): json is SyncFsBridgeStat {
  const s = json as Partial<SyncFsBridgeStat> | null;
  return (
    !!s &&
    typeof s.isFile === 'boolean' &&
    typeof s.isDirectory === 'boolean' &&
    typeof s.size === 'number'
  );
}

/**
 * The fs half: same method surface + error contract as `createSyncFsXhrBridge`,
 * so the `fs` shim cannot tell the transports apart.
 */
export function createSyncFsSabBridge(
  transport: SyncSabTransport,
  opts: { timeoutMs?: number } = {}
): SyncFsXhrMutatingBridge {
  const timeoutMs = opts.timeoutMs ?? SYNC_FS_REQUEST_TIMEOUT_MS;

  function run(req: SyncSabRequestBody, path: string): SyncFsResult {
    const result = transport.call(req, timeoutMs, `sync-sab bridge, '${path}'`);
    if (!result.ok) throw errnoError(result.errno, path);
    return result;
  }
  function bytes(req: SyncSabRequestBody, path: string): Uint8Array {
    const r = run(req, path);
    if (r.ok && r.kind === 'bytes') return r.bytes;
    throw errnoError('EIO', path);
  }
  function json(req: SyncSabRequestBody, path: string): unknown {
    const r = run(req, path);
    if (r.ok && r.kind === 'json') return r.json;
    throw errnoError('EIO', path);
  }

  return {
    readFile: (path) => bytes({ op: 'read', path }, path),
    writeFile: (path, data) => {
      // AT-LEAST-ONCE, same as the SW transport: a throw means the outcome is
      // unknown (the responder may have committed before a timeout fired).
      run({ op: 'write', path, body: data }, path);
    },
    stat: (path) => {
      const s = json({ op: 'stat', path }, path);
      if (!isStat(s)) throw errnoError('EIO', path);
      return s;
    },
    lstat: (path) => {
      const s = json({ op: 'lstat', path }, path);
      if (!isStat(s)) throw errnoError('EIO', path);
      return s;
    },
    readdir: (path) => {
      const list = json({ op: 'readdir', path }, path);
      if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) {
        throw errnoError('EIO', path);
      }
      return list as string[];
    },
    exists: (path) => {
      const v = json({ op: 'exists', path }, path);
      if (typeof v !== 'boolean') throw errnoError('EIO', path);
      return v;
    },
    mkdir: (path) => {
      run({ op: 'mkdir', path }, path);
    },
    rm: (path) => {
      run({ op: 'rm', path }, path);
    },
  };
}

/**
 * The exec half: a {@link SyncExecTransport} for `createSyncExecXhrBridge`.
 * The envelope is the SW route's POST body verbatim (`channel: 'exec'`), so
 * `dispatchSyncExec` sees an identical request either way.
 */
export function createSyncExecSabTransport(transport: SyncSabTransport): SyncExecTransport {
  return (payload: SyncExecRequestPayload, timeoutMs: number, label: string) => {
    // Wait a margin PAST the command budget, exactly like the SW transport
    // (`SYNC_EXEC_XHR_MARGIN_MS`): the kernel aborts `ctx.exec` at the budget
    // and only THEN encodes + publishes the result, so a deadline equal to the
    // budget would let a just-in-time success be clobbered by a realm-side
    // ETIMEDOUT. The kernel's authoritative result must win that race.
    const result = transport.call(
      { ...payload, channel: SYNC_EXEC_CHANNEL },
      timeoutMs + SYNC_EXEC_XHR_MARGIN_MS,
      label
    );
    if (!result.ok) throw syncXhrError(result.errno, label);
    const json = (
      result.kind === 'json' ? result.json : null
    ) as Partial<SyncExecResultPayload> | null;
    if (
      !json ||
      typeof json.stdout !== 'string' ||
      typeof json.stderr !== 'string' ||
      typeof json.exitCode !== 'number'
    ) {
      throw syncXhrError('EIO', label);
    }
    return { stdout: json.stdout, stderr: json.stderr, exitCode: json.exitCode };
  };
}
