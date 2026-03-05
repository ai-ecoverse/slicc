/**
 * Filesystem adapter for isomorphic-git that wraps VirtualFS.
 *
 * Implements the PromiseFsClient interface required by isomorphic-git,
 * bridging to our VirtualFS (OPFS/IndexedDB backed) storage.
 */

import type { VirtualFS } from '../fs/index.js';
import { normalizePath, joinPath, FsError } from '../fs/index.js';
import type { PromiseFsClient } from 'isomorphic-git';

/**
 * Creates a PromiseFsClient compatible with isomorphic-git from our VirtualFS.
 */
export class GitFs {
  readonly promises: PromiseFsClient['promises'];

  constructor(private vfs: VirtualFS) {
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      unlink: this.unlink.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      lstat: this.lstat.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
      chmod: this.chmod.bind(this),
    };
  }

  private async readFile(
    path: string,
    options?: { encoding?: 'utf8' | null } | 'utf8',
  ): Promise<Uint8Array | string> {
    const normalized = normalizePath(path);
    const encoding = typeof options === 'string' ? options : options?.encoding;

    if (encoding === 'utf8') {
      return (await this.vfs.readFile(normalized, { encoding: 'utf-8' })) as string;
    }
    // Return as Uint8Array for binary reads
    return (await this.vfs.readFile(normalized, { encoding: 'binary' })) as Uint8Array;
  }

  private async writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { mode?: number; encoding?: 'utf8' },
  ): Promise<void> {
    const normalized = normalizePath(path);
    // Ensure parent directory exists
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length > 1) {
      const parentPath = '/' + parts.slice(0, -1).join('/');
      await this.vfs.mkdir(parentPath, { recursive: true });
    }
    await this.vfs.writeFile(normalized, data);
  }

  private async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.vfs.rm(normalized);
  }

  private async readdir(path: string): Promise<string[]> {
    const normalized = normalizePath(path);
    const entries = await this.vfs.readDir(normalized);
    return entries.map((e) => e.name);
  }

  private async mkdir(path: string, options?: { mode?: number }): Promise<void> {
    const normalized = normalizePath(path);
    try {
      await this.vfs.mkdir(normalized, { recursive: true });
    } catch (err) {
      // Ignore EEXIST - isomorphic-git often creates dirs that may already exist
      if (err instanceof FsError && err.code === 'EEXIST') {
        return;
      }
      throw err;
    }
  }

  private async rmdir(path: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.vfs.rm(normalized);
  }

  private async stat(path: string): Promise<StatResult> {
    const normalized = normalizePath(path);
    try {
      const stats = await this.vfs.stat(normalized);
      return new StatResult(stats.type, stats.size, stats.mtime);
    } catch (err) {
      if (err instanceof FsError && err.code === 'ENOENT') {
        throw Object.assign(new Error(`ENOENT: ${normalized}`), { code: 'ENOENT' });
      }
      throw err;
    }
  }

  private async lstat(path: string): Promise<StatResult> {
    // VirtualFS doesn't support symlinks, lstat === stat
    return this.stat(path);
  }

  private async readlink(path: string): Promise<string> {
    throw Object.assign(new Error('Symlinks not supported'), { code: 'ENOENT' });
  }

  private async symlink(target: string, path: string): Promise<void> {
    throw Object.assign(new Error('Symlinks not supported'), { code: 'ENOSYS' });
  }

  private async chmod(path: string, mode: number): Promise<void> {
    // VirtualFS doesn't track permissions — no-op
  }
}

/**
 * Stat result compatible with isomorphic-git expectations.
 */
class StatResult {
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;

  constructor(type: 'file' | 'directory', size: number, mtime: number) {
    this.mode = type === 'directory' ? 0o40755 : 0o100644;
    this.size = size;
    this.ino = 0;
    this.mtimeMs = mtime;
    this.ctimeMs = mtime;
    this.uid = 1000;
    this.gid = 1000;
    this.dev = 0;
  }

  isFile(): boolean {
    return (this.mode & 0o170000) === 0o100000;
  }

  isDirectory(): boolean {
    return (this.mode & 0o170000) === 0o040000;
  }

  isSymbolicLink(): boolean {
    return false;
  }
}
