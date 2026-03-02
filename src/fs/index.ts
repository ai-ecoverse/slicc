export { VirtualFS } from './virtual-fs.js';
export type { VirtualFsOptions, BackendType } from './virtual-fs.js';
export { OpfsBackend } from './opfs-backend.js';
export { IndexedDbBackend } from './indexeddb-backend.js';
export { FsError } from './types.js';
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
  StorageBackend,
  FsErrorCode,
} from './types.js';
export {
  normalizePath,
  splitPath,
  pathSegments,
  joinPath,
} from './path-utils.js';
