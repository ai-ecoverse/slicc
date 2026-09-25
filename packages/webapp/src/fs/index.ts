export type { FsChangeEvent, FsChangeType, FsWatchCallback, FsWatchFilter } from './fs-watcher.js';
export { FsWatcher } from './fs-watcher.js';
export type { ReadDirOptions } from './mount/backend.js';
export type {
  MountInfo,
  MountProbeFs,
  NameSensitivity,
  UnicodeNormalization,
  UnicodeStorage,
} from './mount/probe-info.js';
export type {
  IndexingStatus,
  MountIndexAbortCause,
  MountIndexEntry,
  MountIndexState,
} from './mount-index.js';
export { MountIndex } from './mount-index.js';
export { joinPath, normalizePath, pathSegments, splitPath } from './path-utils.js';
export type {
  RestrictedFsOptions,
  RestrictedFsWriteEnforcement,
  RestrictedReadAccess,
} from './restricted-fs.js';
export { RestrictedFS } from './restricted-fs.js';
export { sameFileIdentity } from './same-file-identity.js';
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
export { FsError, statsFromDirEntry } from './types.js';
export type { VfsBackend, VirtualFsOptions } from './virtual-fs.js';
export { resolveVfsBackendFromEnv, VirtualFS } from './virtual-fs.js';
