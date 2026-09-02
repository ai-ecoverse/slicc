/**
 * Adapter exposing a {@link VirtualFS} as a `PromiseFsClient` for isomorphic-git.
 *
 * Every method routes through the public `VirtualFS` surface — so
 * mounted directories (File System Access API, S3, DA) are visible to
 * isomorphic-git the same way as the local OPFS/InMemory tree, and the
 * watcher / mount-index notifications fire normally.
 *
 * This adapter previously reached past `VirtualFS` for non-mounted
 * paths via the (now-removed) `getLightningFS()` escape hatch. The
 * fast-path shortcut is gone; `VirtualFS` itself owns symlink
 * resolution and watcher notification for every op.
 *
 * ## The readdir-primed stat cache (issue #2716)
 *
 * isomorphic-git's `readdir` contract is names-only, but almost every caller
 * immediately stats what it listed: `FileSystem.readdirDeep` stats each name
 * to decide whether to recurse, `GitWalkerFs` lstats every workdir entry.
 * Over a hostfs mount each of those is a bridge round trip (plus a CORS
 * preflight) for metadata the `list` response already carried — `git branch`
 * cost 125 requests for 29 refs, 100 of them stats.
 *
 * So every real listing primes a stat cache from the `DirEntry` fields
 * `VirtualFS` now carries, and `stat`/`lstat` answer from it. Its lifetime is
 * the adapter's, which `GitCommands.contextFor` builds per `execute()` — the
 * same scope as the `objectCache` memo below and #2709's read cache above.
 * Any write through this adapter drops the affected path. What it can never
 * do is INVENT a stat: a file is only cached when the listing carried both
 * `size` and `mtime`, because zeroed placeholders are exactly what make
 * `compareStats` call a file stale and rewrite `.git/index` per file (#2708).
 */

import type { VirtualFS } from '../fs/index.js';
import { normalizePath } from '../fs/path-utils.js';
import { type DirEntry, FsError, type Stats, statsFromDirEntry } from '../fs/types.js';

export type PromiseFsClient = { promises: IsoGitFsPromises };

export interface IsoGitFsOptions {
  /**
   * Memoize the `.git/objects` directory lookups isomorphic-git repeats once
   * per object read: the `objects/pack` listing `readObjectPacked` re-reads on
   * every packed lookup, and the `objects/` fan-out listing that decides
   * whether the loose probe `_readObject` always tries first can find anything
   * at all (issue #2712).
   *
   * OFF by default, and deliberately not a switch that can be flipped later:
   * the memo lives exactly as long as the adapter object, so only a caller
   * that builds ONE adapter PER git invocation may turn it on. That is
   * `GitCommands.contextFor()`; two overlapping commands each get their own
   * adapter and therefore never share a view of the object store. A memo that
   * outlived one command would serve a stale view of a repo another writer is
   * changing. Any write through the adapter drops it, so a pack or loose
   * object created mid-command is visible to the next read.
   */
  objectCache?: boolean;
  /**
   * Hard cap on entries primed by a listing for the readdir-primed stat cache
   * (issue #2716; default {@link MAX_CACHED_ENTRIES}). `0` builds the
   * historical BARE adapter — every listing is oversized, so nothing is ever
   * primed and every `stat` goes to the filesystem. Two callers want that: a
   * test measuring the uncached baseline its own assertions are calibrated
   * against, and `GitCacheManager`'s invalidation sampler, which must see the
   * filesystem rather than a memo.
   */
  statCacheMax?: number;
}

/**
 * What {@link createIsomorphicGitFs} returns: the `PromiseFsClient`
 * isomorphic-git takes, plus control over the readdir-primed stat cache.
 */
export interface IsoGitFsClient extends PromiseFsClient {
  /**
   * Drop everything a listing primed. The adapter is already built per git
   * command, so this states the scope boundary rather than creating it — the
   * cache is a within-command optimization, not a filesystem view.
   */
  clearStatCache(): void;
  /**
   * How many entries are primed right now. A diagnostic: it is what makes
   * the cap assertable, since a bounded cache and an unbounded one behave
   * identically until the worker runs out of memory.
   */
  statCacheSize(): number;
}

