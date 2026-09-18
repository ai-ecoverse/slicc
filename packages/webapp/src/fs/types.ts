export type FileContent = string | Uint8Array;

export type Encoding = 'utf-8' | 'binary';

export type EntryType = 'file' | 'directory' | 'symlink';

export interface Stats {
  identity?: string;
  type: EntryType;
  size: number;

  mtime: number;

  ctime: number;

  isSymlink?: boolean;

  symlinkTarget?: string;

  ino?: number;

  dev?: number;

  uid?: number;

  gid?: number;

  mode?: number;
}

export interface DirEntryStats {
  identity?: string;
  size?: number;

  mtime?: number;

  ctime?: number;
  ino?: number;
  dev?: number;
  uid?: number;
  gid?: number;

  mode?: number;
}

export interface DirEntry extends DirEntryStats {
  name: string;
  type: EntryType;
}

export function statsFromDirEntry(entry: DirEntry): Stats | undefined {
  if (entry.type === 'symlink') return undefined;
  if (entry.size === undefined || entry.mtime === undefined) return undefined;
  return {
    type: entry.type,
    size: entry.size,
    mtime: entry.mtime,
    ctime: entry.ctime ?? entry.mtime,
    ...(entry.ino !== undefined ? { ino: entry.ino } : {}),
    ...(entry.identity !== undefined ? { identity: entry.identity } : {}),
    ...(entry.dev !== undefined ? { dev: entry.dev } : {}),
    ...(entry.uid !== undefined ? { uid: entry.uid } : {}),
    ...(entry.gid !== undefined ? { gid: entry.gid } : {}),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
  };
}

export interface WriteFileOptions {
  recursive?: boolean;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
}

export interface ReadFileOptions {
  encoding?: Encoding;
}

export type FsChangeType = 'create' | 'modify' | 'delete';

export interface FsChangeEvent {
  type: FsChangeType;
  path: string;
  entryType?: EntryType;
}

export type FsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'ENOTEMPTY'
  | 'EINVAL'
  | 'EACCES'
  | 'ELOOP'
  | 'EBUSY'
  | 'EFBIG'
  | 'EBADF'
  | 'ENOSYS'
  | 'EOPNOTSUPP'
  | 'EIO';

export interface FsStatsLike {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;

  ino?: number;

  dev?: number;

  uid?: number;

  gid?: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

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
