/**
 * Shared types for the virtual filesystem layer.
 */

/** File content can be a string (text) or binary data. */
export type FileContent = string | Uint8Array;

/** Encoding option for readFile. */
export type Encoding = 'utf-8' | 'binary';

/** Type of a filesystem entry. */
export type EntryType = 'file' | 'directory' | 'symlink';

/** Metadata about a filesystem entry. */
export interface Stats {
  type: EntryType;
  size: number;
  /** Last modification time (ms since epoch). */
  mtime: number;
  /** Creation time (ms since epoch). */
  ctime: number;
  /** True if this entry is a symlink (only set by lstat). */
  isSymlink?: boolean;
  /** Raw symlink target path (only set when isSymlink is true). */
  symlinkTarget?: string;
  /**
   * Backing inode number, when the backend can name one. ZenFS allocates a
   * unique `ino` per entry that survives rewrites, so it is the one field
   * that distinguishes "the same file" from "the same path" — which is what
   * TOCTOU-hardened commands need (`split` refuses to commit unless the
   * input it read is still the file it identified; without an inode it
   * cannot tell and fails closed — see `shell/vfs-adapter.ts#toIdentity`).
   *
   * Absent for the remote mount backends (S3/DA/AEM expose only
   * `{kind, size, mtime}`) and for the synthetic `/dev` entries, so
   * consumers must treat it as best-effort, never as a required key. The
   * hostfs bridge DOES report it — see {@link Stats.mode}.
   */
  ino?: number;
  /**
   * Owning user id, when the backend knows one (hostfs). Best-effort.
   */
  uid?: number;
  /**
   * Owning group id, when the backend knows one (hostfs). Best-effort.
   */
  gid?: number;
  /**
   * Full POSIX `st_mode` (type bits included), when the backend knows one.
   *
   * Together with {@link Stats.ino}, {@link Stats.uid}, {@link Stats.gid}
   * and a real {@link Stats.ctime} this is what lets isomorphic-git's
   * `compareStats` decide a working-tree file still matches its index entry.
   * Without them every read-only git command over a mount re-hashes the tree
   * and rewrites `.git/index` once per file (issue #2708). It also carries
   * the executable bit, which the git adapter would otherwise flatten to
   * `100644`.
   */
  mode?: number;
}

/**
 * Stat fields a backend reported ALONGSIDE the directory listing, so a
 * consumer that needs them does not have to stat the entry it just listed.
 *
 * Every field is optional and best-effort: the hostfs bridge reports the full
 * set for files (and nothing but the name for a directory or a raced entry),
 * the FSA/local path reports what `lstat` gave it, and the remote mounts
 * report only what their listing carries. A consumer that finds a field
 * missing must fall back to a real `stat()` — never to a placeholder.
 *
 * The contract a backend has to keep is that these numbers are the SAME ones
 * its `stat()` would report for that path. Consumers (the isomorphic-git
 * adapter's readdir-primed cache, the shell's `ls -l`, the Files panel) use
 * them IN PLACE OF a stat, so a listing that disagrees with `stat` is a bug
 * in the backend, not something the consumer can detect. See
 * {@link statsFromDirEntry}, which is the one place that decides whether a
 * listing carries enough to stand in for a stat.
 */
export interface DirEntryStats {
  size?: number;
  /** Last modification time (ms since epoch). */
  mtime?: number;
  /** Inode-change time (ms since epoch). */
  ctime?: number;
  ino?: number;
  uid?: number;
  gid?: number;
  /** Full POSIX `st_mode`, type bits included. */
  mode?: number;
}

/** A single entry returned by readDir. */
export interface DirEntry extends DirEntryStats {
  name: string;
  type: EntryType;
}

