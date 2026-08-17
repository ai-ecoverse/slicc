/**
 * `realm-fs-bridge.ts` — the realm's `fs` surface: the async RPC-backed
 * bridge (`createFsBridge`) and the synchronous cache-backed bridge
 * (`createSyncFsBridge`) that overlays it. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import type { RealmRpcClient } from './realm-rpc.js';
import { normalizePath, type SyncFsCache } from './sync-fs-cache.js';
import type { SyncFsXhrBridge, SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';

type GlobalWithBuffer = typeof globalThis & {
  Buffer?: { from: (data: Uint8Array) => unknown };
};

function realmBuffer(): GlobalWithBuffer['Buffer'] {
  return (globalThis as GlobalWithBuffer).Buffer;
}

/**
 * Stdio access threaded into the fs bridges so the Node idioms
 * `fs.readFileSync(0)` / `fs.writeFileSync(1, …)` / `'/dev/stdin'` work.
 * Built by `runJsRealm` from the realm's buffered stdin + stdout/stderr sinks.
 *
 * `readStdinBytes()` returns the FULL buffered stdin as raw bytes and does
 * NOT consume `process.stdin`'s one-shot flag — the underlying buffer is
 * separable from the shim's `consumed` state, so `readFileSync(0)` and a later
 * `process.stdin.read()` both see the data. (Node drains one shared stream;
 * this is deliberately more forgiving.)
 */
export interface RealmStdioBridge {
  readStdinBytes(): Uint8Array;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

/** Decode a latin1-preserved string (one JS char per byte) back to raw bytes. */
export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Encode raw bytes as a latin1-preserved string (the realm's stdout/stderr pipe format). */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** An `EBADF` error matching the shape of the other sync-fs errors. */
function ebadfErr(verb: string, target: unknown): Error & { code: string } {
  return Object.assign(new Error(`EBADF: bad file descriptor, ${verb} ${String(target)}`), {
    code: 'EBADF',
  });
}

/** The three standard-stream device paths (aliases for fds 0/1/2). */
function isDevStdioPath(path: unknown): path is '/dev/stdin' | '/dev/stdout' | '/dev/stderr' {
  return path === '/dev/stdin' || path === '/dev/stdout' || path === '/dev/stderr';
}

/** Map a path-or-fd arg onto a standard-stream fd, or `undefined` for plain paths. */
function stdioFdFor(pathOrFd: unknown): 0 | 1 | 2 | undefined {
  if (pathOrFd === 0 || pathOrFd === '/dev/stdin') return 0;
  if (pathOrFd === 1 || pathOrFd === '/dev/stdout') return 1;
  if (pathOrFd === 2 || pathOrFd === '/dev/stderr') return 2;
  return undefined;
}

/**
 * Read-direction classifier: fd 0 / `'/dev/stdin'` → `true`; any other
 * numeric fd or a write-side stream device → `EBADF`; plain paths → `false`.
 */
function isStdioReadTarget(pathOrFd: unknown, verb: string): boolean {
  const fd = stdioFdFor(pathOrFd);
  if (fd === 0) return true;
  if (fd !== undefined || typeof pathOrFd === 'number') throw ebadfErr(verb, pathOrFd);
  return false;
}

/**
 * Write-direction classifier: fd 1/2 and their device paths → the matching
 * sink; fd 0 / `'/dev/stdin'` or any other numeric fd → `EBADF`; plain
 * paths → `undefined`.
 */
function stdioWriteSink(
  stdio: RealmStdioBridge,
  pathOrFd: unknown,
  verb: string
): ((text: string) => void) | undefined {
  const fd = stdioFdFor(pathOrFd);
  if (fd === 1) return stdio.writeStdout;
  if (fd === 2) return stdio.writeStderr;
  if (fd !== undefined || typeof pathOrFd === 'number') throw ebadfErr(verb, pathOrFd);
  return undefined;
}

/** Coerce write data to the latin1 string the stdout/stderr pipes carry. */
function stdioText(data: unknown): string {
  return typeof data === 'string' ? data : bytesToLatin1(toBytes(data));
}

/** `readFileSync`-shape decode: utf8 → string, anything else → Buffer/Uint8Array. */
function decodeFileBytes(bytes: Uint8Array, encoding: string | null | undefined): unknown {
  if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(bytes);
  const B = realmBuffer();
  return B ? B.from(bytes) : bytes;
}

/** The encoding carried by a `readFile*` opts arg (string form or `{ encoding }`). */
function encodingOf(
  opts: string | { encoding?: string | null } | null | undefined
): string | null | undefined {
  return typeof opts === 'string' ? opts : opts?.encoding;
}

/**
 * Minimal stat for the standard-stream device paths. `isFile()` is
 * deliberately `true` (scripts commonly gate on it before reading) even
 * though a real `/dev/std*` is a character device — `isCharacterDevice()`
 * reports the honest classification. Size is 0: reporting the buffered
 * stdin length would leak consumption-order effects for no caller benefit.
 */
function devStdioStat() {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isCharacterDevice: () => true,
    size: 0,
  };
}

/**
 * The async-bridge methods {@link overlayAsyncStdio} wraps with fd /
 * `/dev/std*` handling. Structural subset of the `createFsBridge` return.
 */
interface AsyncStdioTargets {
  readFile(path: string, opts?: string | { encoding?: string | null } | null): Promise<unknown>;
  readFileBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: unknown): Promise<true>;
  writeFileBinary(path: string, bytes: Uint8Array): Promise<true>;
  appendFile(path: string, data: unknown): Promise<void>;
  access(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }>;
}

