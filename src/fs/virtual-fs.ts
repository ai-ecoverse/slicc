/**
 * VirtualFS — POSIX-like virtual filesystem backed by LightningFS.
 *
 * This is the single unified filesystem used throughout the application:
 * - Shell operations (just-bash via VfsAdapter)
 * - Git operations (isomorphic-git)
 * - File browser UI
 * - Agent tools
 */

import FS from '@isomorphic-git/lightning-fs';
import type {
  DirEntry,
  Encoding,
  FileContent,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  Stats,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath, splitPath } from './path-utils.js';

export interface VirtualFsOptions {
  /** Database name for LightningFS IndexedDB storage. */
  dbName?: string;
  /** Wipe existing data on init. */
  wipe?: boolean;
}

export class VirtualFS {
  private lfs: FS.PromisifiedFS;
  private _ready: Promise<void>;

  private constructor(dbName: string, wipe: boolean) {
    const fs = new FS(dbName, { wipe });
    this.lfs = fs.promises;
    // LightningFS initializes asynchronously; wait for first stat to complete
    this._ready = this.lfs.stat('/').then(() => {}).catch(() => {});
  }

  /** Create a VirtualFS instance. */
  static async create(options?: VirtualFsOptions): Promise<VirtualFS> {
    const dbName = options?.dbName ?? 'browser-fs';
    const wipe = options?.wipe ?? false;
    const vfs = new VirtualFS(dbName, wipe);
    await vfs._ready;
    return vfs;
  }

  /** Get the underlying LightningFS promises API (for isomorphic-git). */
  getLightningFS(): FS.PromisifiedFS {
    return this.lfs;
  }

  /**
   * Read a file's content.
   * @throws FsError ENOENT if file doesn't exist, EISDIR if path is a directory
   */
  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    const normalized = normalizePath(path);
    try {
      const encoding = options?.encoding ?? 'utf-8';
      if (encoding === 'utf-8') {
        return await this.lfs.readFile(normalized, { encoding: 'utf8' });
      } else {
        return await this.lfs.readFile(normalized);
      }
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Write content to a file. Creates the file if it doesn't exist.
   * Parent directories are created automatically.
   * @throws FsError EISDIR if path is an existing directory
   */
  async writeFile(
    path: string,
    content: FileContent,
    _options?: { recursive?: boolean },
  ): Promise<void> {
    const normalized = normalizePath(path);
    // Ensure parent directory exists
    const { dir } = splitPath(normalized);
    if (dir !== '/') {
      await this.mkdir(dir, { recursive: true });
    }
    try {
      await this.lfs.writeFile(normalized, content);
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * List entries in a directory.
   * @throws FsError ENOENT if directory doesn't exist, ENOTDIR if path is a file
   */
  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    try {
      const names = await this.lfs.readdir(normalized);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
        try {
          const stat = await this.lfs.stat(childPath);
          entries.push({
            name,
            type: stat.isDirectory() ? 'directory' : 'file',
          });
        } catch {
          // Skip entries we can't stat
        }
      }
      return entries;
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Create a directory.
   * @throws FsError EEXIST if directory already exists (non-recursive),
   *                 ENOENT if parent doesn't exist (non-recursive)
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') return; // Root always exists

    if (options?.recursive) {
      // Create all parent directories
      const parts = normalized.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current += '/' + part;
        try {
          await this.lfs.mkdir(current);
        } catch (err: unknown) {
          // Ignore EEXIST errors in recursive mode
          if (err instanceof Error && !err.message.includes('EEXIST')) {
            throw this.convertError(err, current);
          }
        }
      }
    } else {
      try {
        await this.lfs.mkdir(normalized);
      } catch (err) {
        throw this.convertError(err, normalized);
      }
    }
  }

  /**
   * Remove a file or directory.
   * @throws FsError ENOENT if path doesn't exist,
   *                 ENOTEMPTY if directory is not empty (non-recursive)
   */
  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    try {
      const stat = await this.lfs.stat(normalized);
      if (stat.isDirectory()) {
        if (options?.recursive) {
          await this.rmRecursive(normalized);
        } else {
          await this.lfs.rmdir(normalized);
        }
      } else {
        await this.lfs.unlink(normalized);
      }
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  private async rmRecursive(path: string): Promise<void> {
    const entries = await this.lfs.readdir(path);
    for (const name of entries) {
      const childPath = path === '/' ? `/${name}` : `${path}/${name}`;
      const stat = await this.lfs.stat(childPath);
      if (stat.isDirectory()) {
        await this.rmRecursive(childPath);
      } else {
        await this.lfs.unlink(childPath);
      }
    }
    await this.lfs.rmdir(path);
  }

  /**
   * Get metadata about a file or directory.
   * @throws FsError ENOENT if path doesn't exist
   */
  async stat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    try {
      const stat = await this.lfs.stat(normalized);
      return {
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
      };
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    try {
      await this.lfs.stat(normalized);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rename or move a file/directory.
   * @throws FsError ENOENT if source doesn't exist
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    try {
      await this.lfs.rename(normalizedOld, normalizedNew);
    } catch (err) {
      throw this.convertError(err, normalizedOld);
    }
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

  /**
   * Convert LightningFS errors to FsError.
   */
  private convertError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      return new FsError('ENOENT', 'no such file or directory', path);
    }
    if (msg.includes('EEXIST')) {
      return new FsError('EEXIST', 'file already exists', path);
    }
    if (msg.includes('ENOTDIR')) {
      return new FsError('ENOTDIR', 'not a directory', path);
    }
    if (msg.includes('EISDIR')) {
      return new FsError('EISDIR', 'is a directory', path);
    }
    if (msg.includes('ENOTEMPTY')) {
      return new FsError('ENOTEMPTY', 'directory not empty', path);
    }
    // Default to EINVAL for unknown errors
    return new FsError('EINVAL', msg, path);
  }
}

// For backwards compatibility, keep BackendType but it's no longer used
export type BackendType = 'lightningfs';
