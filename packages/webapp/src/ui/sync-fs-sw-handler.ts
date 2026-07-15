/**
 * Pure Service-Worker handler half of the synchronous-fs bridge.
 *
 * A realm issues a synchronous XHR to `/__slicc/fs-sync/<vfs-path>` (GET =
 * read, POST = write). The controlling SW's fetch listener calls
 * `handleSyncFsRequest`, which round-trips the request over the per-session
 * nonce-named BroadcastChannel(s) (`slicc-sync-fs-<nonce>` — never the fixed
 * name `slicc-sync-fs`, which a realm could join; see `sync-fs-wire.ts`) to the
 * kernel-worker responder (`sync-fs-responder.ts`) and turns the reply into a
 * `Response`:
 *
 *   - ok read  → 200, raw bytes body
 *   - ok write → 200, empty body
 *   - errno    → mapped HTTP status + `x-slicc-fs-errno: <ENOENT|EACCES|…>`
 *   - timeout / no responder → 503 + `x-slicc-fs-errno: EIO` (fail closed;
 *     never leaves the blocked realm worker hanging past the budget)
 *
 * Extracted from the SW so it is testable without a `ServiceWorkerGlobalScope`.
 * The cold-start re-post loop mirrors `preview-sw-handler.ts`: the first XHR
 * after boot can beat the responder's listener, and BroadcastChannel drops
 * messages to a not-yet-attached listener, so we re-post until acked.
 */

// Wire contract shared with the realm bridge + kernel responder (single source
// of truth). Re-exported so `llm-proxy-sw` can keep importing the route prefix
// from this handler.
import {
  SYNC_FS_ACK_MSG,
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_REQ_MSG,
  SYNC_FS_RES_MSG,
  SYNC_FS_ROUTE_PREFIX,
  SYNC_FS_TOKEN_HEADER,
} from '../kernel/realm/sync-fs-wire.js';

export { SYNC_FS_ERRNO_HEADER, SYNC_FS_MARKER_HEADER, SYNC_FS_ROUTE_PREFIX, SYNC_FS_TOKEN_HEADER };

import type { SyncFsAckMsg, SyncFsResMsg } from '../kernel/realm/sync-fs-wire.js';

/**
 * Worst-case round-trip budget. Kept a margin BELOW the realm bridge's XHR
 * `timeout` (30 s, `sync-fs-xhr-bridge.ts`) so the SW's fail-closed
 * `503`+`x-slicc-fs-errno` response reaches the realm FIRST — making the errno
 * authoritative rather than racing the raw `xhr.timeout` (which yields a bare
 * `EIO` from the bridge's catch-all). The XHR timeout stays the true backstop
 * for a dead SW that never runs this handler at all.
 */
const DEFAULT_TIMEOUT_MS = 25000;
/** Cold-start re-post cadence until the responder acks. */
const DEFAULT_RETRY_INTERVAL_MS = 200;

/** Structural subset of `BroadcastChannel` so this is testable with a fake. */
export interface SyncFsSwChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

export interface SyncFsHandlerRequest {
  token: string;
  op: 'read' | 'write';
  path: string;
  body?: Uint8Array;
}

/**
 * Map a POSIX errno to an HTTP status for the fail response. The realm bridge
 * recovers the errno from the `x-slicc-fs-errno` header, NOT from this status —
 * the status only needs to be non-2xx (the specific code is for HTTP /
 * observability semantics; changing this mapping does not change the errno the
 * realm observes).
 */
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

/**
 * Parse a same-origin `/__slicc/fs-sync/*` request into a handler request.
 * GET → read, POST → write (body). Token comes from the `x-slicc-fs-token`
 * header. Returns `null` when the path is not a sync-fs route.
 */
export async function parseSyncFsRequest(request: {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}): Promise<SyncFsHandlerRequest | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(SYNC_FS_ROUTE_PREFIX)) return null;
  // Decode PER SEGMENT — the symmetric partner of the bridge's per-segment
  // `encodeURIComponent` (see sync-fs-xhr-bridge.ts `routeUrl`): decode each
  // segment (recovering `#`/`?`/`%`/space/unicode) while keeping `/` as the
  // structural separator, so the VFS path round-trips exactly.
  const raw = url.pathname.slice(SYNC_FS_ROUTE_PREFIX.length - 1); // keep leading '/'
  let path: string;
  try {
    path = raw.split('/').map(decodeURIComponent).join('/');
  } catch {
    // Malformed percent-encoding from an untrusted same-origin caller
    // (`decodeURIComponent('%ZZ')` throws). Return null → the caller maps it to
    // a fail-closed error rather than rejecting the respondWith promise.
    return null;
  }
  const token = request.headers.get(SYNC_FS_TOKEN_HEADER) ?? '';
  if (request.method === 'POST') {
    const buf = await request.arrayBuffer();
    return { token, op: 'write', path, body: new Uint8Array(buf) };
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
  // Phase-2 metadata result (stat/readdir/exists). Phase-1 never routes these
  // over the SW (`SyncFsHandlerRequest.op` is read|write), but the discriminated
  // union forces us to handle it so it can't be silently dropped as an empty
  // body when phase-2 wires metadata through.
  if (res.kind === 'json') {
    return new Response(JSON.stringify(res.json ?? null), {
      status: 200,
      headers: { 'content-type': 'application/json', [SYNC_FS_MARKER_HEADER]: '1' },
    });
  }
  // `bytes` (a read) or `void` (a write) → a raw body, empty for `void`. Copy
  // into a fresh Uint8Array so the type is `Uint8Array<ArrayBuffer>` (a valid
  // BodyInit) rather than the structured-clone'd generic form — same
  // normalization preview-sw-handler.ts uses.
  const body = res.kind === 'bytes' ? new Uint8Array(res.bytes) : new Uint8Array(0);
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream', [SYNC_FS_MARKER_HEADER]: '1' },
  });
}

/**
 * Round-trip a sync-fs request over the channel(s) and resolve a `Response`.
 * Always resolves (never rejects): a timeout / absent responder yields a
 * fail-closed 503 + `EIO` so the blocked realm worker unblocks.
 *
 * Fan-out: the SW may hold more than one live nonce-named channel (one per
 * same-origin leader tab — see `llm-proxy-sw.ts`). The request is posted on
 * ALL of them; because each kernel-worker responder stays SILENT for a token
 * it does not own (`sync-fs-responder.ts`), exactly the owning worker acks +
 * answers and the rest ignore it. Resolves on the first `sync-fs-res` for `id`.
 */
export function handleSyncFsRequest(
  channels: SyncFsSwChannelLike[],
  req: SyncFsHandlerRequest,
  opts: { timeoutMs?: number; retryIntervalMs?: number } = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const id = crypto.randomUUID();

  return new Promise<Response>((resolve) => {
    let acked = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      for (const ch of channels) ch.removeEventListener('message', onMessage);
      if (retryTimer) clearInterval(retryTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
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