/**
 * Mutate the async `fs` bridge so reads of fd 0 / `'/dev/stdin'` serve the
 * buffered stdin, writes to fds 1/2 (and their device paths) land on
 * stdout/stderr, and the metadata ops report the three stream devices as
 * present. Unknown numeric fds and wrong-direction stream ops throw `EBADF`.
 * Encoding convention mirrors the async surface's own back-compat default
 * (no encoding → decoded text; `null`/`'buffer'` → Buffer), NOT the sync
 * surface's Buffer-by-default. A separate mutating overlay (not inline
 * branches) keeps `createFsBridge` under the function-length lint gate.
 */
function overlayAsyncStdio(bridge: AsyncStdioTargets, stdio: RealmStdioBridge | undefined): void {
  if (!stdio) return;
  const base = {
    readFile: bridge.readFile,
    readFileBinary: bridge.readFileBinary,
    writeFile: bridge.writeFile,
    writeFileBinary: bridge.writeFileBinary,
    appendFile: bridge.appendFile,
    access: bridge.access,
    exists: bridge.exists,
    stat: bridge.stat,
  };
  bridge.readFile = async (path, opts) => {
    if (!isStdioReadTarget(path, 'read')) return base.readFile(path, opts);
    const encoding = encodingOf(opts);
    if (encoding === null || encoding === 'buffer') {
      const B = realmBuffer();
      const bytes = stdio.readStdinBytes();
      return B ? B.from(bytes) : bytes;
    }
    return new TextDecoder().decode(stdio.readStdinBytes());
  };
  bridge.readFileBinary = async (path) =>
    isStdioReadTarget(path, 'read') ? stdio.readStdinBytes() : base.readFileBinary(path);
  bridge.writeFile = async (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (!sink) return base.writeFile(path, data);
    sink(stdioText(data));
    return true;
  };
  bridge.writeFileBinary = async (path, bytes) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (!sink) return base.writeFileBinary(path, bytes);
    sink(bytesToLatin1(bytes));
    return true;
  };
  bridge.appendFile = async (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'append');
    if (!sink) return base.appendFile(path, data);
    sink(stdioText(data));
  };
  bridge.access = async (path) => {
    if (!isDevStdioPath(path)) return base.access(path);
  };
  bridge.exists = async (path) => isDevStdioPath(path) || base.exists(path);
  bridge.stat = async (path) =>
    isDevStdioPath(path) ? { isFile: true, isDirectory: false, size: 0 } : base.stat(path);
}

