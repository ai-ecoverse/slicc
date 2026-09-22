import {
  SYNC_EXEC_DEFAULT_TIMEOUT_MS,
  SYNC_EXEC_RESPONSE_MARGIN_MS,
  SYNC_EXEC_ROUTE,
  SYNC_FS_ACK_MSG,
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_NO_RESPONDER_HEADER,
  SYNC_FS_REQ_MSG,
  SYNC_FS_REQUEST_TIMEOUT_MS,
  SYNC_FS_RES_MSG,
  SYNC_FS_ROUTE_PREFIX,
  SYNC_FS_TOKEN_HEADER,
} from '../kernel/realm/sync-fs-wire.js';

export {
  SYNC_EXEC_ROUTE,
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_NO_RESPONDER_HEADER,
  SYNC_FS_ROUTE_PREFIX,
  SYNC_FS_TOKEN_HEADER,
};

import {
  clampSyncExecTimeout,
  normalizeSyncExecEnv,
  SYNC_EXEC_CHANNEL,
  type SyncExecRequest,
} from '../kernel/realm/sync-exec-dispatch.js';
import type { SyncFsAckMsg, SyncFsResMsg } from '../kernel/realm/sync-fs-wire.js';

const DEFAULT_TIMEOUT_MS = SYNC_FS_REQUEST_TIMEOUT_MS;

const DEFAULT_RETRY_INTERVAL_MS = 200;

const DEFAULT_NO_RESPONDER_MS = 10_000;

export interface SyncFsSwChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

type PosixArgOp = 'rename' | 'unlink' | 'rmdir' | 'symlink' | 'chmod' | 'utimes';

export interface SyncFsHandlerFsRequest {
  token: string;
  op:
    | 'read'
    | 'write'
    | 'stat'
    | 'lstat'
    | 'readdir'
    | 'exists'
    | 'readlink'
    | 'mkdir'
    | 'rm'
    | PosixArgOp;
  path: string;
  body?: Uint8Array;

  arg2?: string;

  mode?: number;

  atimeMs?: number;
  mtimeMs?: number;
}

export type SyncFsHandlerRequest =
  | SyncFsHandlerFsRequest
  | (SyncExecRequest & { op?: undefined; path?: undefined; body?: undefined });

const METADATA_OPS = new Set(['stat', 'lstat', 'readdir', 'exists', 'readlink']);

const MUTATING_OPS = new Set(['mkdir', 'rm']);

const POSIX_ARG_OPS: ReadonlySet<string> = new Set<PosixArgOp>([
  'rename',
  'unlink',
  'rmdir',
  'symlink',
  'chmod',
  'utimes',
]);

