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
  | 'EIO'; // I/O error — used for transient network failures, 5xx, AbortError-from-timeout

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
