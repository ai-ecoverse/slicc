/**
 * Command-scoped read cache for the isomorphic-git ↔ VirtualFS adapter.
 *
 * isomorphic-git asks the filesystem the same question once per walked file.
 * `GitWalkerFs.oid()` goes through `GitIndexManager.acquire()`, whose
 * `isIndexStale()` `lstat`s `.git/index` on EVERY call, and
 * `GitIgnoreManager.isIgnored()` re-reads `.git/info/exclude` plus every
 * ancestor `.gitignore` for EVERY untracked candidate. Against a local
 * IndexedDB tree that is merely wasteful; against a `--mount`ed host repo
 * every one of those is an HTTP round trip on the hostfs bridge, which is
 * why a warm `git ls-files` over 3,549 files cost 11.1 s and 16,336 requests
 * — 10,513 of them `stat .git/index` and ~3,500 re-reads of the same four
 * `.gitignore` files (issue #2709).
 *
 * The fix is a memo whose lifetime IS one `GitCommands.execute()` call:
 * {@link createCommandScopedReadCache} builds a wrapper that owns a private
 * memo, and `execute()` builds a fresh one per invocation and threads it
 * through the command context. Nothing is shared between two commands, not
 * even two that overlap in time, so the "no client-side cache, every
 * operation is a live passthrough" contract of the mount backends still holds
 * between commands and the memo is garbage the moment the command returns.
 * Writes made through the wrapper invalidate the paths they touch, so a
 * command that reads, writes and reads again still sees its own effects.
 *
 * A command that writes straight to `VirtualFS` (`ctx.fs`) bypasses this
 * wrapper, so it can only be given an uncached adapter — see
 * `CACHEABLE_COMMANDS` in `git-commands.ts`. Two commands running CONCURRENTLY
 * still race the way two OS processes race on a real checkout (one may observe
 * the tree as it was when it started); the per-invocation memo bounds that to
 * the overlapping window instead of leaking into later commands.
 *
 * Deliberately NOT cached (see the guards below): packfiles and pack indexes
 * (isomorphic-git's own object cache owns those — issues #2710/#2712/#2735),
 * anything above `maxFileBytes`, and any read that failed with something other
 * than a stable "not there" errno — a transient `EIO` from the bridge (#2720)
 * must not be replayed to every later reader.
 */

import { type IsoGitFsPromises, type NodeLikeStats, wantsUtf8 } from './vfs-fs-adapter.js';

/** Ceilings one command's memo may not exceed. */
export interface ReadCacheLimits {
  /**
   * Maximum number of memoized paths across stat, lstat, readdir and readFile
   * — including the negative (`ENOENT`) entries, which carry no bytes and
   * would otherwise be unbounded on a walk that probes thousands of missing
   * loose objects.
   */
  maxEntries: number;
  /** Largest single file kept. Bigger reads are served but not retained. */
  maxFileBytes: number;
  /** Total retained file bytes. Reached → later files stream uncached. */
  maxTotalBytes: number;
}

const DEFAULT_LIMITS: ReadCacheLimits = {
  maxEntries: 50_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * Errno values that answer "what is at this path" permanently enough to
 * memoize. Everything else (notably `EIO`, which the hostfs bridge raises for
 * a dropped connection) is evicted so the next caller retries for real.
 */
const STABLE_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

/** Packfiles and pack indexes are owned by isomorphic-git's object cache. */
function isPackPath(path: string): boolean {
  return path.endsWith('.pack') || path.endsWith('.idx');
}

/** Collapse `//` and drop a trailing `/` so two spellings share one entry. */
function normalizePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
  return collapsed;
}

/** Parent directory of a normalized path (`/a/b` → `/a`, `/a` → `/`). */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash < 0) return '.';
  return slash === 0 ? '/' : path.slice(0, slash);
}

function errorCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Byte cost of a cached read (strings are UTF-16 in memory). */
function byteLengthOf(value: Uint8Array | string): number {
  return typeof value === 'string' ? value.length * 2 : value.byteLength;
}

/** Cache key for a file read — the encoding decides the value's type. */
function fileKey(path: string, utf8: boolean): string {
  return `${utf8 ? 'u' : 'b'} ${path}`;
}

/** One command's memo. Garbage as soon as its command returns. */
class ReadScope {
  readonly stats = new Map<string, Promise<NodeLikeStats>>();
  readonly lstats = new Map<string, Promise<NodeLikeStats>>();
  readonly dirs = new Map<string, Promise<string[]>>();
  readonly files = new Map<string, Promise<Uint8Array | string>>();
  /** Retained byte cost per cached file key, so invalidation can refund it. */
  private readonly fileBytes = new Map<string, number>();
  private retainedBytes = 0;

  constructor(private readonly limits: ReadCacheLimits) {}

  /**
   * True while the memo still has room for another path. Counts EVERY map,
   * so a walk that probes thousands of missing loose objects cannot grow the
   * `files` map without bound just because a miss costs zero bytes.
   */
  hasRoom(): boolean {
    const entries = this.stats.size + this.lstats.size + this.dirs.size + this.files.size;
    return entries < this.limits.maxEntries;
  }

  /** Account for a resolved file read; false means "too big, do not retain". */
  retainFile(key: string, value: Uint8Array | string): boolean {
    const bytes = byteLengthOf(value);
    if (bytes > this.limits.maxFileBytes) return false;
    if (this.retainedBytes + bytes > this.limits.maxTotalBytes) return false;
    this.fileBytes.set(key, bytes);
    this.retainedBytes += bytes;
    return true;
  }

  private dropFile(key: string): void {
    const bytes = this.fileBytes.get(key);
    if (bytes === undefined) return;
    this.fileBytes.delete(key);
    this.retainedBytes -= bytes;
  }

