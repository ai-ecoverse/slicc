/**
 * VirtualFS adapter for just-bash's IFileSystem interface.
 *
 * Wraps our VirtualFS (OPFS/IndexedDB backed) so that just-bash
 * can use it as its filesystem backend.
 */

import type { VirtualFS } from '../fs/index.js';
import { normalizePath, joinPath } from '../fs/index.js';
import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  FileContent,
  BufferEncoding,
} from 'just-bash';

// These types are defined in just-bash's fs/interface.d.ts but not re-exported
// from the package root. Define locally to match IFileSystem's method signatures.
interface ReadFileOptions { encoding?: BufferEncoding | null }
interface WriteFileOptions { encoding?: BufferEncoding }
interface DirentEntry { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }

export class VfsAdapter implements IFileSystem {
  constructor(private vfs: VirtualFS) {}

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const normalized = normalizePath(path);
    const content = await this.vfs.readFile(normalized, { encoding: 'utf-8' });
    return content as string;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const normalized = normalizePath(path);
    const content = await this.vfs.readFile(normalized, { encoding: 'binary' });
    if (content instanceof Uint8Array) return content;
    return new TextEncoder().encode(content as string);
  }

  async writeFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    await this.vfs.writeFile(normalized, content as string | Uint8Array);
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const normalized = normalizePath(path);
    let existing = '';
    try {
      existing = await this.vfs.readTextFile(normalized);
    } catch {
      // File doesn't exist yet, start empty
    }
    const appendStr = typeof content === 'string' ? content : new TextDecoder().decode(content);
    await this.vfs.writeFile(normalized, existing + appendStr);
  }

  async exists(path: string): Promise<boolean> {
    return this.vfs.exists(normalizePath(path));
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = normalizePath(path);
    const s = await this.vfs.stat(normalized);
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      isSymbolicLink: false,
      mode: s.type === 'directory' ? 0o755 : 0o644,
      size: s.size,
      mtime: new Date(s.mtime),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    // Our VFS has no symlinks, lstat === stat
    return this.stat(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.vfs.mkdir(normalizePath(path), options);
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.vfs.readDir(normalizePath(path));
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const entries = await this.vfs.readDir(normalizePath(path));
    return entries.map((e) => ({
      name: e.name,
      isFile: e.type === 'file',
      isDirectory: e.type === 'directory',
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.vfs.rm(normalizePath(path), options);
  }

  async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
    await this.vfs.copyFile(normalizePath(src), normalizePath(dest));
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.vfs.rename(normalizePath(src), normalizePath(dest));
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    return normalizePath(joinPath(base, path));
  }

  getAllPaths(): string[] {
    // Our VFS doesn't support synchronous listing; just-bash uses this
    // for glob matching but can fall back to readdir-based walking.
    return [];
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // Our VFS doesn't track permissions — no-op
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error('Symlinks not supported in VirtualFS');
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('Hard links not supported in VirtualFS');
  }

  async readlink(_path: string): Promise<string> {
    throw new Error('Symlinks not supported in VirtualFS');
  }

  async realpath(path: string): Promise<string> {
    // No symlinks, so realpath is just normalization
    return normalizePath(path);
  }

  async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
    // Our VFS doesn't support setting times — no-op
  }
}
