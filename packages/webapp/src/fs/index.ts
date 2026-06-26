export type { FsChangeEvent, FsChangeType, FsWatchCallback, FsWatchFilter } from './fs-watcher.js';
export { FsWatcher } from './fs-watcher.js';
export type {
  IndexingStatus,
  MountIndexAbortCause,
  MountIndexEntry,
  MountIndexState,
} from './mount-index.js';
export { MountIndex } from './mount-index.js';
export { joinPath, normalizePath, pathSegments, splitPath } from './path-utils.js';
export { RestrictedFS } from './restricted-fs.js';
export type {
  DirEntry,
  Encoding,
  EntryType,
  FileContent,
  FsErrorCode,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
  WriteFileOptions,
} from './types.js';
export { FsError } from './types.js';
export type { VfsBackend, VirtualFsOptions } from './virtual-fs.js';
export { resolveVfsBackendFromEnv, VirtualFS } from './virtual-fs.js';
