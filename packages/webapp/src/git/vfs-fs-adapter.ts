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
import { type DirEntry, FsError, type Stats } from '../fs/types.js';

export type PromiseFsClient = { promises: IsoGitFsPromises };

export interface IsoGitDirEntry {
  name: string;
  stats?: NodeLikeStats;
}

export interface IsoGitFsPromises {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** Internal metadata-bearing companion used by the command-scoped cache. */
  readdirWithStats?(path: string): Promise<IsoGitDirEntry[]>;
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

/** Convert complete readDir metadata into a stat answer; incomplete rows fall back to stat(). */
function fromDirEntry(entry: DirEntry): NodeLikeStats | undefined {
  if (entry.size === undefined || entry.mtime === undefined) return undefined;
  const type = entry.type === 'directory' ? 'dir' : entry.type;
  return toStats(type, {
    size: entry.size,
    mtimeMs: entry.mtime,
    ctimeMs: entry.ctime,
    ...(entry.ino !== undefined ? { ino: entry.ino } : {}),
    ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
    ...(entry.gid !== undefined ? { gid: entry.gid } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
  });
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

/** Build an isomorphic-git-compatible PromiseFsClient over a VirtualFS. */
export function createIsomorphicGitFs(vfs: VirtualFS): PromiseFsClient {
  const readdirWithStats = async (path: string): Promise<IsoGitDirEntry[]> => {
    const entries = await vfs.readDir(path);
    return entries.map((entry) => ({ name: entry.name, stats: fromDirEntry(entry) }));
  };

  const promises: IsoGitFsPromises = {
    async readFile(path, options) {
      const content = await vfs.readFile(
        path,
        wantsUtf8(options) ? { encoding: 'utf-8' } : { encoding: 'binary' }
      );
      return content;
    },

    async writeFile(path, data, _options) {
      await vfs.writeFile(path, data);
    },

    async unlink(path) {
      await vfs.rm(path);
    },

    async readdir(path) {
      return (await readdirWithStats(path)).map((entry) => entry.name);
    },

    readdirWithStats,

    async mkdir(path, options) {
      const opts = (options ?? undefined) as { recursive?: boolean } | undefined;
      await vfs.mkdir(
        path,
        opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined
      );
    },

    async rmdir(path) {
      await vfs.rm(path);
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
      await vfs.symlink(target, path);
    },
  };

  return { promises };
}
