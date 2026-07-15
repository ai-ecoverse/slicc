/**
 * Pure Service-Worker handler half of the synchronous-fs bridge.
 *
 * A realm issues a synchronous XHR to `/__slicc/fs-sync/<vfs-path>` (GET =
 * read, POST = write). The controlling SW's fetch listener calls
 * `handleSyncFsRequest`, which round-trips the request over the
 * `slicc-sync-fs` BroadcastChannel to the kernel-worker responder
 * (`sync-fs-responder.ts`) and turns the reply into a `Response`:
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
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_ROUTE_PREFIX,
  SYNC_FS_TOKEN_HEADER,
} from '../kernel/realm/sync-fs-wire.js';

export { SYNC_FS_ERRNO_HEADER, SYNC_FS_MARKER_HEADER, SYNC_FS_ROUTE_PREFIX, SYNC_FS_TOKEN_HEADER };

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

/** Map a POSIX errno to the HTTP status the realm bridge decodes. */
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

interface SyncFsResEnvelope {
  type?: string;
  id?: string;
  ok?: boolean;
  bytes?: Uint8Array;
  errno?: string;
  message?: string;
}

function buildResponse(res: SyncFsResEnvelope): Response {
  if (res.ok) {
    // Copy into a fresh Uint8Array so the type is `Uint8Array<ArrayBuffer>`
    // (a valid BodyInit) rather than the structured-clone'd generic form —
    // same normalization preview-sw-handler.ts uses.
    const body = res.bytes ? new Uint8Array(res.bytes) : new Uint8Array(0);
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', [SYNC_FS_MARKER_HEADER]: '1' },
    });
  }
  const errno = res.errno ?? 'EIO';
  return new Response(res.message ?? errno, {
    status: errnoToStatus(errno),
    headers: { [SYNC_FS_ERRNO_HEADER]: errno, [SYNC_FS_MARKER_HEADER]: '1' },
  });
}

/**
 * Round-trip a sync-fs request over the channel and resolve a `Response`.
 * Always resolves (never rejects): a timeout / absent responder yields a
 * fail-closed 503 + `EIO` so the blocked realm worker unblocks.
 */
export function handleSyncFsRequest(
  channel: SyncFsSwChannelLike,
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
      channel.removeEventListener('message', onMessage);
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
      const data = event.data as SyncFsResEnvelope | undefined;
      if (!data || data.id !== id) return;
      if (data.type === 'sync-fs-ack') {
        acked = true;
        if (retryTimer) clearInterval(retryTimer);
        return;
      }
      if (data.type === 'sync-fs-res') finish(buildResponse(data));
    };

    channel.addEventListener('message', onMessage);
    const post = (): void => channel.postMessage({ type: 'sync-fs-req', id, ...req });
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
