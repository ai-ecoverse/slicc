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

// Wire contract with `sync-fs-sw-handler.ts` (kept as literals to avoid a
// kernel→ui import that would drag the SW handler into the realm bundle).
const SYNC_FS_ROUTE_BASE = '/__slicc/fs-sync';
const TOKEN_HEADER = 'x-slicc-fs-token';
const ERRNO_HEADER = 'x-slicc-fs-errno';
// Every genuine sync-fs response carries this marker. Its ABSENCE on a 2xx
// means the request was not answered by our SW handler — e.g. a stale/absent
// SW let it hit the network and the SPA fallback returned `200` + `index.html`.
// We reject that as EIO rather than mis-reading HTML as file bytes.
const MARKER_HEADER = 'x-slicc-fs';
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
  return encodeURI(SYNC_FS_ROUTE_BASE + abs);
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
    xhr.open(method, routeUrl(path), false); // synchronous — realm worker only
    // Permitted for sync XHR off the main thread; harmless if a stub ignores it.
    xhr.responseType = 'arraybuffer';
    try {
      xhr.timeout = timeoutMs;
    } catch {
      /* some sync-XHR impls reject timeout — best effort */
    }
    xhr.setRequestHeader(TOKEN_HEADER, token);
    try {
      if (body) xhr.send(new Uint8Array(body));
      else xhr.send();
    } catch {
      // A sync XHR throws on timeout / network error / no controlling SW.
      throw errnoError('EIO', path);
    }
    return xhr;
  }

  function fail(xhr: XMLHttpRequest, path: string): never {
    throw errnoError(xhr.getResponseHeader(ERRNO_HEADER) ?? 'EIO', path);
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