function parsePosixArgs(
  buf: ArrayBuffer
): Pick<SyncFsHandlerFsRequest, 'arg2' | 'mode' | 'atimeMs' | 'mtimeMs'> {
  let raw: { arg2?: unknown; mode?: unknown; atimeMs?: unknown; mtimeMs?: unknown } | null;
  try {
    raw = buf.byteLength ? JSON.parse(new TextDecoder().decode(buf)) : null;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const arg2 = typeof raw.arg2 === 'string' ? raw.arg2 : undefined;
  const mode = num(raw.mode);
  const atimeMs = num(raw.atimeMs);
  const mtimeMs = num(raw.mtimeMs);
  return {
    ...(arg2 !== undefined ? { arg2 } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(atimeMs !== undefined ? { atimeMs } : {}),
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  };
}

function budgetFor(req: SyncFsHandlerRequest): number {
  if (!isExecHandlerRequest(req)) return DEFAULT_TIMEOUT_MS;
  return (
    clampSyncExecTimeout(req.timeoutMs, SYNC_EXEC_DEFAULT_TIMEOUT_MS) + SYNC_EXEC_RESPONSE_MARGIN_MS
  );
}

function isExecHandlerRequest(req: SyncFsHandlerRequest): req is SyncExecRequest {
  return (req as { channel?: unknown }).channel === SYNC_EXEC_CHANNEL;
}

export function errnoToStatus(errno: string): number {
  switch (errno) {
    case 'ENOENT':
      return 404;
    case 'EACCES':
      return 403;
    case 'EISDIR':
    case 'ENOTDIR':
    case 'EINVAL':
      return 400;
    case 'EIO':
      return 503;
    default:
      return 500;
  }
}

async function parseSyncExecRequest(request: {
  method: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<SyncExecRequest | null> {
  if (request.method !== 'POST') return null;
  let payload: unknown;
  try {
    const buf = await request.arrayBuffer();
    payload = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;

  const p = payload as {
    command?: unknown;
    args?: unknown;
    stdin?: unknown;
    timeoutMs?: unknown;
    cwd?: unknown;
    env?: unknown;
  };
  const command = p.command;
  const commandOk =
    typeof command === 'string' ||
    (Array.isArray(command) && command.every((a) => typeof a === 'string'));
  if (!commandOk) return null;
  if (p.cwd !== undefined && typeof p.cwd !== 'string') return null;
  const envResult = p.env === undefined ? undefined : normalizeSyncExecEnv(p.env);
  if (envResult !== undefined && 'errno' in envResult) return null;
  return {
    token: request.headers.get(SYNC_FS_TOKEN_HEADER) ?? '',
    channel: SYNC_EXEC_CHANNEL,
    command: command as string | string[],
    ...(Array.isArray(p.args) && p.args.every((a) => typeof a === 'string')
      ? { args: p.args as string[] }
      : {}),
    ...(typeof p.stdin === 'string' ? { stdin: p.stdin } : {}),
    ...(typeof p.timeoutMs === 'number' ? { timeoutMs: p.timeoutMs } : {}),
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
    ...(envResult !== undefined ? { env: envResult.env } : {}),
  };
}

export async function parseSyncFsRequest(request: {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<SyncFsHandlerRequest | null> {
  const url = new URL(request.url);
  if (url.pathname === SYNC_EXEC_ROUTE) return parseSyncExecRequest(request);
  if (!url.pathname.startsWith(SYNC_FS_ROUTE_PREFIX)) return null;

  const raw = url.pathname.slice(SYNC_FS_ROUTE_PREFIX.length - 1);
  let path: string;
  try {
    path = raw.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  const token = request.headers.get(SYNC_FS_TOKEN_HEADER) ?? '';
  const opParam = url.searchParams.get('op');
  if (request.method === 'POST') {
    if (opParam && MUTATING_OPS.has(opParam)) {
      return { token, op: opParam as 'mkdir' | 'rm', path };
    }
    const buf = await request.arrayBuffer();
    if (opParam && POSIX_ARG_OPS.has(opParam)) {
      return { token, op: opParam as PosixArgOp, path, ...parsePosixArgs(buf) };
    }
    return { token, op: 'write', path, body: new Uint8Array(buf) };
  }

  if (opParam && METADATA_OPS.has(opParam)) {
    return { token, op: opParam as 'stat' | 'lstat' | 'readdir' | 'exists' | 'readlink', path };
  }
  return { token, op: 'read', path };
}

function buildResponse(res: SyncFsResMsg): Response {
  if (!res.ok) {
    const errno = res.errno ?? 'EIO';
    return new Response(res.message ?? errno, {
      status: errnoToStatus(errno),
      headers: { [SYNC_FS_ERRNO_HEADER]: errno, [SYNC_FS_MARKER_HEADER]: '1' },
    });
  }

  if (res.kind === 'json') {
    return new Response(JSON.stringify(res.json ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json', [SYNC_FS_MARKER_HEADER]: '1' },
    });
  }

  const body = res.kind === 'bytes' ? new Uint8Array(res.bytes) : new Uint8Array(0);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', [SYNC_FS_MARKER_HEADER]: '1' },
  });
}

export function handleSyncFsRequest(
  channels: SyncFsSwChannelLike[],
  req: SyncFsHandlerRequest,
  opts: { timeoutMs?: number; retryIntervalMs?: number; noResponderMs?: number } = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? budgetFor(req);
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const noResponderMs = Math.min(opts.noResponderMs ?? DEFAULT_NO_RESPONDER_MS, timeoutMs);
  const id = crypto.randomUUID();

  return new Promise<Response>((resolve) => {
    let acked = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let noResponderTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      for (const ch of channels) ch.removeEventListener('message', onMessage);
      if (retryTimer) clearInterval(retryTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (noResponderTimer) clearTimeout(noResponderTimer);
    };
    const finish = (response: Response): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as (SyncFsAckMsg | SyncFsResMsg) | undefined;
      if (!data || data.id !== id) return;
      if (data.type === SYNC_FS_ACK_MSG) {
        acked = true;
        if (retryTimer) clearInterval(retryTimer);

        if (noResponderTimer) clearTimeout(noResponderTimer);
        return;
      }
      if (data.type === SYNC_FS_RES_MSG) finish(buildResponse(data));
    };

    for (const ch of channels) ch.addEventListener('message', onMessage);
    const post = (): void => {
      for (const ch of channels) ch.postMessage({ type: SYNC_FS_REQ_MSG, id, ...req });
    };
    post();
    retryTimer = setInterval(() => {
      if (!acked) post();
    }, retryIntervalMs);
    noResponderTimer = setTimeout(() => {
      if (acked) return;

      finish(
        new Response('sync-fs bridge: no responder', {
          status: 503,
          headers: {
            [SYNC_FS_ERRNO_HEADER]: 'EIO',
            [SYNC_FS_MARKER_HEADER]: '1',

            [SYNC_FS_NO_RESPONDER_HEADER]: '1',
          },
        })
      );
    }, noResponderMs);
    timeoutTimer = setTimeout(() => {
      finish(
        new Response('sync-fs bridge timeout', {
          status: 503,
          headers: { [SYNC_FS_ERRNO_HEADER]: 'EIO', [SYNC_FS_MARKER_HEADER]: '1' },
        })
      );
    }, timeoutMs);
  });
}