/**
 * Promote a {@link DirEntry} to the {@link Stats} a `stat()` of that path
 * would have returned, or `undefined` when the listing did not carry enough.
 *
 * This is the N+1 fix for issue #2716: `/api/hostfs/list` already stats every
 * entry server-side, so a consumer that re-stats each listed name pays a full
 * bridge round trip (plus a CORS preflight) per file — 100 stats for a 29-ref
 * `git branch`, one per file for the Files panel, one per entry for `ls -l`.
 *
 * Two entry classes deliberately yield `undefined`:
 *   - **symlinks**, because the listing describes the LINK and a `stat()`
 *     would describe its target — they are not interchangeable; and
 *   - anything without both `size` and `mtime`, because the historical
 *     placeholders (`0`) are exactly what makes isomorphic-git call a file
 *     stale and rewrite `.git/index` per file (issue #2708). Falling through
 *     to a real stat is slow; answering with zeros is wrong.
 *
 * `ctime` falls back to `mtime`, matching what `VirtualFS.stat` does for a
 * backend with no inode behind the entry.
 */
export function statsFromDirEntry(entry: DirEntry): Stats | undefined {
  if (entry.type === 'symlink') return undefined;
  if (entry.size === undefined || entry.mtime === undefined) return undefined;
  return {
    type: entry.type,
    size: entry.size,
    mtime: entry.mtime,
    ctime: entry.ctime ?? entry.mtime,
    ...(entry.ino !== undefined ? { ino: entry.ino } : {}),
    ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
    ...(entry.gid !== undefined ? { gid: entry.gid } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
  };
}

/** Options for writeFile. */
export interface WriteFileOptions {
  /** Create parent directories if they don't exist. Default: false. */
  recursive?: boolean;
}

/** Options for mkdir. */
export interface MkdirOptions {
  /** Create parent directories if they don't exist. Default: false. */
  recursive?: boolean;
}

/** Options for rm. */
export interface RmOptions {
  /** Remove directories and their contents recursively. Default: false. */
  recursive?: boolean;
}

/** Options for readFile. */
export interface ReadFileOptions {
  encoding?: Encoding;
}

/** Filesystem error codes, mirroring common POSIX errno values. */
/** What happened to a path. Consumed by `FsWatcher` and its subscribers. */
export type FsChangeType = 'create' | 'modify' | 'delete';

/**
 * One filesystem change, as `VirtualFS` reports it to a watcher.
 *
 * Lives here rather than in `fs-watcher.ts` because consumers as far out as
 * the kernel's `LocalVfsClient` name it, and `fs-watcher.ts` has a value
 * import of the logger — which drags the `__DEV__` global into tsconfigs that
 * do not declare it (`packages/webcomponents`). `types.ts` imports nothing.
 */
export interface FsChangeEvent {
  type: FsChangeType;
  path: string;
  entryType?: EntryType;
}

export type FsErrorCode =
  | 'ENOENT' // No such file or directory
  | 'EEXIST' // File/dir already exists
  | 'ENOTDIR' // Not a directory
  | 'EISDIR' // Is a directory (when file expected)
  | 'ENOTEMPTY' // Directory not empty
  | 'EINVAL' // Invalid argument
  | 'EACCES' // Permission denied
  | 'ELOOP' // Too many levels of symbolic links
  | 'EBUSY' // Resource busy — used for 412 concurrent-write conflicts on remote mounts
  | 'EFBIG' // File too large — used when remote-mount body exceeds maxBodyBytes
  | 'EBADF' // Bad file descriptor — used when an op runs against a closed/unmounted backend
  | 'ENOSYS' // Not implemented — the backend genuinely lacks the capability (e.g. no FsWatcher)
  | 'EIO'; // I/O error — used for transient network failures, 5xx, AbortError-from-timeout

/**
 * Structural subset of `node:fs` `Stats` consumed by VirtualFS internals
 * (symlink resolution + the sync fast path). Kept loose so LightningFS' and
 * ZenFS' differing stats shapes both satisfy it without adaptation.
 */
export interface FsStatsLike {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Inode number. Optional: LightningFS' legacy shape omits it, ZenFS sets it. */
  ino?: number;
  /** Owning user id. Optional: only ZenFS' shape carries it. */
  uid?: number;
  /** Owning group id. Optional: only ZenFS' shape carries it. */
  gid?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Custom error class for filesystem operations. */
export class FsError extends Error {
  constructor(
    public readonly code: FsErrorCode,
    message: string,
    public readonly path?: string
  ) {
    super(`${code}: ${message}${path ? ` '${path}'` : ''}`);
    this.name = 'FsError';
  }
}
