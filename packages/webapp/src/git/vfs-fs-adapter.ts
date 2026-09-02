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
 */

import type { VirtualFS } from '../fs/index.js';
import { FsError, type Stats } from '../fs/types.js';

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

/** Build an isomorphic-git-compatible PromiseFsClient over a VirtualFS. */
export function createIsomorphicGitFs(
  vfs: VirtualFS,
  options: IsoGitFsOptions = {}
): PromiseFsClient {
  const scope: ObjectScope | undefined = options.objectCache
    ? { packDirs: new Map(), fanouts: new Map() }
    : undefined;

  const listNames = async (path: string): Promise<string[]> =>
    (await vfs.readDir(path)).map((e) => e.name);

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
      await mutate(() => vfs.writeFile(path, data));
    },

    async unlink(path) {
      await mutate(() => vfs.rm(path));
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
      await mutate(() =>
        vfs.mkdir(path, opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined)
      );
    },

    async rmdir(path) {
      await mutate(() => vfs.rm(path));
    },

    async stat(path) {
      const s = await vfs.stat(path);
      return toStats(s.type === 'directory' ? 'dir' : 'file', fromVfsStats(s));
    },

    async lstat(path) {
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
      await mutate(() => vfs.symlink(target, path));
    },
  };

  return { promises };
}
