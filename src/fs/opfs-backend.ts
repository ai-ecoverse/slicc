/**
 * OPFS (Origin Private File System) storage backend.
 *
 * Uses the File System Access API's origin-private filesystem,
 * available via `navigator.storage.getDirectory()`.
 */

import type {
  DirEntry,
  Encoding,
  FileContent,
  MkdirOptions,
  RmOptions,
  Stats,
  StorageBackend,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath, pathSegments, splitPath } from './path-utils.js';

export class OpfsBackend implements StorageBackend {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

  /** Get the OPFS root directory handle. */
  private getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) {
      this.rootPromise = navigator.storage.getDirectory();
    }
    return this.rootPromise;
  }

  /**
   * Walk the path segments to get the directory handle for a given path.
   * If `create` is true, creates intermediate directories.
   */
  private async getDirectoryHandle(
    path: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    const segments = pathSegments(path);
    let current = await this.getRoot();

    for (const segment of segments) {
      try {
        current = await current.getDirectoryHandle(segment, { create });
      } catch {
        throw new FsError('ENOENT', 'no such file or directory', path);
      }
    }

    return current;
  }

  /**
   * Resolve a path to its parent directory handle and the entry name.
   */
  private async resolveParent(
    path: string,
    createParents = false,
  ): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
    const { dir, base } = splitPath(normalizePath(path));
    if (!base) {
      throw new FsError('EINVAL', 'cannot operate on root', '/');
    }
    const parent = await this.getDirectoryHandle(dir, createParents);
    return { parent, name: base };
  }

  async readFile(path: string, encoding: Encoding = 'utf-8'): Promise<FileContent> {
    const normalized = normalizePath(path);
    const { parent, name } = await this.resolveParent(normalized);

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await parent.getFileHandle(name);
    } catch {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }

    const file = await fileHandle.getFile();
    if (encoding === 'utf-8') {
      return await file.text();
    }
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, content: FileContent): Promise<void> {
    const normalized = normalizePath(path);
    // Always create parent directories for writeFile
    const { parent, name } = await this.resolveParent(normalized, true);

    const fileHandle = await parent.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      // Convert Uint8Array to ArrayBuffer for type compatibility
      const data = typeof content === 'string'
        ? content
        : (content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer);
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    let dirHandle: FileSystemDirectoryHandle;

    try {
      dirHandle = await this.getDirectoryHandle(normalized);
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }

    const entries: DirEntry[] = [];
    // @ts-expect-error - AsyncIterableIterator on FileSystemDirectoryHandle
    for await (const [name, handle] of dirHandle.entries()) {
      entries.push({
        name,
        type: handle.kind === 'file' ? 'file' : 'directory',
      });
    }
    return entries;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') return; // Root always exists

    if (options?.recursive) {
      // Create all segments
      await this.getDirectoryHandle(normalized, true);
    } else {
      const { parent, name } = await this.resolveParent(normalized);
      // Check if it already exists
      try {
        await parent.getDirectoryHandle(name);
        throw new FsError('EEXIST', 'file already exists', normalized);
      } catch (err) {
        if (err instanceof FsError && err.code === 'EEXIST') throw err;
      }
      await parent.getDirectoryHandle(name, { create: true });
    }
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = normalizePath(path);
    if (normalized === '/') {
      throw new FsError('EINVAL', 'cannot remove root directory', '/');
    }

    const { parent, name } = await this.resolveParent(normalized);

    try {
      await parent.removeEntry(name, { recursive: options?.recursive ?? false });
    } catch (err: unknown) {
      if (err instanceof DOMException) {
        if (err.name === 'NotFoundError') {
          throw new FsError('ENOENT', 'no such file or directory', normalized);
        }
        if (err.name === 'InvalidModificationError') {
          throw new FsError('ENOTEMPTY', 'directory not empty', normalized);
        }
      }
      throw err;
    }
  }

  async stat(path: string): Promise<Stats> {
    const normalized = normalizePath(path);

    if (normalized === '/') {
      return { type: 'directory', size: 0, mtime: 0, ctime: 0 };
    }

    const { parent, name } = await this.resolveParent(normalized);

    // Try as file first
    try {
      const fileHandle = await parent.getFileHandle(name);
      const file = await fileHandle.getFile();
      return {
        type: 'file',
        size: file.size,
        mtime: file.lastModified,
        ctime: file.lastModified, // OPFS doesn't track creation time separately
      };
    } catch {
      // Not a file, try as directory
    }

    try {
      await parent.getDirectoryHandle(name);
      return { type: 'directory', size: 0, mtime: Date.now(), ctime: Date.now() };
    } catch {
      throw new FsError('ENOENT', 'no such file or directory', normalized);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    // Read the source
    const sourceStat = await this.stat(normalizedOld);

    if (sourceStat.type === 'file') {
      const content = await this.readFile(normalizedOld, 'binary');
      await this.writeFile(normalizedNew, content);
      await this.rm(normalizedOld);
    } else {
      // For directories, copy recursively then remove
      await this.copyDirRecursive(normalizedOld, normalizedNew);
      await this.rm(normalizedOld, { recursive: true });
    }
  }

  /** Recursively copy a directory. */
  private async copyDirRecursive(src: string, dest: string): Promise<void> {
    await this.mkdir(dest, { recursive: true });
    const entries = await this.readDir(src);
    for (const entry of entries) {
      const srcChild = src === '/' ? `/${entry.name}` : `${src}/${entry.name}`;
      const destChild = dest === '/' ? `/${entry.name}` : `${dest}/${entry.name}`;
      if (entry.type === 'file') {
        const content = await this.readFile(srcChild, 'binary');
        await this.writeFile(destChild, content);
      } else {
        await this.copyDirRecursive(srcChild, destChild);
      }
    }
  }
}
