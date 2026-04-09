/**
 * RestrictedFS — wraps VirtualFS with path access control.
 * Used to restrict scoops to their own directories + /shared/.
 *
 * Read operations (stat, exists, readFile, readDir, readTextFile, walk)
 * return "not found" / empty for paths outside allowed areas. This lets
 * the shell probe freely (PATH resolution, command lookup) without errors.
 *
 * Write operations (writeFile, mkdir, rm, rename, copyFile) throw EACCES
 * for paths outside allowed areas — hard enforcement.
 */

import type FS from '@isomorphic-git/lightning-fs';
import type { VirtualFS } from './virtual-fs.js';
import type {
  FileContent,
  DirEntry,
  Stats,
  ReadFileOptions,
  MkdirOptions,
  RmOptions,
} from './types.js';
import { FsError } from './types.js';
import { normalizePath } from './path-utils.js';

export class RestrictedFS {
  private vfs: VirtualFS;
  private allowedPrefixes: string[];
  private readOnlyPrefixes: string[];

  constructor(vfs: VirtualFS, allowedPaths: string[], readOnlyPaths: string[] = []) {
    this.vfs = vfs;
    const normalize = (p: string) => {
      const n = normalizePath(p);
      return n.endsWith('/') ? n : n + '/';
    };
    this.allowedPrefixes = allowedPaths.map(normalize);
    this.readOnlyPrefixes = readOnlyPaths.map(normalize);
  }

  /** Check if a path is within or is a parent of allowed or read-only prefixes. */
  private isAllowed(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = [...this.allowedPrefixes, ...this.readOnlyPrefixes];
    return allPrefixes.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) ||
        normalized.startsWith(prefix) ||
        normalized === '/' ||
        prefix.startsWith(normalized + '/')
    );
  }

  /** Check if a path is within allowed or read-only prefixes (strict — no parent access). */
  private isAllowedStrict(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = [...this.allowedPrefixes, ...this.readOnlyPrefixes];
    return allPrefixes.some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    );
  }

  /** Check if a path is within read-write prefixes only (excludes read-only). */
  private isWritable(path: string): boolean {
    const normalized = normalizePath(path);
    return this.allowedPrefixes.some(
      (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)
    );
  }

  /** Throw EACCES for write operations outside read-write paths. */
  private checkWrite(path: string): void {
    if (!this.isWritable(path)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(path));
    }
  }

  /** Get the underlying unrestricted VirtualFS (cone-only escape hatch). */
  getUnderlyingFS(): VirtualFS {
    return this.vfs;
  }

  /** Get the underlying LightningFS (needed by isomorphic-git). */
  getLightningFS(): FS.PromisifiedFS {
    return this.vfs.getLightningFS();
  }

  // ── Read operations: return "not found" for outside paths ────────────

  async readFile(path: string, options?: ReadFileOptions): Promise<FileContent> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.readFile(path, options);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    if (!this.isAllowed(path)) return [];
    const entries = await this.vfs.readDir(path);
    // If this is a parent dir (not strictly allowed), filter to only entries
    // that lead toward allowed paths
    if (!this.isAllowedStrict(path)) {
      const normalized = normalizePath(path);
      return entries.filter((e) => {
        const childPath = normalized === '/' ? `/${e.name}` : `${normalized}/${e.name}`;
        return this.isAllowed(childPath);
      });
    }
    return entries;
  }

  async stat(path: string): Promise<Stats> {
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    if (!this.isAllowed(path)) return false;
    return this.vfs.exists(path);
  }

  async readTextFile(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.readTextFile(path);
  }

  async *walk(path: string): AsyncGenerator<string> {
    if (!this.isAllowed(path)) return;
    for await (const filePath of this.vfs.walk(path)) {
      if (this.isAllowed(filePath)) {
        yield filePath;
      }
    }
  }

  // ── Write operations: throw EACCES for outside paths ─────────────────

  async writeFile(
    path: string,
    content: FileContent,
    options?: { recursive?: boolean }
  ): Promise<void> {
    this.checkWrite(path);
    return this.vfs.writeFile(path, content, options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.checkWrite(path);
    return this.vfs.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.checkWrite(path);
    return this.vfs.rm(path, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.checkWrite(oldPath);
    this.checkWrite(newPath);
    return this.vfs.rename(oldPath, newPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Read from anywhere allowed, write only to allowed
    if (!this.isAllowed(src)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
    }
    this.checkWrite(dest);
    return this.vfs.copyFile(src, dest);
  }

  // ── Symlink operations ───────────────────────────────────────────────

  async symlink(target: string, linkPath: string): Promise<void> {
    this.checkWrite(linkPath);
    return this.vfs.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.readlink(path);
  }

  async lstat(path: string): Promise<Stats> {
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.lstat(path);
  }

  // ── Path utilities (no access control) ───────────────────────────────

  dirname(path: string): string {
    return this.vfs.dirname(path);
  }

  basename(path: string): string {
    return this.vfs.basename(path);
  }
}