/** RPC-backed `fs` bridge (the realm's `require('fs')` / `fs` global). */
export function createFsBridge(
  rpc: RealmRpcClient,
  realmFetch: (input: string | URL | Request, opts?: RequestInit) => Promise<Response>,
  stdio?: RealmStdioBridge
) {
  function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new TextEncoder().encode(typeof data === 'string' ? data : String(data));
  }

  async function readFile(
    path: string,
    opts?: string | { encoding?: string | null } | null
  ): Promise<unknown> {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    // null encoding explicitly requests raw bytes (Buffer); no opts or any
    // string encoding returns decoded text. This keeps backwards compat with
    // existing .jsh scripts while matching Node's readFile(path, null) → Buffer.
    if (encoding === null || encoding === 'buffer') {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [path]);
      const B = realmBuffer();
      return B ? B.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) : bytes;
    }
    return rpc.call('vfs', 'readFile', [path]);
  }

  async function writeFile(path: string, data: unknown): Promise<true> {
    if (typeof data === 'string') {
      return rpc.call('vfs', 'writeFile', [path, data]);
    }
    return rpc.call('vfs', 'writeFileBinary', [path, toBytes(data)]);
  }

  async function appendFile(path: string, data: unknown): Promise<void> {
    let existing: Uint8Array = new Uint8Array(0);
    const fileExists = await rpc.call<boolean>('vfs', 'exists', [path]);
    if (fileExists) {
      const raw = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [path]);
      existing = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    }
    const suffix = toBytes(data);
    const out = new Uint8Array(existing.byteLength + suffix.byteLength);
    out.set(existing);
    out.set(suffix, existing.byteLength);
    await rpc.call('vfs', 'writeFileBinary', [path, out]);
  }

  async function cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    const srcStat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [src]
    );
    if (srcStat.isFile) {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
      return;
    }
    if (!srcStat.isDirectory || !opts?.recursive) {
      throw new Error(`cp: '${src}' is a directory (use {recursive: true})`);
    }
    await mkdirSafe(dest);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [src]);
    for (const entry of entries) {
      await cp(`${src}/${entry}`, `${dest}/${entry}`, opts);
    }
  }

  async function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<true> {
    if (opts?.force) {
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) return true;
    }
    const stat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [path]
    );
    if (stat.isFile) return rpc.call('vfs', 'rm', [path]);
    if (!opts?.recursive) throw new Error(`rm: '${path}' is a directory (use {recursive: true})`);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [path]);
    for (const entry of entries) {
      await rm(`${path}/${entry}`, opts);
    }
    return rpc.call('vfs', 'rm', [path]);
  }

  async function mkdirSafe(path: string): Promise<void> {
    await rpc.call('vfs', 'mkdir', [path]);
  }

  async function mkdtemp(prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix =
        Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      const path = `${prefix}${suffix}`;
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) {
        await rpc.call('vfs', 'mkdir', [path]);
        return path;
      }
    }
    throw new Error('mkdtemp: failed to create unique directory after 5 attempts');
  }

  async function rename(oldPath: string, newPath: string): Promise<void> {
    // Use native VFS rename when available; fall back to copy+delete.
    try {
      await rpc.call('vfs', 'rename', [oldPath, newPath]);
    } catch {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [oldPath]);
      await rpc.call('vfs', 'writeFileBinary', [newPath, bytes]);
      await rpc.call('vfs', 'rm', [oldPath]);
    }
  }

  async function access(path: string): Promise<void> {
    const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
    if (!exists)
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {
        code: 'ENOENT',
      });
  }

  const bridge = {
    readFile,
    readFileBinary: (path: string): Promise<Uint8Array> =>
      rpc.call('vfs', 'readFileBinary', [path]),
    writeFile,
    writeFileBinary: (path: string, bytes: Uint8Array): Promise<true> =>
      rpc.call('vfs', 'writeFileBinary', [path, bytes]),
    appendFile,
    cp,
    rm,
    readDir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    readdir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    exists: (path: string): Promise<boolean> => rpc.call('vfs', 'exists', [path]),
    stat: (path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> =>
      rpc.call('vfs', 'stat', [path]),
    mkdir: (path: string, _opts?: { recursive?: boolean }): Promise<true> =>
      rpc.call('vfs', 'mkdir', [path]),
    mkdtemp,
    rename,
    access,
    unlink: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    rmdir: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    copyFile: async (src: string, dest: string): Promise<void> => {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
    },
    fetchToFile: async (url: string, path: string): Promise<number> => {
      const response = await realmFetch(url);
      if (!response.ok) throw new Error(`fetch ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await rpc.call('vfs', 'writeFileBinary', [path, bytes]);
      return bytes.byteLength;
    },
    promises: null as unknown,
  };
  overlayAsyncStdio(bridge, stdio);
  bridge.promises = bridge;
  return bridge;
}

/** An `Error` carrying a POSIX `.code`, matching sync-fs-cache's error shape. */
function syncFsErr(code: string, resolved: string, verb = ''): Error & { code: string } {
  return Object.assign(new Error(`${code}: sync-fs, ${verb ? `${verb} ` : ''}'${resolved}'`), {
    code,
  });
}

/**
 * Cache-first removal with a live-bridge fallback; `false` → genuinely absent,
 * so the caller can raise Node's `ENOENT`.
 *
 * A cache miss is not proof of absence once `execSync` has invalidated the
 * cache (`sync-exec-xhr-bridge`) or the file post-dates the boot snapshot — the
 * live VFS may still hold it, and a cache-only delete would leave it behind
 * while `unlinkSync` reported `ENOENT`. On a miss this deletes live, then
 * tombstones so later reads don't resurrect it through the bridge.
 *
 * Module-level rather than a closure inside `createSyncFsBridge` only to keep
 * that factory under the function-length lint gate.
 */
function removeWithBridgeFallback(
  syncFs: SyncFsCache,
  bridge: SyncFsXhrBridge | undefined,
  resolved: string,
  opts: { recursive?: boolean; requireFile?: boolean } = {}
): boolean {
  const recursive = opts.recursive === true;
  try {
    if (opts.requireFile) syncFs.unlink(resolved);
    else syncFs.rm(resolved, recursive);
    return true;
  } catch (err) {
    // Only a genuine miss falls through — EISDIR / ENOTEMPTY are real Node
    // errors the caller must see.
    if ((err as { code?: string })?.code !== 'ENOENT') throw err;
  }
  const mutating = bridge as SyncFsXhrMutatingBridge | undefined;
  if (!mutating?.rm || syncFs.isTombstoned(resolved)) return false;
  try {
    if (!mutating.exists(resolved)) return false;
  } catch {
    return false;
  }
  mutating.rm(resolved);
  syncFs.markRemoved(resolved, recursive);
  return true;
}

/** The `createSyncFsBridge` internals the removal ops need. See {@link createRemovalOps}. */
interface RemovalDeps {
  syncFs: SyncFsCache;
  bridge: SyncFsXhrBridge | undefined;
  resolve: (p: string) => string;
  existsResolved: (resolved: string) => boolean;
  statResolved: (resolved: string) => {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  };
  lstatResolved: (resolved: string) => {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  };
  readBytes: (resolved: string) => Uint8Array;
  writeThrough: (resolved: string, bytes: Uint8Array) => void;
}

/**
 * The four removal ops, split out of `createSyncFsBridge` purely to keep that
 * factory under the function-length lint gate. All of them go through
 * {@link removeWithBridgeFallback} so a live-only path is really deleted.
 */
function createRemovalOps(deps: RemovalDeps) {
  const {
    syncFs,
    bridge,
    resolve,
    existsResolved,
    lstatResolved,
    statResolved,
    readBytes,
    writeThrough,
  } = deps;
  const remove = (resolved: string, opts?: { recursive?: boolean; requireFile?: boolean }) =>
    removeWithBridgeFallback(syncFs, bridge, resolved, opts);
  return {
    rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
      const resolved = resolve(path);
      // `existsResolved` (not `syncFs.exists`): with `force`, a live-only path
      // must still be removed rather than treated as already gone.
      if (opts?.force && !existsResolved(resolved)) return;
      if (!remove(resolved, { recursive: opts?.recursive === true }) && !opts?.force) {
        throw syncFsErr('ENOENT', resolved, 'rm');
      }
    },
    rmdirSync(path: string, opts?: { recursive?: boolean }): void {
      const resolved = resolve(path);
      // Node's rmdirSync throws ENOTDIR on a non-directory (rmSync does not, and
      // SyncFsCache.rm has no isDirectory guard — it would silently unlink a file).
      if (existsResolved(resolved) && !lstatResolved(resolved).isDirectory) {
        throw syncFsErr('ENOTDIR', resolved, 'rmdir');
      }
      if (!remove(resolved, { recursive: opts?.recursive === true })) {
        throw syncFsErr('ENOENT', resolved, 'rmdir');
      }
    },
    unlinkSync(path: string): void {
      const resolved = resolve(path);
      if (!remove(resolved, { requireFile: true })) throw syncFsErr('ENOENT', resolved, 'unlink');
    },
    renameSync(oldPath: string, newPath: string): void {
      const src = resolve(oldPath);
      const dest = resolve(newPath);
      try {
        syncFs.rename(src, dest);
        return;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') throw err;
      }
      // Cache miss on the source: it may still be live (post-`execSync`
      // invalidate, or created after the snapshot). Copy-then-remove over the
      // bridge — the sync surface has no live `rename` op, and a cache-only
      // rename would lose the file. Directories are out of scope: a recursive
      // live walk on a blocking XHR is prohibitively expensive.
      if (!bridge || syncFs.isTombstoned(src)) throw syncFsErr('ENOENT', src, 'rename');
      if (statResolved(src).isDirectory) throw syncFsErr('EISDIR', src, 'rename');
      writeThrough(dest, readBytes(src));
      if (!remove(src, { requireFile: true })) throw syncFsErr('ENOENT', src, 'rename');
    },
  };
}

/** The stat shape `wrapStat` (and `devStdioStat`) return on the sync surface. */
interface SyncStatLike {
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  size: number;
}

/**
 * The sync-shim methods {@link overlaySyncStdio} wraps with fd /
 * `/dev/std*` handling. Structural subset of the `createSyncFsBridge` return.
 */
interface SyncStdioTargets {
  readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown;
  writeFileSync(path: string, data: unknown): void;
  appendFileSync(path: string, data: unknown): void;
  existsSync(path: string): boolean;
  accessSync(path: string): void;
  statSync(path: string): SyncStatLike;
  lstatSync(path: string): SyncStatLike;
}

/**
 * Mutate the sync `fs` shim so `readFileSync(0)` / `readFileSync('/dev/stdin')`
 * serve the FULL buffered stdin (encoding-aware, same convention as
 * `readFileSync`: utf8 → string, default → Buffer), `writeFileSync` /
 * `appendFileSync` to fd 1/2 (or `/dev/stdout|stderr`) land on the realm's
 * stdout/stderr, and `existsSync` / `accessSync` / `statSync` / `lstatSync`
 * report the three stream devices as present. Wrong-direction stream ops and
 * unknown numeric fds throw `EBADF`. All intercepts run BEFORE `resolve()` —
 * the stream devices never touch the path cache or the live VFS
 * (`/dev/null` has its own VFS-layer handling; not this code's concern).
 * A separate mutating overlay (not inline branches) keeps `createSyncFsBridge`
 * under the function-length lint gate.
 */
function overlaySyncStdio(ops: SyncStdioTargets, stdio: RealmStdioBridge | undefined): void {
  if (!stdio) return;
  const base = {
    readFileSync: ops.readFileSync,
    writeFileSync: ops.writeFileSync,
    appendFileSync: ops.appendFileSync,
    existsSync: ops.existsSync,
    accessSync: ops.accessSync,
    statSync: ops.statSync,
    lstatSync: ops.lstatSync,
  };
  ops.readFileSync = (path, opts) =>
    isStdioReadTarget(path, 'read')
      ? decodeFileBytes(stdio.readStdinBytes(), encodingOf(opts))
      : base.readFileSync(path, opts);
  ops.writeFileSync = (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'write');
    if (sink) sink(stdioText(data));
    else base.writeFileSync(path, data);
  };
  ops.appendFileSync = (path, data) => {
    const sink = stdioWriteSink(stdio, path, 'append');
    if (sink) sink(stdioText(data));
    else base.appendFileSync(path, data);
  };
  ops.existsSync = (path) => isDevStdioPath(path) || base.existsSync(path);
  ops.accessSync = (path) => {
    if (!isDevStdioPath(path)) base.accessSync(path);
  };
  ops.statSync = (path) => (isDevStdioPath(path) ? devStdioStat() : base.statSync(path));
  ops.lstatSync = (path) => (isDevStdioPath(path) ? devStdioStat() : base.lstatSync(path));
}

/** Coerce a `writeFileSync`/`appendFileSync` data arg to bytes (string | typed array). */
function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

/**
 * Synchronous `fs` API surface (`readFileSync`, `writeFileSync`, etc.) backed
 * by the pre-loaded {@link SyncFsCache}. These are plain synchronous
 * functions — the realm's AsyncFunction wrapper cannot `await` an RPC
 * round-trip from a sync call site, so the cache is populated once via a
 * `vfs.snapshot` RPC before user code runs, and mutations are diffed and
 * flushed back via `vfs.flushWrites` after user code completes (see
 * `runJsRealm`). Merged onto `fsBridge` so `require('fs')` exposes both the
 * async and sync method sets, matching Node's `fs` module shape.
 *
 * **Coherence when the SW bridge is enabled** (`bridge` present):
 * `readFileSync` routes through `bridge` on a cache miss (ENOENT) / over-cap
 * (ENOSYNC), and `writeFileSync` writes through to the live VFS then
 * `commitWrite`s the bytes into the cache. So the realm's OWN reads and writes
 * are fully coherent for every op: after `writeFileSync(p)`, `existsSync(p)` /
 * `statSync(p)` / `readdirSync(dir)` / `readFileSync(p)` all reflect the write
 * (commitWrite advances the mutation baseline so it is not double-flushed).
 * The snapshot cache stays a best-effort fast path for the hot working set;
 * reads served from a cache hit skip the bridge round-trip.
 * Mutating metadata ops (mkdir/rm/rename) are cache-backed on a hit — the exec
 * bridge's flush-before-exec pushes their pending cache mutations to `ctx.fs`
 * so a subprocess sees them — but the REMOVALS (`rmSync` / `rmdirSync` /
 * `unlinkSync` / `renameSync`) fall through to the live bridge on a miss. A
 * miss is not proof of absence once `execSync` has invalidated the cache or the
 * file post-dates the snapshot; a cache-only delete would leave the live file
 * behind while reporting `ENOENT`. Read-only metadata ops (stat/exists/readdir)
 * fall through to `bridge` on a cache miss (phase-2), so a file created after
 * the boot snapshot or beyond the entry cap is discovered live rather than
 * silently reported absent. A path deleted in-script keeps its tombstone: the
 * bridge is NOT consulted (read-your-deletes, same guard as readFileSync).
 * Coherence with an EXTERNAL writer (another scoop / async tool) is
 * **exec-boundary-only** — `createExecBridge`'s re-snapshot-after-exec reloads
 * the cache from the live VFS after each `exec`, so a subprocess's writes and
 * any external change become visible then. A cached path mutated by an external
 * writer mid-run (between exec boundaries) can read stale — the same guarantee
 * today's boot-snapshot already gives, not a regression. This is the committed
 * policy (spec §4 / §12): no FsWatcher eviction.
 *
 * **Stdio targets** (`stdio` threaded by `runJsRealm`): fds 0/1/2 and
 * `/dev/std{in,out,err}` are intercepted BEFORE `resolve()` and never touch
 * the cache or the live VFS — see {@link overlaySyncStdio}.
 */
export function createSyncFsBridge(
  syncFs: SyncFsCache,
  cwd: string,
  bridge?: SyncFsXhrBridge,
  stdio?: RealmStdioBridge
) {
  function resolve(p: string): string {
    // Lexically normalize ('.'/'..') so the bridge URL carries a clean absolute
    // path — the URL layer would otherwise collapse dot-segments before the SW
    // decodes, diverging from the async vfs path (which clamps '..' at root then
    // ACL-checks). Keeps the sync and async fs surfaces consistent.
    return normalizePath(p.startsWith('/') ? p : cwd + (cwd.endsWith('/') ? '' : '/') + p);
  }

  // ── Shared primitives (used by both the raw ops and the derived ones) ──
  /** Raw bytes with the cache→bridge fallback. Throws (with `.code`) on a genuine miss. */
  function readBytes(resolved: string): Uint8Array {
    try {
      return syncFs.readFile(resolved);
    } catch (err) {
      // Cache miss (ENOENT: created after the snapshot) or over-cap (ENOSYNC) →
      // fall back to the live SW bridge when enabled. Read-your-deletes: a path
      // deleted in-script must stay ENOENT — do NOT resurrect the still-live,
      // not-yet-flushed file via the bridge.
      const code = (err as { code?: string })?.code;
      if (bridge && !syncFs.isTombstoned(resolved) && (code === 'ENOENT' || code === 'ENOSYNC')) {
        return bridge.readFile(resolved);
      }
      throw err;
    }
  }
  /** Write-through to the live VFS + commit into the cache (read-after-write coherent). */
  function writeThrough(resolved: string, bytes: Uint8Array): void {
    if (bridge) {
      // commitWrite advances the mutation baseline, so this is NOT re-flushed —
      // deliberately NOT syncFs.writeFile (which would record a mutation the
      // end-of-run flush re-applies, double-writing).
      bridge.writeFile(resolved, bytes);
      syncFs.commitWrite(resolved, bytes);
    } else {
      syncFs.writeFile(resolved, bytes);
    }
  }
  function existsResolved(resolved: string): boolean {
    if (syncFs.exists(resolved)) return true;
    // Node's `existsSync` never throws — a live check that would surface
    // EACCES/EIO degrades to `false`. Read-your-deletes: a deleted path stays absent.
    if (!bridge || syncFs.isTombstoned(resolved)) return false;
    try {
      return bridge.exists(resolved);
    } catch {
      return false;
    }
  }
  function statResolved(resolved: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  } {
    try {
      return syncFs.stat(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!bridge || syncFs.isTombstoned(resolved) || code !== 'ENOENT') throw err;
      return bridge.stat(resolved);
    }
  }
  function readdirResolved(resolved: string): string[] {
    try {
      return syncFs.readdir(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!bridge || syncFs.isTombstoned(resolved) || code !== 'ENOENT') throw err;
      return bridge.readdir(resolved);
    }
  }
  function lstatResolved(resolved: string) {
    try {
      return syncFs.lstat(resolved);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!bridge || syncFs.isTombstoned(resolved) || code !== 'ENOENT') throw err;
      return bridge.lstat(resolved);
    }
  }
  const wrapStat = (s: {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink?: boolean;
    size: number;
  }) => ({
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink === true,
    isCharacterDevice: () => false,
    size: s.size,
  });
  const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  /** Recursive copy over the resolved paths (file → copy; dir → mkdir + walk). */
  function copyTree(srcR: string, destR: string): void {
    if (!statResolved(srcR).isDirectory) {
      // Copy the body via the SAME cache→bridge read + write-through the other
      // methods use — NOT `syncFs.copyFile` (cache-only, no `truncated` guard),
      // which would silently 0-byte-copy an over-cap source and ENOENT a
      // live-only (post-snapshot) source. `readBytes` bridges on ENOENT/ENOSYNC.
      writeThrough(destR, readBytes(srcR));
      return;
    }
    syncFs.mkdir(destR, true);
    for (const name of readdirResolved(srcR)) copyTree(join(srcR, name), join(destR, name));
  }

  const ops = {
    ...createRemovalOps({
      syncFs,
      bridge,
      resolve,
      existsResolved,
      statResolved,
      lstatResolved,
      readBytes,
      writeThrough,
    }),
    readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown {
      // utf8 → string; default/other → Buffer (realm polyfill) or Uint8Array.
      return decodeFileBytes(readBytes(resolve(path)), encodingOf(opts));
    },
    writeFileSync(path: string, data: unknown): void {
      writeThrough(resolve(path), toBytes(data));
    },
    appendFileSync(path: string, data: unknown): void {
      // Read-modify-write over the same cache→bridge path (mirrors the async
      // `appendFile`). NOT atomic vs a concurrent writer — same at-least-once
      // caveat as `writeFileSync` (spec §11). An absent file is created.
      const resolved = resolve(path);
      let existing: Uint8Array = new Uint8Array(0);
      try {
        existing = readBytes(resolved);
      } catch (err) {
        if ((err as { code?: string })?.code !== 'ENOENT') throw err;
      }
      const suffix = toBytes(data);
      const out = new Uint8Array(existing.byteLength + suffix.byteLength);
      out.set(existing);
      out.set(suffix, existing.byteLength);
      writeThrough(resolved, out);
    },
    truncateSync(path: string, len = 0): void {
      const resolved = resolve(path);
      const cur = readBytes(resolved); // ENOENT if missing (Node parity)
      const out = new Uint8Array(len);
      out.set(cur.subarray(0, Math.min(len, cur.byteLength)));
      writeThrough(resolved, out);
    },
    existsSync(path: string): boolean {
      return existsResolved(resolve(path));
    },
    accessSync(path: string): void {
      // VFS has no permission bits — access reduces to existence.
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'access');
    },
    mkdirSync(path: string, opts?: { recursive?: boolean }): void {
      syncFs.mkdir(resolve(path), opts?.recursive);
    },
    statSync: (path: string) => wrapStat(statResolved(resolve(path))),
    lstatSync: (path: string) => wrapStat(lstatResolved(resolve(path))),
    realpathSync(path: string): string {
      // No symlinks → the canonical path is the lexical resolution; verify it exists.
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'realpath');
      return resolved;
    },
    readdirSync(path: string): string[] {
      return readdirResolved(resolve(path));
    },
    copyFileSync(src: string, dest: string): void {
      // Bridge-aware copy (see copyTree): reading via `readBytes` + `writeThrough`
      // copies an over-cap or live-only (post-snapshot) source correctly, instead
      // of the silent 0-byte / ENOENT the cache-only `syncFs.copyFile` produces.
      writeThrough(resolve(dest), readBytes(resolve(src)));
    },
    cpSync(src: string, dest: string): void {
      copyTree(resolve(src), resolve(dest));
    },
    chmodSync(path: string): void {
      // VFS has no mode bits — a no-op, but keep Node's ENOENT-on-missing contract.
      const resolved = resolve(path);
      if (!existsResolved(resolved)) throw syncFsErr('ENOENT', resolved, 'chmod');
    },
    mkdtempSync(prefix: string): string {
      return syncFs.mkdtemp(resolve(prefix));
    },
  };
  overlaySyncStdio(ops, stdio);
  return ops;
}