/**
 * Default cap on primed entries — a hard ceiling, never a soft target. A
 * single command lists at most the directories it walks, so this is a
 * backstop against a pathological tree.
 *
 * Overflow drops the cache rather than growing it: a listing that would push
 * it past the cap clears first (keeping the newest listing rather than
 * pinning the oldest), and a SINGLE listing bigger than the cap clears and
 * primes nothing at all — the cap is the memory budget, so it has to hold
 * even for one 200k-entry directory.
 */
const MAX_CACHED_ENTRIES = 100_000;

/**
 * One cached listing entry. `stats` is absent for a directory the backend
 * described by name only (what the hostfs bridge sends) — enough for the
 * `isDirectory()` question every caller asks of a directory, and directories
 * never appear in `.git/index`, so no stat comparison can see the
 * placeholders {@link toStats} fills in.
 */
interface CachedEntry {
  type: 'file' | 'dir';
  stats?: Stats;
}

export interface IsoGitFsPromises {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: unknown): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<NodeLikeStats>;
  lstat(path: string): Promise<NodeLikeStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

export interface NodeLikeStats {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;
const SYMLINK_MODE = 0o120000;
/** POSIX file-type bits (`S_IFMT`) — the top 4 bits of `st_mode`. */
const TYPE_MASK = 0o170000;
const PERMISSION_MASK = 0o7777;

/**
 * Compose the mode isomorphic-git sees from the entry type VirtualFS
 * resolved and the permission bits the backend reported.
 *
 * The type bits always come from `type`: isomorphic-git decides whether to
 * `readlink` an entry from `mode >> 12`, and VirtualFS is the authority on
 * what the path resolved to. The permission bits come from the backend when
 * it has them, so an executable stays `100755` instead of being flattened to
 * the constant `100644` this used to synthesize (issue #2708).
 */
function composeMode(type: 'file' | 'dir' | 'symlink', rawMode: number | undefined): number {
  const fallback = type === 'dir' ? DIR_MODE : type === 'symlink' ? SYMLINK_MODE : FILE_MODE;
  if (rawMode === undefined) return fallback;
  const permissions = rawMode & PERMISSION_MASK;
  return (fallback & TYPE_MASK) | permissions;
}

/**
 * Build the node-like stats isomorphic-git compares against the index.
 *
 * `compareStats` calls an entry stale unless mode, mtime, ctime, uid, gid,
 * ino AND size all match what the index recorded — so every field that is
 * synthesized rather than reported guarantees a permanent cache miss, which
 * on a `refresh: true` walk means re-hashing the file and rewriting the
 * whole `.git/index`, once per file (issue #2708). Real values are used
 * whenever the filesystem supplied them; the historical placeholders remain
 * as the fallback for backends that expose nothing (S3/DA/AEM mounts).
 */
function toStats(type: 'file' | 'dir' | 'symlink', raw: Partial<NodeLikeStats>): NodeLikeStats {
  const mtimeMs = raw.mtimeMs ?? 0;
  return {
    type,
    mode: composeMode(type, raw.mode),
    size: raw.size ?? 0,
    ino: raw.ino ?? 0,
    mtimeMs,
    ctimeMs: raw.ctimeMs ?? mtimeMs,
    uid: raw.uid ?? 1,
    gid: raw.gid ?? 1,
    dev: 1,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

/** Project a VirtualFS {@link Stats} onto the node-like shape {@link toStats} takes. */
function fromVfsStats(s: Stats): Partial<NodeLikeStats> {
  return {
    size: s.size,
    mtimeMs: s.mtime,
    ctimeMs: s.ctime,
    ...(s.ino !== undefined ? { ino: s.ino } : {}),
    ...(s.uid !== undefined ? { uid: s.uid } : {}),
    ...(s.gid !== undefined ? { gid: s.gid } : {}),
    ...(s.mode !== undefined ? { mode: s.mode } : {}),
  };
}

/**
 * Does this `readFile` options bag ask for text? Exported because the
 * command-scoped read cache keys its entries by the same answer — a utf-8
 * read and a binary read of one path are two different cached values.
 */
export function wantsUtf8(options: unknown): boolean {
  if (typeof options === 'string') return /^utf-?8$/i.test(options);
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string') return /^utf-?8$/i.test(enc);
  }
  return false;
}

/**
 * The `{ start, end }` window of a `readFile` call, if it carries one.
 *
 * isomorphic-git's `FileSystem.read(filepath, options)` passes `options`
 * straight through to this adapter's `readFile`, so accepting the pair here is
 * all a caller needs to read a slice of a packfile instead of the whole thing
 * (issue #2711). `end` is EXCLUSIVE, matching `subarray` and isomorphic-git's
 * own `shasumRange({ start, end })`.
 *
 * isomorphic-git 1.41.9 does not use it yet: `readObjectPacked` calls
 * `fs.read(packFile)` with no options and `GitPackIndex.readSlice` then does
 * `pack.slice(start)` over the whole buffer, so consuming a ranged reader
 * needs an upstream change (see `docs/mounts.md`). The capability is wired
 * from the bridge up to here so that change is the only piece missing.
 */
function readRange(options: unknown): { start: number; end: number } | null {
  if (!options || typeof options !== 'object') return null;
  const { start, end } = options as { start?: unknown; end?: unknown };
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return { start, end };
}

/**
 * Memo tables for one command's `.git/objects` lookups. Both are keyed by the
 * directory path (a process can have several repos open) and hold the pending
 * promise rather than its value, so a fan-out of concurrent object reads
 * shares ONE round trip instead of racing N identical ones.
 */
interface ObjectScope {
  /** `<gitdir>/objects/pack` -> its entry names. */
  packDirs: Map<string, Promise<string[]>>;
  /** `<gitdir>/objects` -> the loose fan-out directory names present in it. */
  fanouts: Map<string, Promise<Set<string>>>;
}

/** The directory isomorphic-git re-lists on every packed object read. */
const PACK_DIR_SUFFIX = '/objects/pack';

/** `<gitdir>/objects/ab/cdef…`; captures the objects dir and the fan-out name. */
const LOOSE_OBJECT_PATH = /^(.*\/objects)\/([0-9a-f]{2})\/[0-9a-f]{38,}$/;

/**
 * Loose fan-out directories under `.git/objects` (`…/objects/ab`). Names-only
 * listings here are the contract: isomorphic-git only wants the names, and
 * asking for stats would `getFile()` every loose object on an FSA mount —
 * the same multiplier #2733 removed from `objects/pack` (#2765).
 */
const LOOSE_FANOUT_DIR = /\/objects\/[0-9a-f]{2}$/;

/**
 * True when a listing of `path` must stay names-only even though most
 * worktree listings ask for stats. Pack and loose fan-out dirs are listed
 * extremely often for names alone; carrying stats there is pure cost.
 */
function isObjectStoreNamesOnlyPath(path: string): boolean {
  return path.endsWith(PACK_DIR_SUFFIX) || LOOSE_FANOUT_DIR.test(path);
}

/** Build an isomorphic-git-compatible PromiseFsClient over a VirtualFS. */
function cacheableEntry(entry: DirEntry): CachedEntry | undefined {
  const stats = statsFromDirEntry(entry);
  if (entry.type === 'directory') return stats ? { type: 'dir', stats } : { type: 'dir' };
  return stats ? { type: 'file', stats } : undefined;
}

/** The readdir-primed stat cache of one adapter (issue #2716). */
interface StatCache {
  /** Record what a fresh listing of `dir` reported about each entry. */
  prime(dir: string, entries: DirEntry[]): void;
  /** The answer for `path`, or undefined to go to the filesystem. */
  get(path: string): NodeLikeStats | undefined;
  drop(path: string): void;
  clear(): void;
  size(): number;
}

/**
 * Build the cache. `maxEntries` is a hard ceiling: `0` disables priming
 * entirely (every listing counts as oversized), which is what a bare adapter
 * and the pack-cache invalidation sampler want.
 *
 * Keys are normalized so a caller that spells the same path differently
 * (`a//b`, `a/./b`) still hits — `VirtualFS` normalizes every path it is
 * handed, so this is the same identity it uses.
 */
function createStatCache(maxEntries: number): StatCache {
  const entriesByPath = new Map<string, CachedEntry>();
  return {
    prime(dir, entries) {
      // One listing bigger than the whole budget: drop everything and prime
      // nothing. Clearing to "make room" and inserting anyway would still
      // leave `entries.length` behind — no cap for the directory needing one.
      if (entries.length > maxEntries) {
        entriesByPath.clear();
        return;
      }
      if (entriesByPath.size + entries.length > maxEntries) entriesByPath.clear();
      const base = normalizePath(dir);
      const prefix = base === '/' ? '/' : `${base}/`;
      for (const entry of entries) {
        const cached = cacheableEntry(entry);
        // A stale hit is worse than a miss: an entry we cannot cache honestly
        // (symlink, half-reported file) also drops what was cached for it.
        if (cached) entriesByPath.set(`${prefix}${entry.name}`, cached);
        else entriesByPath.delete(`${prefix}${entry.name}`);
      }
    },
    get(path) {
      const cached = entriesByPath.get(normalizePath(path));
      if (!cached) return undefined;
      // `stat` and `lstat` share this: the entries that would differ between
      // them (symlinks) are never cached.
      return toStats(cached.type, cached.stats ? fromVfsStats(cached.stats) : {});
    },
    drop(path) {
      entriesByPath.delete(normalizePath(path));
    },
    clear() {
      entriesByPath.clear();
    },
    size() {
      return entriesByPath.size;
    },
  };
}

export function createIsomorphicGitFs(
  vfs: VirtualFS,
  options: IsoGitFsOptions = {}
): IsoGitFsClient {
  const scope: ObjectScope | undefined = options.objectCache
    ? { packDirs: new Map(), fanouts: new Map() }
    : undefined;

  const statCache = createStatCache(Math.max(0, options.statCacheMax ?? MAX_CACHED_ENTRIES));

  /**
   * Every REAL listing this adapter takes, whoever asked for it: the object
   * memo's `objects/pack` and fan-out listings included. Each one primes the
   * stat cache with the fields the backend already reported (#2716); a
   * listing served from the object memo does not, because no new listing was
   * taken.
   *
   * Worktree / refs listings ask for stats so `GitWalkerFs` can skip a
   * follow-up `stat` per entry. Object-store paths stay names-only — packing
   * stats into `objects/pack` (listed ~25,000× per `log --all`) would undo
   * #2733 (#2765).
   */
  const listNames = async (path: string): Promise<string[]> => {
    const entries = await vfs.readDir(
      path,
      isObjectStoreNamesOnlyPath(path) ? undefined : { includeStats: true }
    );
    statCache.prime(path, entries);
    return entries.map((e) => e.name);
  };

  /**
   * Names of the loose fan-out directories under `objectsDir`, listed once per
   * scope.
   */
  const fanoutNames = (active: ObjectScope, objectsDir: string): Promise<Set<string>> => {
    const hit = active.fanouts.get(objectsDir);
    if (hit) return hit;
    const pending = listNames(objectsDir).then((names) => new Set(names));
    active.fanouts.set(objectsDir, pending);
    return pending;
  };

  /**
   * True when `path` is a loose object whose fan-out directory is known to be
   * absent. isomorphic-git's `_readObject` probes the loose path for EVERY
   * object and only falls back to the packfile once that read fails, so on a
   * packed repo it is one wasted round trip per object — 46,696 of them for a
   * single `git log --all` over the hostfs bridge (#2712). One listing of
   * `objects/` answers all of them.
   */
  const isMissingLooseObject = async (path: string): Promise<boolean> => {
    if (!scope) return false;
    const match = LOOSE_OBJECT_PATH.exec(path);
    if (!match) return false;
    try {
      return !(await fanoutNames(scope, match[1])).has(match[2]);
    } catch {
      // Could not list `objects/` — let the real read answer.
      return false;
    }
  };

  /** Any write may add a pack or a loose object, so the memo cannot survive it. */
  const invalidateObjectScope = (): void => {
    scope?.packDirs.clear();
    scope?.fanouts.clear();
  };

  /**
   * Run a mutation of ONE path with both memos dropped around it: the object
   * scope (a write may add a pack or a loose object) and that path's primed
   * stat (its size and mtime just changed).
   */
  const mutatePath = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
    statCache.drop(path);
    return await mutate(op);
  };

  /**
   * Run a mutation with the memo dropped on BOTH sides of it. Dropping it only
   * up front is not enough: a concurrent reader can repopulate the maps while
   * the write is still in flight, and that listing — taken before the write
   * landed — would then outlive it (#2749 review).
   */
  const mutate = async <T>(op: () => Promise<T>): Promise<T> => {
    invalidateObjectScope();
    try {
      return await op();
    } finally {
      invalidateObjectScope();
    }
  };

  const promises: IsoGitFsPromises = {
    async readFile(path, options) {
      // The loose-object shortcut comes first: whether the caller wants the
      // whole file or a window, an object whose fan-out directory does not
      // exist is ENOENT either way, and answering from the memo costs nothing.
      if (await isMissingLooseObject(path)) {
        throw new FsError('ENOENT', 'no such file or directory', path);
      }
      // A window wins over an encoding: a slice of a packfile is bytes, and
      // decoding half a deflate stream as text would be nonsense anyway. A
      // ranged read is still a READ — it must not drop the object memo.
      const range = readRange(options);
      if (range) return await vfs.readFileRange(path, range.start, range.end);
      const content = await vfs.readFile(
        path,
        wantsUtf8(options) ? { encoding: 'utf-8' } : { encoding: 'binary' }
      );
      return content;
    },

    async writeFile(path, data, _options) {
      await mutatePath(path, () => vfs.writeFile(path, data));
    },

    async unlink(path) {
      await mutatePath(path, () => vfs.rm(path));
    },

    async readdir(path) {
      if (!scope || !path.endsWith(PACK_DIR_SUFFIX)) return await listNames(path);
      const hit = scope.packDirs.get(path);
      if (hit) return [...(await hit)];
      const pending = listNames(path);
      scope.packDirs.set(path, pending);
      // Hand out a copy: isomorphic-git sorts the array it is given in place.
      return [...(await pending)];
    },

    async mkdir(path, options) {
      const opts = (options ?? undefined) as { recursive?: boolean } | undefined;
      await mutatePath(path, () =>
        vfs.mkdir(path, opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined)
      );
    },

    async rmdir(path) {
      // `vfs.rm` takes the whole subtree with it, so dropping just this key
      // would leave primed answers for children that no longer exist.
      statCache.clear();
      await mutate(() => vfs.rm(path));
    },

    async stat(path) {
      const primed = statCache.get(path);
      if (primed) return primed;
      const s = await vfs.stat(path);
      return toStats(s.type === 'directory' ? 'dir' : 'file', fromVfsStats(s));
    },

    async lstat(path) {
      const primed = statCache.get(path);
      if (primed) return primed;
      const s = await vfs.lstat(path);
      const type: 'file' | 'dir' | 'symlink' =
        s.type === 'directory' ? 'dir' : s.type === 'symlink' ? 'symlink' : 'file';
      return toStats(type, fromVfsStats(s));
    },

    async readlink(path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      return vfs.readlink(path);
    },

    async symlink(target, path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      await mutatePath(path, () => vfs.symlink(target, path));
    },
  };

  return {
    promises,
    clearStatCache() {
      statCache.clear();
    },
    statCacheSize() {
      return statCache.size();
    },
  };
}
