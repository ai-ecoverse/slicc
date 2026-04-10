export { VirtualFS } from './virtual-fs.js';
export type { VirtualFsOptions, BackendType } from './virtual-fs.js';
export { FsError } from './types.js';
export { RestrictedFS } from './restricted-fs.js';
export type {
  FileContent,
  Encoding,
  EntryType,
  Stats,
  DirEntry,
  WriteFileOptions,
  MkdirOptions,
  RmOptions,
  ReadFileOptions,
  FsErrorCode,
} from './types.js';
export { normalizePath, splitPath, pathSegments, joinPath } from './path-utils.js';
export { FsWatcher } from './fs-watcher.js';
export type { FsChangeEvent, FsChangeType, FsWatchFilter, FsWatchCallback } from './fs-watcher.js';
