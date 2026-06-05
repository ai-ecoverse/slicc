/**
 * Adapter exposing a {@link VirtualFS} as a `PromiseFsClient` for isomorphic-git.
 *
 * Every method routes through the public `VirtualFS` surface — so
 * mounted directories (File System Access API, S3, DA) are visible to
 * isomorphic-git the same way as the local OPFS/InMemory tree, and the
 * watcher / mount-index notifications fire normally.
 *
 * This adapter previously reached past `VirtualFS` for non-mounted
 * paths via the (now-removed) `getLightningFS()` escape hatch. The
 * fast-path shortcut is gone; `VirtualFS` itself owns symlink
 * resolution and watcher notification for every op.
 */

import type { VirtualFS } from '../fs/index.js';
import { FsError } from '../fs/types.js';

export type PromiseFsClient = { promises: IsoGitFsPromises };

export interface IsoGitFsPromises {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: unknown): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<NodeLikeStats>;
  lstat(path: string): Promise<NodeLikeStats>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
}

export interface NodeLikeStats {
  type: 'file' | 'dir' | 'symlink';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040755;
const SYMLINK_MODE = 0o120000;

function toStats(type: 'file' | 'dir' | 'symlink', raw: Partial<NodeLikeStats>): NodeLikeStats {
  const mtimeMs = raw.mtimeMs ?? 0;
  return {
    type,
    mode: raw.mode ?? (type === 'dir' ? DIR_MODE : type === 'symlink' ? SYMLINK_MODE : FILE_MODE),
    size: raw.size ?? 0,
    ino: raw.ino ?? 0,
    mtimeMs,
    ctimeMs: raw.ctimeMs ?? mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => type === 'file',
    isDirectory: () => type === 'dir',
    isSymbolicLink: () => type === 'symlink',
  };
}

function wantsUtf8(options: unknown): boolean {
  if (typeof options === 'string') return /^utf-?8$/i.test(options);
  if (options && typeof options === 'object') {
    const enc = (options as { encoding?: unknown }).encoding;
    if (typeof enc === 'string') return /^utf-?8$/i.test(enc);
  }
  return false;
}

/** Build an isomorphic-git-compatible PromiseFsClient over a VirtualFS. */
export function createIsomorphicGitFs(vfs: VirtualFS): PromiseFsClient {
  const promises: IsoGitFsPromises = {
    async readFile(path, options) {
      const content = await vfs.readFile(
        path,
        wantsUtf8(options) ? { encoding: 'utf-8' } : { encoding: 'binary' }
      );
      return content;
    },

    async writeFile(path, data, _options) {
      await vfs.writeFile(path, data);
    },

    async unlink(path) {
      await vfs.rm(path);
    },

    async readdir(path) {
      const entries = await vfs.readDir(path);
      return entries.map((e) => e.name);
    },

    async mkdir(path, options) {
      const opts = (options ?? undefined) as { recursive?: boolean } | undefined;
      await vfs.mkdir(
        path,
        opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined
      );
    },

    async rmdir(path) {
      await vfs.rm(path);
    },

    async stat(path) {
      const s = await vfs.stat(path);
      return toStats(s.type === 'directory' ? 'dir' : 'file', {
        size: s.size,
        mtimeMs: s.mtime,
        ctimeMs: s.ctime,
      });
    },

    async lstat(path) {
      const s = await vfs.lstat(path);
      const type: 'file' | 'dir' | 'symlink' =
        s.type === 'directory' ? 'dir' : s.type === 'symlink' ? 'symlink' : 'file';
      return toStats(type, { size: s.size, mtimeMs: s.mtime, ctimeMs: s.ctime });
    },

    async readlink(path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      return vfs.readlink(path);
    },

    async symlink(target, path) {
      if (vfs.isPathUnderMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      await vfs.symlink(target, path);
    },
  };

  return { promises };
}
