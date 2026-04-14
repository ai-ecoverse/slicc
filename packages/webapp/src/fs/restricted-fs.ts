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
import type { FsWatchFilter, FsWatchCallback } from './fs-watcher.js';

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

  /** Get all prefixes including dynamic mount paths (as read-only). */
  private getAllPrefixes(): string[] {
    const mountPrefixes = this.vfs.listMounts().map((p) => (p.endsWith('/') ? p : p + '/'));
    return [...this.allowedPrefixes, ...this.readOnlyPrefixes, ...mountPrefixes];
  }

  /** Check if a path is within or is a parent of allowed or read-only prefixes. */
  private isAllowed(path: string): boolean {
    const normalized = normalizePath(path);
    const allPrefixes = this.getAllPrefixes();
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
    const allPrefixes = this.getAllPrefixes();
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

  /** Resolve symlinks and verify the resolved path is still within allowed read areas. */
  private async resolveAndCheckRead(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isAllowedStrict(resolved)) {
        throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
  }

  /** Resolve symlinks and verify the resolved path is still within writable areas. */
  private async resolveAndCheckWrite(path: string): Promise<string> {
    try {
      const resolved = await this.vfs.realpath(path);
      if (!this.isWritable(resolved)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(path));
      }
      return resolved;
    } catch (err) {
      if (err instanceof FsError) throw err;
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
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readFile(resolved, options);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    if (!this.isAllowed(path)) return [];
    // Resolve symlinks on the directory path itself when strictly allowed
    let resolvedPath = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedPath = await this.resolveAndCheckRead(path);
      } catch {
        return [];
      }
    }
    const entries = await this.vfs.readDir(resolvedPath);
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
    if (this.isAllowedStrict(path)) {
      const resolved = await this.resolveAndCheckRead(path);
      return this.vfs.stat(resolved);
    }
    return this.vfs.stat(path);
  }

  async exists(path: string): Promise<boolean> {
    if (!this.isAllowed(path)) return false;
    if (this.isAllowedStrict(path)) {
      try {
        await this.resolveAndCheckRead(path);
      } catch {
        return false;
      }
    }
    return this.vfs.exists(path);
  }

  async readTextFile(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const resolved = await this.resolveAndCheckRead(path);
    return this.vfs.readTextFile(resolved);
  }

  async *walk(path: string): AsyncGenerator<string> {
    if (!this.isAllowed(path)) return;
    let resolvedBase = path;
    if (this.isAllowedStrict(path)) {
      try {
        resolvedBase = await this.resolveAndCheckRead(path);
      } catch {
        return;
      }
    }
    for await (const filePath of this.vfs.walk(resolvedBase)) {
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
    // Resolve symlinks in parent path to prevent escape via symlinked directories.
    // The file itself may not exist yet, so resolve the parent directory.
    const dir = this.vfs.dirname(path);
    const base = this.vfs.basename(path);
    try {
      const resolvedDir = await this.vfs.realpath(dir);
      if (!this.isWritable(resolvedDir + '/' + base)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(path));
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // Parent doesn't exist yet — will be created by recursive, original check suffices
    }
    // Also check if destination itself is a symlink pointing outside sandbox
    try {
      const destStat = await this.vfs.lstat(path);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // File doesn't exist yet — that's fine, no symlink to follow
    }
    return this.vfs.writeFile(path, content, options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.checkWrite(path);
    // Resolve symlinks in parent to prevent escape
    const dir = this.vfs.dirname(path);
    const base = this.vfs.basename(path);
    try {
      const resolvedDir = await this.vfs.realpath(dir);
      if (!this.isWritable(resolvedDir + '/' + base)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(path));
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // Parent doesn't exist — recursive mkdir will handle, original check suffices
    }
    return this.vfs.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    this.checkWrite(path);
    // For symlinks, check only the link path (not target) — we're removing the link node
    try {
      const st = await this.vfs.lstat(path);
      if (st.type === 'symlink') {
        // Link itself is in a writable area (already confirmed by checkWrite above)
        // Don't resolve target — we're deleting the link, not the target
      } else {
        await this.resolveAndCheckWrite(path);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // Path doesn't exist — let VFS handle the error
    }
    return this.vfs.rm(path, options);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.checkWrite(oldPath);
    this.checkWrite(newPath);
    // Resolve symlinks in both paths to prevent escape
    await this.resolveAndCheckWrite(oldPath);
    const destDir = this.vfs.dirname(newPath);
    const destBase = this.vfs.basename(newPath);
    try {
      const resolvedDir = await this.vfs.realpath(destDir);
      if (!this.isWritable(resolvedDir + '/' + destBase)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(newPath));
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
    return this.vfs.rename(oldPath, newPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    // Read from anywhere allowed, write only to allowed
    if (!this.isAllowed(src)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(src));
    }
    this.checkWrite(dest);
    // Resolve symlinks in source path
    const resolvedSrc = await this.resolveAndCheckRead(src);
    // Resolve symlinks in dest parent
    const destDir = this.vfs.dirname(dest);
    const destBase = this.vfs.basename(dest);
    try {
      const resolvedDir = await this.vfs.realpath(destDir);
      if (!this.isWritable(resolvedDir + '/' + destBase)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(dest));
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
    // Also check if destination itself is a symlink pointing outside sandbox
    try {
      const destStat = await this.vfs.lstat(dest);
      if (destStat.type === 'symlink') {
        await this.resolveAndCheckWrite(dest);
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
      // File doesn't exist yet — that's fine, no symlink to follow
    }
    return this.vfs.copyFile(resolvedSrc, dest);
  }

  // ── Symlink operations ───────────────────────────────────────────────

  async symlink(target: string, linkPath: string): Promise<void> {
    this.checkWrite(linkPath);
    // Resolve symlinks in the link path's parent to prevent escape
    const linkDir = this.vfs.dirname(linkPath);
    const linkBase = this.vfs.basename(linkPath);
    try {
      const resolvedDir = await this.vfs.realpath(linkDir);
      if (!this.isWritable(resolvedDir + '/' + linkBase)) {
        throw new FsError('EACCES', 'permission denied', normalizePath(linkPath));
      }
    } catch (err) {
      if (err instanceof FsError && err.code === 'EACCES') throw err;
    }
    return this.vfs.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    if (!this.isAllowedStrict(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    const target = await this.vfs.readlink(path);
    // Resolve the target relative to the link's parent to get the absolute path
    let absoluteTarget: string;
    if (target.startsWith('/')) {
      absoluteTarget = normalizePath(target);
    } else {
      const linkDir = this.vfs.dirname(path);
      absoluteTarget = normalizePath(linkDir + '/' + target);
    }
    if (!this.isAllowedStrict(absoluteTarget)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return target;
  }

  async lstat(path: string): Promise<Stats> {
    if (!this.isAllowed(path)) {
      throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
    }
    return this.vfs.lstat(path);
  }

  // ── Watcher operations ──────────────────────────────────────────────

  watch(basePath: string, filter: FsWatchFilter, callback: FsWatchCallback): () => void {
    if (!this.isAllowed(basePath)) {
      throw new FsError('EACCES', 'permission denied', normalizePath(basePath));
    }
    const watcher = this.vfs.getWatcher();
    if (!watcher) {
      throw new FsError('EINVAL', 'no watcher configured');
    }
    return watcher.watch(normalizePath(basePath), filter, callback);
  }

  // ── Path utilities (no access control) ───────────────────────────────

  dirname(path: string): string {
    return this.vfs.dirname(path);
  }

  basename(path: string): string {
    return this.vfs.basename(path);
  }

  /**
   * Dispose the underlying VirtualFS, closing IndexedDB connections.
   */
  async dispose(): Promise<void> {
    await this.vfs.dispose();
  }
}
