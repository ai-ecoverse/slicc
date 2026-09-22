import type { SyncExecRequestPayload } from './sync-exec-dispatch.js';
import { SYNC_EXEC_CHANNEL, type SyncExecResultPayload } from './sync-exec-dispatch.js';
import type { SyncExecTransport } from './sync-exec-xhr-bridge.js';
import type { SyncFsResult } from './sync-fs-dispatch.js';
import { SYNC_EXEC_XHR_MARGIN_MS, SYNC_FS_REQUEST_TIMEOUT_MS } from './sync-fs-wire.js';
import { parseSyncFsStat, type SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';
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

export interface SabPostLike {
  postMessage(message: unknown): void;
}

export interface SyncSabTransport {
  call(req: SyncSabRequestBody, timeoutMs: number, label: string): SyncFsResult;
}

export type AtomicsWaitLike = (
  typedArray: Int32Array,
  index: number,
  value: number,
  timeout?: number
) => 'ok' | 'not-equal' | 'timed-out';

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

  function awaitReady(id: number, deadline: number, label: string): void {
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw syncXhrError('ETIMEDOUT', label);

      wait(header, SAB_I_STATE, SAB_STATE_PENDING, remaining);
      if (
        Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY &&
        Atomics.load(header, SAB_I_SEQ) === id
      ) {
        return;
      }
      if (Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY) {
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

export function createSyncFsSabBridge(
  transport: SyncSabTransport,
  opts: { timeoutMs?: number } = {}
): SyncFsPosixBridge {
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
      run({ op: 'write', path, body: data }, path);
    },
    stat: (path) => {
      const s = parseSyncFsStat(json({ op: 'stat', path }, path));
      if (!s) throw errnoError('EIO', path);
      return s;
    },
    lstat: (path) => {
      const s = parseSyncFsStat(json({ op: 'lstat', path }, path));
      if (!s) throw errnoError('EIO', path);
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
    rename: (from, to) => {
      run({ op: 'rename', path: from, arg2: to }, from);
    },
    unlink: (path) => {
      run({ op: 'unlink', path }, path);
    },
    rmdir: (path) => {
      run({ op: 'rmdir', path }, path);
    },
    symlink: (target, linkPath) => {
      run({ op: 'symlink', path: linkPath, arg2: target }, linkPath);
    },
    readlink: (path) => {
      const target = json({ op: 'readlink', path }, path);
      if (typeof target !== 'string') throw errnoError('EIO', path);
      return target;
    },
    chmod: (path, mode) => {
      run({ op: 'chmod', path, mode }, path);
    },
    utimes: (path, atimeMs, mtimeMs) => {
      run({ op: 'utimes', path, atimeMs, mtimeMs }, path);
    },
  };
}

export function createSyncExecSabTransport(transport: SyncSabTransport): SyncExecTransport {
  return (payload: SyncExecRequestPayload, timeoutMs: number, label: string) => {
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
