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

/** A single entry returned by readDir. */
export interface DirEntry {
  name: string;
  type: EntryType;
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
