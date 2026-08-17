/**
 * Realm-side client for the synchronous-fs bridge.
 *
 * Runs INSIDE the realm's DedicatedWorker. Each op issues a **synchronous**
 * `XMLHttpRequest` to `/__slicc/fs-sync/<path>` — the controlling Service
 * Worker intercepts it (`llm-proxy-sw.ts`), round-trips to the kernel-worker
 * responder, and answers from the calling realm's own `ctx.fs`. The blocking
 * round-trip itself (marker gate, errno recovery, fail-closed transport) lives
 * in `sync-xhr.ts` and is shared with the exec channel; this module owns only
 * the fs route shape and the per-op payload contracts.
 *
 * Phase-2 extends this to the metadata ops (`stat` / `readdir` / `exists`)
 * so the shim can fall back to the live filesystem on a cache miss — a file
 * created after the boot snapshot or beyond the entry cap is otherwise
 * silently reported as absent. Metadata ops ride a GET with an `?op=` query
 * param and return a JSON body; the read/write wire is unchanged.
 */

import { SYNC_FS_ROUTE_BASE } from './sync-fs-wire.js';
import { type SyncXhrRequest, synchronify, synchronifyJson, syncXhrError } from './sync-xhr.js';

const DEFAULT_TIMEOUT_MS = 30000;

/** Shape of a `stat` result — mirrors {@link SyncFsCache.stat} exactly. */
export interface SyncFsBridgeStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;
}

/** What the `fs` shim consumes — read/write plus read-only metadata. */
export interface SyncFsXhrBridge {
  readFile(path: string): Uint8Array;
  writeFile(path: string, bytes: Uint8Array): void;
  stat(path: string): SyncFsBridgeStat;
  lstat(path: string): SyncFsBridgeStat;
  readdir(path: string): string[];
  exists(path: string): boolean;
}

/**
 * The full bridge {@link createSyncFsXhrBridge} returns. The two mutating ops
 * are kept OFF {@link SyncFsXhrBridge} because the `fs` shim deliberately keeps
 * mkdir/rm cache-backed; only the sync-exec flush-before path drives them live,
 * so the narrower type documents (and enforces) that split.
 */
export interface SyncFsXhrMutatingBridge extends SyncFsXhrBridge {
  /** Live `mkdir -p`. */
  mkdir(path: string): void;
  /** Live recursive `rm`. */
  rm(path: string): void;
}

/** Ops the route carries as an `?op=` query param (bare read/write carry none). */
type SyncFsRouteOp = 'stat' | 'lstat' | 'readdir' | 'exists' | 'mkdir' | 'rm';

/** An `Error` carrying a POSIX `.code`, matching sync-fs-cache's errors. */
function errnoError(code: string, path: string): Error & { code: string } {
  return syncXhrError(code, `sync-fs bridge, '${path}'`);
}

function routeUrl(path: string, op?: SyncFsRouteOp): string {
  const abs = path.startsWith('/') ? path : `/${path}`;
  // Encode PER SEGMENT: encodeURIComponent escapes `#`, `?`, `%`, space, and
  // unicode (which whole-string encodeURI leaves raw → dropped fragment/query
  // or a decode throw), while keeping `/` as the structural separator. The SW
  // handler decodes symmetrically per segment.
  const base = SYNC_FS_ROUTE_BASE + abs.split('/').map(encodeURIComponent).join('/');
  return op ? `${base}?op=${op}` : base;
}

/**
 * Build a bridge bound to `token`. The token addresses the calling realm's
 * own `{ fs, cwd }` server-side (see `sync-fs-token-registry.ts`).
 */
export function createSyncFsXhrBridge(
  token: string,
  opts: { timeoutMs?: number } = {}
): SyncFsXhrMutatingBridge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Uint8Array,
    op?: SyncFsRouteOp
  ): SyncXhrRequest {
    return {
      method,
      url: routeUrl(path, op),
      token,
      ...(body ? { body } : {}),
      timeoutMs,
      label: `sync-fs bridge, '${path}'`,
    };
  }

  return {
    readFile(path: string): Uint8Array {
      return synchronify(request('GET', path));
    },
    writeFile(path: string, bytes: Uint8Array): void {
      // AT-LEAST-ONCE (see spec §11): a thrown error here means the outcome is
      // UNKNOWN, not that the write did not land — a timeout / SW-eviction can
      // fire AFTER the responder already committed the bytes to the live VFS.
      // The caller must re-read to confirm rather than trust the throw; the
      // shim only advances its cache/baseline (`commitWrite`) on a clean return.
      synchronify(request('POST', path, bytes));
    },
    stat(path: string): SyncFsBridgeStat {
      const json = synchronifyJson(
        request('GET', path, undefined, 'stat')
      ) as Partial<SyncFsBridgeStat> | null;
      if (
        !json ||
        typeof json.isFile !== 'boolean' ||
        typeof json.isDirectory !== 'boolean' ||
        typeof json.size !== 'number'
      ) {
        throw errnoError('EIO', path);
      }
      return {
        isFile: json.isFile,
        isDirectory: json.isDirectory,
        isSymbolicLink: json.isSymbolicLink,
        size: json.size,
      };
    },
    lstat(path: string): SyncFsBridgeStat {
      const json = synchronifyJson(
        request('GET', path, undefined, 'lstat')
      ) as Partial<SyncFsBridgeStat> | null;
      if (
        !json ||
        typeof json.isFile !== 'boolean' ||
        typeof json.isDirectory !== 'boolean' ||
        typeof json.size !== 'number'
      ) {
        throw errnoError('EIO', path);
      }
      return {
        isFile: json.isFile,
        isDirectory: json.isDirectory,
        isSymbolicLink: json.isSymbolicLink,
        size: json.size,
      };
    },
    readdir(path: string): string[] {
      const json = synchronifyJson(request('GET', path, undefined, 'readdir'));
      if (!Array.isArray(json) || !json.every((s) => typeof s === 'string')) {
        throw errnoError('EIO', path);
      }
      return json as string[];
    },
    exists(path: string): boolean {
      // A genuine `exists` returns a JSON boolean (never throws ENOENT — the
      // dispatch answers with `{ok:true, json:false}`). Any errno (EACCES on
      // an out-of-sandbox path, EIO on transport failure) does propagate; the
      // shim wraps this in a try/catch so `existsSync` matches Node's
      // never-throws contract.
      const json = synchronifyJson(request('GET', path, undefined, 'exists'));
      if (typeof json !== 'boolean') throw errnoError('EIO', path);
      return json;
    },
    mkdir(path: string): void {
      synchronify(request('POST', path, undefined, 'mkdir'));
    },
    rm(path: string): void {
      synchronify(request('POST', path, undefined, 'rm'));
    },
  };
}