  /** Forget one path's own entries (both read encodings) plus its listing. */
  private forgetSelf(path: string): void {
    this.stats.delete(path);
    this.lstats.delete(path);
    this.dirs.delete(path);
    for (const key of [fileKey(path, true), fileKey(path, false)]) {
      this.files.delete(key);
      this.dropFile(key);
    }
  }

  /**
   * Invalidate everything a write to `path` could have changed: the entry
   * itself, its parent's listing (a create/delete changes the names) and the
   * parent's own stats (its mtime moves with it).
   */
  invalidatePath(rawPath: string): void {
    const path = normalizePath(rawPath);
    this.forgetSelf(path);
    const parent = parentOf(path);
    this.dirs.delete(parent);
    this.stats.delete(parent);
    this.lstats.delete(parent);
  }

  /** Invalidate a path and everything beneath it (directory removal). */
  invalidateSubtree(rawPath: string): void {
    const path = normalizePath(rawPath);
    const prefix = `${path}/`;
    for (const map of [this.stats, this.lstats, this.dirs]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
    for (const key of this.files.keys()) {
      // File keys are `<encoding> <path>` (see fileKey); match the path half.
      if (key.slice(2).startsWith(prefix)) {
        this.files.delete(key);
        this.dropFile(key);
      }
    }
    this.invalidatePath(path);
  }
}

/** Retention hooks for {@link memoize}. */
interface MemoOptions<T> {
  /** Checked on a miss: false means "run it, but do not remember it". */
  admit: () => boolean;
  /** Checked when the value arrives: false drops the entry again. */
  keep?: (value: T) => boolean;
}

/**
 * Memoize `load()` under `key`, evicting the entry again when it settles in a
 * way we must not replay (`keep` said no, or the rejection was not a stable
 * errno). Once stored, the in-flight promise itself is shared, so the
 * `Promise.all` fan-out of a tree walk collapses onto one request even for
 * entries that are dropped later.
 */
function memoize<T>(
  map: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
  options: MemoOptions<T>
): Promise<T> {
  const hit = map.get(key);
  if (hit) return hit;
  const pending = load();
  if (!options.admit()) return pending;
  map.set(key, pending);
  const evict = (): void => {
    if (map.get(key) === pending) map.delete(key);
  };
  void pending.then(
    (value) => {
      if (options.keep && !options.keep(value)) evict();
    },
    (err) => {
      if (!STABLE_ERROR_CODES.has(errorCodeOf(err) ?? '')) evict();
    }
  );
  return pending;
}

/**
 * Wrap an isomorphic-git fs adapter with a read memo that lives exactly as
 * long as the returned object. Build one per `GitCommands.execute()` call and
 * drop it when the command returns; never hold one across commands, and never
 * hand one to a command that writes outside the adapter.
 */
export function createCommandScopedReadCache(
  inner: IsoGitFsPromises,
  limits: Partial<ReadCacheLimits> = {}
): IsoGitFsPromises {
  const scope = new ReadScope({ ...DEFAULT_LIMITS, ...limits });
  const admit = (): boolean => scope.hasRoom();

  /** Copy on the way out: isomorphic-git sorts readdir results in place. */
  const readdir: IsoGitFsPromises['readdir'] = async (path) => {
    const names = await memoize(scope.dirs, normalizePath(path), () => inner.readdir(path), {
      admit,
    });
    return names.slice();
  };

  /**
   * Copy on the way out too: `FileSystem.read()` re-wraps with `Buffer.from`
   * (which copies) but nothing in the fs contract forbids a caller mutating
   * what it was handed, and a poisoned `.git/index` buffer would be a very
   * expensive bug to find.
   */
  const readFile: IsoGitFsPromises['readFile'] = async (path, options) => {
    if (isPackPath(path)) return inner.readFile(path, options);
    const key = fileKey(normalizePath(path), wantsUtf8(options));
    const value = await memoize(scope.files, key, () => inner.readFile(path, options), {
      admit,
      keep: (v) => scope.retainFile(key, v),
    });
    return typeof value === 'string' ? value : new Uint8Array(value);
  };

  const statLike = (
    map: Map<string, Promise<NodeLikeStats>>,
    load: (path: string) => Promise<NodeLikeStats>
  ): ((path: string) => Promise<NodeLikeStats>) => {
    return (path) => memoize(map, normalizePath(path), () => load(path), { admit });
  };

  /** Run a mutating op, then forget whatever it could have changed. */
  const afterWrite = async <T>(path: string, op: () => Promise<T>, subtree = false): Promise<T> => {
    try {
      return await op();
    } finally {
      if (subtree) scope.invalidateSubtree(path);
      else scope.invalidatePath(path);
    }
  };

  return {
    readFile,
    // Pack ranges are already object-sized and owned by isomorphic-git's
    // pack cache; preserve the capability without memoizing them here.
    readFileRange: inner.readFileRange
      ? (path, range) => inner.readFileRange?.(path, range) as Promise<Uint8Array>
      : undefined,
    readdir,
    stat: statLike(scope.stats, (p) => inner.stat(p)),
    lstat: statLike(scope.lstats, (p) => inner.lstat(p)),
    readlink: (path) => inner.readlink(path),
    writeFile: (path, data, options) =>
      afterWrite(path, () => inner.writeFile(path, data, options)),
    unlink: (path) => afterWrite(path, () => inner.unlink(path), true),
    rmdir: (path) => afterWrite(path, () => inner.rmdir(path), true),
    mkdir: (path, options) => afterWrite(path, () => inner.mkdir(path, options)),
    symlink: (target, path) => afterWrite(path, () => inner.symlink(target, path)),
  };
}
