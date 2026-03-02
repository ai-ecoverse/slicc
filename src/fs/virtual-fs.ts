/**
 * VirtualFS — POSIX-like virtual filesystem for the browser.
 *
 * Auto-detects OPFS support and falls back to IndexedDB.
 * Provides a clean async API for file and directory operations.
 */

import type {
  DirEntry,
  Encoding,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
  StorageBackend,
  WriteFileOptions,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath, splitPath } from './path-utils.js';
import { OpfsBackend } from './opfs-backend.js';
import { IndexedDbBackend } from './indexeddb-backend.js';

export type BackendType = 'opfs' | 'indexeddb';

export interface VirtualFsOptions {
  /** Force a specific backend instead of auto-detecting. */
  backend?: BackendType;
  /** Custom database name for IndexedDB backend. */
  dbName?: string;
}

export class VirtualFS {
  private backend: StorageBackend;
  private backendType: BackendType;

  private constructor(backend: StorageBackend, backendType: BackendType) {
    this.backend = backend;
    this.backendType = backendType;
  }

  /** Create a VirtualFS instance, auto-detecting the best backend. */
  static async create(options?: VirtualFsOptions): Promise<VirtualFS> {
    if (options?.backend === 'opfs') {
      return new VirtualFS(new OpfsBackend(), 'opfs');
    }

    if (options?.backend === 'indexeddb') {
      return new VirtualFS(new IndexedDbBackend(options?.dbName), 'indexeddb');
    }

    // Auto-detect: prefer OPFS if available
    if (await VirtualFS.isOpfsAvailable()) {
      return new VirtualFS(new OpfsBackend(), 'opfs');
    }

    return new VirtualFS(new IndexedDbBackend(options?.dbName), 'indexeddb');
  }

  /** Check if OPFS is available in the current browser. */
  static async isOpfsAvailable(): Promise<boolean> {
    try {
      if (typeof navigator === 'undefined') return false;
      if (!navigator.storage?.getDirectory) return false;
      // Try to actually get the root — some browsers have the API but it's non-functional
      await navigator.storage.getDirectory();
      return true;
    } catch {
      return false;
    }
  }

  /** Get the active backend type. */
  getBackendType(): BackendType {
    return this.backendType;
  }

  /**
   * Read a file's content.
   * @throws FsError ENOENT if file doesn't exist, EISDIR if path is a directory
   */
  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    return this.backend.readFile(normalizePath(path), options?.encoding ?? 'utf-8');
  }

  /**
   * Write content to a file. Creates the file if it doesn't exist.
   * Parent directories are created automatically.
   * @throws FsError EISDIR if path is an existing directory
   */
  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions,
  ): Promise<void> {
    return this.backend.writeFile(normalizePath(path), content);
  }

  /**
   * List entries in a directory.
   * @throws FsError ENOENT if directory doesn't exist, ENOTDIR if path is a file
   */
  async readDir(path: string): Promise<DirEntry[]> {
    return this.backend.readDir(normalizePath(path));
  }

  /**
   * Create a directory.
   * @throws FsError EEXIST if directory already exists (non-recursive),
   *                 ENOENT if parent doesn't exist (non-recursive)
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.backend.mkdir(normalizePath(path), options);
  }

  /**
   * Remove a file or directory.
   * @throws FsError ENOENT if path doesn't exist,
   *                 ENOTEMPTY if directory is not empty (non-recursive)
   */
  async rm(path: string, options?: RmOptions): Promise<void> {
    return this.backend.rm(normalizePath(path), options);
  }

  /**
   * Get metadata about a file or directory.
   * @throws FsError ENOENT if path doesn't exist
   */
  async stat(path: string): Promise<Stats> {
    return this.backend.stat(normalizePath(path));
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    return this.backend.exists(normalizePath(path));
  }

  /**
   * Rename or move a file/directory.
   * @throws FsError ENOENT if source doesn't exist
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.backend.rename(normalizePath(oldPath), normalizePath(newPath));
  }

  /**
   * Read a file as a string (convenience method).
   * @throws FsError ENOENT if file doesn't exist
   */
  async readTextFile(path: string): Promise<string> {
    const content = await this.readFile(path, { encoding: 'utf-8' });
    return content as string;
  }

  /**
   * Recursively walk a directory tree, yielding all file paths.
   */
  async *walk(path: string): AsyncGenerator<string> {
    const normalized = normalizePath(path);
    const entries = await this.readDir(normalized);

    for (const entry of entries) {
      const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
      if (entry.type === 'file') {
        yield childPath;
      } else {
        yield* this.walk(childPath);
      }
    }
  }

  /**
   * Copy a file from one path to another.
   * @throws FsError ENOENT if source doesn't exist, EISDIR if source is a directory
   */
  async copyFile(src: string, dest: string): Promise<void> {
    const stat = await this.stat(src);
    if (stat.type === 'directory') {
      throw new FsError('EISDIR', 'is a directory', src);
    }
    const content = await this.readFile(src, { encoding: 'binary' });
    await this.writeFile(dest, content);
  }

  /**
   * Get the parent directory of a path.
   */
  dirname(path: string): string {
    return splitPath(normalizePath(path)).dir;
  }

  /**
   * Get the base name of a path.
   */
  basename(path: string): string {
    return splitPath(normalizePath(path)).base;
  }
}
