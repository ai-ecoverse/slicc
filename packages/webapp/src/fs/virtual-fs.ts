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
import { normalizePath, splitPath, joinPath } from './path-utils.js';
import type { FsWatcher, FsChangeEvent } from './fs-watcher.js';

/** Maximum number of symlink hops before throwing ELOOP. */
const MAX_SYMLINK_DEPTH = 40;

export interface VirtualFsOptions {
  /** Database name for LightningFS IndexedDB storage. */
  dbName?: string;
  /** Wipe existing data on init. */
  wipe?: boolean;
}

export class VirtualFS {
  private lfs: FS.PromisifiedFS;
  private rawFs: FS;
  private _ready: Promise<void>;
  /** Map from absolute mount path → FileSystemDirectoryHandle (File System Access API). */
  private mountPoints = new Map<string, FileSystemDirectoryHandle>();
  private watcher: FsWatcher | null = null;

  private constructor(dbName: string, wipe: boolean) {
    const fs = new FS(dbName, { wipe });
    this.rawFs = fs;
    this.lfs = fs.promises;
    // LightningFS initializes asynchronously; wait for first stat to complete
    this._ready = this.lfs
      .stat('/')
      .then(() => {})
      .catch(() => {});
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

  /** Attach a file system watcher for change notifications. */
  setWatcher(watcher: FsWatcher): void {
    this.watcher = watcher;
  }

  /** Get the attached watcher, or null. */
  getWatcher(): FsWatcher | null {
    return this.watcher;
  }

  /**
   * Close the underlying IndexedDB connection and release resources.
   * Must be called when the VirtualFS instance is no longer needed (e.g., in test cleanup).
   */
  async dispose(): Promise<void> {
    this.watcher?.dispose();
    this.watcher = null;
    // LightningFS PromisifiedFS stores the IDB backend internally.
    // Trigger graceful shutdown via the internal backend API.
    const pfs = this.lfs as any;
    if (pfs._backend) {
      if (pfs._backend.destroy) {
        await pfs._backend.destroy();
      } else if (pfs._backend.deactivate) {
        await pfs._backend.deactivate();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // File System Access API mount support
  // ---------------------------------------------------------------------------

  /**
   * Mount a real filesystem directory (from File System Access API) at an
   * absolute VirtualFS path. All reads and writes under that path are
   * transparently bridged to the real directory handle — no copying occurs.
   *
   * A placeholder directory is created in LightningFS so that ancestor paths
   * (e.g. `cd /workspace`) resolve correctly.
   */
  async mount(absolutePath: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const normalized = normalizePath(absolutePath);
    // Ensure parent dirs exist in LFS, then create placeholder for mount root
    const { dir } = splitPath(normalized);
    if (dir !== '/') await this.mkdir(dir, { recursive: true });
    try {
      await this.lfs.mkdir(normalized);
    } catch {
      /* EEXIST is fine */
    }
    this.mountPoints.set(normalized, handle);
  }

  /** Remove a mount point (the LFS placeholder directory is left in place). */
  unmount(absolutePath: string): void {
    this.mountPoints.delete(normalizePath(absolutePath));
  }

  /** Return the list of currently active mount paths. */
  listMounts(): string[] {
    return [...this.mountPoints.keys()];
  }

  /**
   * Find the mount point that owns `path`.
   * Returns the handle and the path segments relative to the mount root,
   * or null if the path is not under any mount.
   */
  private findMount(
    path: string
  ): { handle: FileSystemDirectoryHandle; relParts: string[] } | null {
    for (const [mountPath, handle] of this.mountPoints) {
      if (path === mountPath) return { handle, relParts: [] };
      if (path.startsWith(mountPath + '/')) {
        return {
          handle,
          relParts: path
            .slice(mountPath.length + 1)
            .split('/')
            .filter(Boolean),
        };
      }
    }
    return null;
  }

  /** Navigate to a nested sub-directory within a FileSystemDirectoryHandle. */
  private static async fsaNavDir(
    root: FileSystemDirectoryHandle,
    parts: string[],
    create = false
  ): Promise<FileSystemDirectoryHandle> {
    let dir = root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  /** Get a FileSystemFileHandle at `parts` relative to `root`. */
  private static async fsaGetFile(
    root: FileSystemDirectoryHandle,
    parts: string[],
    create = false
  ): Promise<FileSystemFileHandle> {
    const dir = await VirtualFS.fsaNavDir(root, parts.slice(0, -1), create);
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  /** Convert a File System Access API error to FsError. */
  private convertFsaError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    if (err instanceof Error) {
      if (err.name === 'NotFoundError')
        return new FsError('ENOENT', 'no such file or directory', path);
      if (err.name === 'TypeMismatchError') return new FsError('ENOTDIR', 'not a directory', path);
      if (err.name === 'NotAllowedError') return new FsError('EINVAL', 'permission denied', path);
    }
    return new FsError('EINVAL', err instanceof Error ? err.message : String(err), path);
  }

  /**
   * Read a file's content.
   * @throws FsError ENOENT if file doesn't exist, EISDIR if path is a directory
   */
  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) throw new FsError('EISDIR', 'is a directory', normalized);
      try {
        const fh = await VirtualFS.fsaGetFile(mount.handle, mount.relParts);
        const file = await fh.getFile();
        const encoding = options?.encoding ?? 'utf-8';
        if (encoding === 'utf-8') return await file.text();
        return new Uint8Array(await file.arrayBuffer());
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
    }
    // Resolve symlinks before reading
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const encoding = options?.encoding ?? 'utf-8';
      if (encoding === 'utf-8') {
        return await this.lfs.readFile(resolved, { encoding: 'utf8' });
      } else {
        return await this.lfs.readFile(resolved);
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
    _options?: { recursive?: boolean }
  ): Promise<void> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) throw new FsError('EISDIR', 'is a directory', normalized);
      try {
        const fh = await VirtualFS.fsaGetFile(mount.handle, mount.relParts, true);
        const writable = await fh.createWritable();
        const data =
          typeof content === 'string'
            ? new TextEncoder().encode(content)
            : new Uint8Array(
                content instanceof Uint8Array
                  ? (content.buffer as ArrayBuffer)
                  : (content as ArrayBuffer)
              );
        await writable.write(data as unknown as FileSystemWriteChunkType);
        await writable.close();
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
      return;
    }
    // Resolve symlinks before writing
    let resolved: string;
    try {
      resolved = await this.resolveSymlinks(normalized);
    } catch {
      // Path doesn't exist yet — that's fine for new files, use the original path
      resolved = normalized;
    }
    // Check existence before write to determine create vs modify
    let wasExisting = false;
    try {
      wasExisting = await this.exists(normalized);
    } catch {
      /* ignore */
    }
    // Ensure parent directory exists
    const { dir } = splitPath(resolved);
    if (dir !== '/') {
      await this.mkdir(dir, { recursive: true });
    }
    try {
      await this.lfs.writeFile(resolved, content);
    } catch (err) {
      throw this.convertError(err, normalized);
    }
    this.watcher?.notify([
      {
        type: wasExisting ? 'modify' : 'create',
        path: resolved,
        entryType: 'file',
      },
    ]);
  }

  /**
   * List entries in a directory.
   * @throws FsError ENOENT if directory doesn't exist, ENOTDIR if path is a file
   */
  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      try {
        const dirHandle =
          mount.relParts.length === 0
            ? mount.handle
            : await VirtualFS.fsaNavDir(mount.handle, mount.relParts);
        const entries: DirEntry[] = [];
        for await (const [name, handle] of dirHandle as unknown as AsyncIterable<
          [string, FileSystemHandle]
        >) {
          entries.push({ name, type: handle.kind === 'directory' ? 'directory' : 'file' });
        }
        return entries;
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
    }
    // Resolve symlinks in the directory path itself
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const names = await this.lfs.readdir(resolved);
      const entries: DirEntry[] = [];
      for (const name of names) {
        const childPath = resolved === '/' ? `/${name}` : `${resolved}/${name}`;
        try {
          const s = await this.lfs.lstat(childPath);
          if (s.isSymbolicLink()) {
            entries.push({ name, type: 'symlink' });
          } else {
            entries.push({
              name,
              type: s.isDirectory() ? 'directory' : 'file',
            });
          }
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

    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) return; // mount root placeholder already exists
      try {
        await VirtualFS.fsaNavDir(mount.handle, mount.relParts, true);
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
      return;
    }

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
      this.watcher?.notify([{ type: 'create', path: normalized, entryType: 'directory' }]);
    }
  }

  /**
   * Remove a file or directory.
   * @throws FsError ENOENT if path doesn't exist,
   *                 ENOTEMPTY if directory is not empty (non-recursive)
   */
  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
        throw new FsError('EINVAL', 'cannot remove a mount point — use unmount', normalized);
      }
      try {
        const parentParts = mount.relParts.slice(0, -1);
        const name = mount.relParts[mount.relParts.length - 1];
        const parentDir =
          parentParts.length === 0
            ? mount.handle
            : await VirtualFS.fsaNavDir(mount.handle, parentParts);
        await parentDir.removeEntry(name, { recursive: options?.recursive });
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
      return;
    }
    try {
      // Use lstat to detect symlinks — if it's a symlink, just unlink it
      // (don't follow the link or recurse into a target directory)
      const s = await this.lfs.lstat(normalized);
      if (s.isSymbolicLink()) {
        await this.lfs.unlink(normalized);
      } else if (s.isDirectory()) {
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
    this.watcher?.notify([{ type: 'delete', path: normalized }]);
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
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) {
        // Mount root: LFS has a placeholder dir — just use it
        try {
          const s = await this.lfs.stat(normalized);
          return { type: 'directory', size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
        } catch {
          return { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() };
        }
      }
      try {
        // Try as file first
        try {
          const fh = await VirtualFS.fsaGetFile(mount.handle, mount.relParts);
          const file = await fh.getFile();
          return {
            type: 'file',
            size: file.size,
            mtime: file.lastModified,
            ctime: file.lastModified,
          };
        } catch {
          // Try as directory
          await VirtualFS.fsaNavDir(mount.handle, mount.relParts);
          return { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() };
        }
      } catch (err) {
        throw this.convertFsaError(err, normalized);
      }
    }
    // Resolve symlinks before stat — stat follows symlinks
    const resolved = await this.resolveSymlinks(normalized);
    try {
      const s = await this.lfs.stat(resolved);
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
      };
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      if (mount.relParts.length === 0) return true;
      try {
        await this.stat(normalized);
        return true;
      } catch {
        return false;
      }
    }
    try {
      // Try following symlinks first (stat follows them)
      await this.stat(normalized);
      return true;
    } catch {
      // If stat fails (e.g., dangling symlink), check if the link itself exists
      try {
        await this.lfs.lstat(normalized);
        return true;
      } catch {
        return false;
      }
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
   * Follows symlinks to directories but tracks visited real paths to avoid infinite loops.
   */
  async *walk(path: string, _visited?: Set<string>): AsyncGenerator<string> {
    const normalized = normalizePath(path);
    const visited = _visited ?? new Set<string>();

    // Track the real path to detect symlink loops
    let realPath: string;
    try {
      realPath = await this.realpath(normalized);
    } catch {
      realPath = normalized;
    }
    if (visited.has(realPath)) return; // Avoid infinite loops
    visited.add(realPath);

    const entries = await this.readDir(normalized);

    for (const entry of entries) {
      const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
      if (entry.type === 'file') {
        yield childPath;
      } else if (entry.type === 'symlink') {
        // Determine if symlink points to a file or directory
        try {
          const targetStat = await this.stat(childPath);
          if (targetStat.type === 'file') {
            yield childPath;
          } else if (targetStat.type === 'directory') {
            yield* this.walk(childPath, visited);
          }
        } catch {
          // Dangling symlink — skip
        }
      } else {
        yield* this.walk(childPath, visited);
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

  // ---------------------------------------------------------------------------
  // Symlink support
  // ---------------------------------------------------------------------------

  /**
   * Create a symbolic link at `linkPath` pointing to `target`.
   * Target can be absolute or relative (relative to the directory containing the link).
   * @throws FsError EEXIST if linkPath already exists
   */
  async symlink(target: string, linkPath: string): Promise<void> {
    const normalizedLinkPath = normalizePath(linkPath);
    const mount = this.findMount(normalizedLinkPath);
    if (mount) {
      throw new FsError(
        'EINVAL',
        'symlinks not supported on mounted filesystems',
        normalizedLinkPath
      );
    }
    // Ensure parent directory exists
    const { dir } = splitPath(normalizedLinkPath);
    if (dir !== '/') {
      await this.mkdir(dir, { recursive: true });
    }
    try {
      await this.lfs.symlink(target, normalizedLinkPath);
    } catch (err) {
      throw this.convertError(err, normalizedLinkPath);
    }
    this.watcher?.notify([{ type: 'create', path: normalizedLinkPath, entryType: 'symlink' }]);
  }

  /**
   * Read the target of a symbolic link without following it.
   * @throws FsError ENOENT if path doesn't exist, EINVAL if path is not a symlink
   */
  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    try {
      return await this.lfs.readlink(normalized);
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Stat a path without following symlinks.
   * If the path is a symlink, returns type: 'symlink' with isSymlink and symlinkTarget set.
   */
  async lstat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) {
      // Mount points don't support symlinks — fall through to regular stat
      return this.stat(normalized);
    }
    try {
      const s = await this.lfs.lstat(normalized);
      if (s.isSymbolicLink()) {
        const target = await this.lfs.readlink(normalized);
        return {
          type: 'symlink',
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
          isSymlink: true,
          symlinkTarget: target,
        };
      }
      return {
        type: s.isDirectory() ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtimeMs,
        ctime: s.ctimeMs,
      };
    } catch (err) {
      throw this.convertError(err, normalized);
    }
  }

  /**
   * Resolve all symlinks in a path to produce the final canonical path.
   * @throws FsError ELOOP if more than MAX_SYMLINK_DEPTH symlinks are encountered
   */
  async realpath(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const mount = this.findMount(normalized);
    if (mount) return normalized; // Mount paths are already real

    const parts = normalized.split('/').filter(Boolean);
    let resolved = '/';
    let hops = 0;

    for (const part of parts) {
      resolved = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
      try {
        const s = await this.lfs.lstat(resolved);
        if (s.isSymbolicLink()) {
          if (++hops > MAX_SYMLINK_DEPTH) {
            throw new FsError('ELOOP', 'too many levels of symbolic links', path);
          }
          const target = await this.lfs.readlink(resolved);
          if (target.startsWith('/')) {
            // Absolute symlink — restart resolution from the target
            resolved = normalizePath(target);
          } else {
            // Relative symlink — resolve relative to the link's parent directory
            const { dir } = splitPath(resolved);
            resolved = normalizePath(joinPath(dir, target));
          }
          // The resolved path itself may contain more symlinks — resolve it fully
          resolved = await this.realpath(resolved);
        }
      } catch (err) {
        if (err instanceof FsError) throw err;
        throw this.convertError(err, resolved);
      }
    }

    return resolved;
  }

  /**
   * Internal helper: resolve symlinks in a path before an operation.
   * Used by readFile, writeFile, stat, etc. to follow symlinks transparently.
   * Only applies to LFS-backed paths (mount points are returned as-is).
   */
  private async resolveSymlinks(path: string): Promise<string> {
    const mount = this.findMount(path);
    if (mount) return path; // Mount points don't have symlinks
    return this.realpath(path);
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
    if (msg.includes('ELOOP')) {
      return new FsError('ELOOP', 'too many levels of symbolic links', path);
    }
    // Default to EINVAL for unknown errors
    return new FsError('EINVAL', msg, path);
  }
}

// For backwards compatibility, keep BackendType but it's no longer used
export type BackendType = 'lightningfs';
