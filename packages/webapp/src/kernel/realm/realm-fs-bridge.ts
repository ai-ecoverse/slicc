/**
 * `realm-fs-bridge.ts` — the realm's `fs` surface: the async RPC-backed
 * bridge (`createFsBridge`) and the synchronous cache-backed bridge
 * (`createSyncFsBridge`) that overlays it. Extracted from
 * `js-realm-shared.ts`; no behavior change.
 */
import type { RealmRpcClient } from './realm-rpc.js';
import { normalizePath, type SyncFsCache } from './sync-fs-cache.js';
import type { SyncFsXhrBridge, SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';

interface RealmGlobalWithBuffer {
  Buffer?: { from: (data: Uint8Array) => unknown };
}

function realmBuffer(): RealmGlobalWithBuffer['Buffer'] {
  return (globalThis as typeof globalThis & RealmGlobalWithBuffer).Buffer;
}

/** RPC-backed `fs` bridge (the realm's `require('fs')` / `fs` global). */
export function createFsBridge(
  rpc: RealmRpcClient,
  realmFetch: (input: string | URL | Request, opts?: RequestInit) => Promise<Response>
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
  readBytes: (resolved: string) => Uint8Array;
  writeThrough: (resolved: string, bytes: Uint8Array) => void;
}

/**
 * The four removal ops, split out of `createSyncFsBridge` purely to keep that
 * factory under the function-length lint gate. All of them go through
 * {@link removeWithBridgeFallback} so a live-only path is really deleted.
 */
function createRemovalOps(deps: RemovalDeps) {
  const { syncFs, bridge, resolve, existsResolved, statResolved, readBytes, writeThrough } = deps;
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
      // rmdir never follows the final component. A symlink is not a directory,
      // even when its target is one, so target contents cannot trigger ENOTEMPTY.
      const stat = existsResolved(resolved) ? statResolved(resolved) : null;
      if (stat && (!stat.isDirectory || stat.isSymbolicLink)) {
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
      if (bridge.stat(src).isDirectory) throw syncFsErr('EISDIR', src, 'rename');
      writeThrough(dest, readBytes(src));
      if (!remove(src, { requireFile: true })) throw syncFsErr('ENOENT', src, 'rename');
    },
  };
}

/** Coerce a `writeFileSync`/`appendFileSync` data arg to bytes (string | typed array). */
function createStats(stat: {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size: number;
}) {
  return {
    isFile: () => stat.isFile,
    isDirectory: () => stat.isDirectory,
    isSymbolicLink: () => stat.isSymbolicLink === true,
    size: stat.size,
  };
}

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
 */
export function createSyncFsBridge(syncFs: SyncFsCache, cwd: string, bridge?: SyncFsXhrBridge) {
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
  function lstatResolved(resolved: string): {
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
  } {
    return syncFs.stat(resolved);
  }
  function statResolved(resolved: string): { isFile: boolean; isDirectory: boolean; size: number } {
    try {
      const cached = lstatResolved(resolved);
      // Snapshot links need the live bridge: stat follows; lstat below does not.
      if (!cached.isSymbolicLink) return cached;
      if (!bridge || syncFs.isTombstoned(resolved)) throw syncFsErr('ENOSYNC', resolved, 'stat');
      return bridge.stat(resolved);
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

  return {
    ...createRemovalOps({
      syncFs,
      bridge,
      resolve,
      existsResolved,
      statResolved: lstatResolved,
      readBytes,
      writeThrough,
    }),
    readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown {
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      const bytes = readBytes(resolve(path));
      if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(bytes);
      // Return Buffer if available (realm polyfill), else Uint8Array.
      const B = realmBuffer();
      return B ? B.from(bytes) : bytes;
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
    statSync(path: string): {
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
      size: number;
    } {
      return createStats(statResolved(resolve(path)));
    },
    lstatSync(path: string): {
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
      size: number;
    } {
      return createStats(lstatResolved(resolve(path)));
    },
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
}
