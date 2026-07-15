/**
 * Realm-side client for the synchronous-fs bridge.
 *
 * Runs INSIDE the realm's DedicatedWorker. Each op issues a **synchronous**
 * `XMLHttpRequest` to `/__slicc/fs-sync/<path>` — the controlling Service
 * Worker intercepts it (`llm-proxy-sw.ts`), round-trips to the kernel-worker
 * responder, and answers from the calling realm's own `ctx.fs`. The XHR blocks
 * the realm worker (a different thread from the VFS owner, so no deadlock)
 * until bytes come back.
 *
 * Synchronous XHR with `responseType='arraybuffer'` + a `timeout` is only
 * permitted OFF the main thread — which is exactly where realm code runs. On
 * any transport failure (timeout / no controlling SW / network error) the op
 * throws an `Error` whose `.code` is a POSIX errno, so it fails closed instead
 * of hanging, and ported Node code's `catch (e) { e.code === '…' }` still works.
 *
 * Phase-1 exposes only `readFile` / `writeFile` (the load-bearing sync ops);
 * metadata ops stay snapshot-backed in the shim (see the plan).
 */

// Wire contract shared with the SW handler + responder (single source of
// truth — see sync-fs-wire.ts, a dependency-free module). The MARKER header
// is load-bearing: its ABSENCE on a 2xx means the request was NOT answered by
// our SW handler (a stale/absent SW let it hit the network → SPA fallback
// `200` + `index.html`), so we reject it as EIO rather than reading HTML as
// file bytes.
import {
  SYNC_FS_ERRNO_HEADER as ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER as MARKER_HEADER,
  SYNC_FS_ROUTE_BASE,
  SYNC_FS_TOKEN_HEADER as TOKEN_HEADER,
} from './sync-fs-wire.js';

const DEFAULT_TIMEOUT_MS = 30000;

export interface SyncFsXhrBridge {
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
}

/** An `Error` carrying a POSIX `.code`, matching sync-fs-cache's errors. */
function errnoError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: sync-fs bridge, '${path}'`), { code });
}

function routeUrl(path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  // Encode PER SEGMENT: encodeURIComponent escapes `#`, `?`, `%`, space, and
  // unicode (which whole-string encodeURI leaves raw → dropped fragment/query
  // or a decode throw), while keeping `/` as the structural separator. The SW
  // handler decodes symmetrically per segment.
  return SYNC_FS_ROUTE_BASE + abs.split('/').map(encodeURIComponent).join('/');
}

/**
 * Build a bridge bound to `token`. The token addresses the calling realm's
 * own `{ fs, cwd }` server-side (see `sync-fs-token-registry.ts`).
 */
export function createSyncFsXhrBridge(
  token: string,
  opts: { timeoutMs?: number } = {}
): SyncFsXhrBridge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function send(method: 'GET' | 'POST', path: string, body?: Uint8Array): XMLHttpRequest {
    const xhr = new XMLHttpRequest();
    try {
      xhr.open(method, routeUrl(path), false); // synchronous — realm worker only
      xhr.responseType = 'arraybuffer'; // permitted for sync XHR off the main thread
      xhr.timeout = timeoutMs; // bounds a no-controller network hang
      xhr.setRequestHeader(TOKEN_HEADER, token);
      if (body) xhr.send(new Uint8Array(body));
      else xhr.send();
    } catch {
      // ANY failure fails closed as EIO — a sync XHR throws on timeout /
      // network error / no controlling SW, and open/responseType/timeout could
      // in principle reject. Never let a raw error (missing `.code`) escape,
      // and never leave the realm hung.
      throw errnoError('EIO', path);
    }
    return xhr;
  }

  function fail(xhr: XMLHttpRequest, path: string): never {
    // Only trust the errno header when OUR handler stamped the marker — symmetric
    // with the 2xx marker gate. A non-2xx lacking the marker isn't ours (a
    // foreign/injected response), so fall back to EIO rather than reading an
    // attacker-supplied x-slicc-fs-errno as authoritative.
    const trusted = xhr.getResponseHeader(MARKER_HEADER) === '1';
    throw errnoError((trusted && xhr.getResponseHeader(ERRNO_HEADER)) || 'EIO', path);
  }
  /** A 2xx is only trustworthy if our handler stamped the marker. */
  function isGenuine(xhr: XMLHttpRequest): boolean {
    return xhr.status >= 200 && xhr.status < 300 && xhr.getResponseHeader(MARKER_HEADER) === '1';
  }

  return {
    readFile(path: string): Uint8Array {
      const xhr = send('GET', path);
      if (isGenuine(xhr)) return new Uint8Array(xhr.response as ArrayBuffer);
      // 2xx without the marker = SPA fallback / stale SW → not our bytes.
      if (xhr.status >= 200 && xhr.status < 300) throw errnoError('EIO', path);
      fail(xhr, path);
    },
    writeFile(path: string, bytes: Uint8Array): void {
      const xhr = send('POST', path, bytes);
      if (isGenuine(xhr)) return;
      if (xhr.status >= 200 && xhr.status < 300) throw errnoError('EIO', path);
      fail(xhr, path);
    },
  };
}
