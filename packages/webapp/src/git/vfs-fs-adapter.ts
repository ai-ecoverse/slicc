/**
 * Adapter exposing a {@link VirtualFS} as a `PromiseFsClient` for isomorphic-git.
 *
 * Why this exists: `VirtualFS.getLightningFS()` returns the raw LightningFS
 * instance, which only sees IndexedDB. Mounted directories (File System Access
 * API) are transparently routed through `VirtualFS` — so isomorphic-git needs
 * to go through `VirtualFS` to see `.git/HEAD` on mounted paths.
 *
 * For non-mounted paths we still read mode/size/mtime directly from the
 * underlying LightningFS to keep behavior byte-identical to the pre-adapter
 * code path (notably `statusMatrix`'s filemode comparison).
 */

import type FS from '@isomorphic-git/lightning-fs';
import { type VirtualFS } from '../fs/index.js';
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
  const lfs: FS.PromisifiedFS = vfs.getLightningFS();

  const inMount = (path: string): boolean => vfs.isPathUnderMount(path);

  const promises: IsoGitFsPromises = {
    async readFile(path, options) {
      if (inMount(path)) {
        const content = await vfs.readFile(
          path,
          wantsUtf8(options) ? { encoding: 'utf-8' } : { encoding: 'binary' }
        );
        return content;
      }
      if (wantsUtf8(options)) {
        return (await lfs.readFile(path, { encoding: 'utf8' })) as string;
      }
      return (await lfs.readFile(path)) as Uint8Array;
    },

    async writeFile(path, data, _options) {
      if (inMount(path)) {
        await vfs.writeFile(path, data);
        return;
      }
      await lfs.writeFile(path, data);
    },

    async unlink(path) {
      if (inMount(path)) {
        await vfs.rm(path);
        return;
      }
      await lfs.unlink(path);
    },

    async readdir(path) {
      if (inMount(path)) {
        const entries = await vfs.readDir(path);
        return entries.map((e) => e.name);
      }
      return (await lfs.readdir(path)) as string[];
    },

    async mkdir(path, options) {
      const opts = (options ?? undefined) as { recursive?: boolean; mode?: number } | undefined;
      if (inMount(path)) {
        await vfs.mkdir(
          path,
          opts?.recursive !== undefined ? { recursive: opts.recursive } : undefined
        );
        return;
      }
      // LightningFS accepts { mode } (but not recursive). Drop `recursive` so
      // callers that include it don't break the signature.
      await lfs.mkdir(path, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
    },

    async rmdir(path) {
      if (inMount(path)) {
        await vfs.rm(path);
        return;
      }
      await lfs.rmdir(path);
    },

    async stat(path) {
      if (inMount(path)) {
        const s = await vfs.stat(path);
        return toStats(s.type === 'directory' ? 'dir' : 'file', {
          size: s.size,
          mtimeMs: s.mtime,
          ctimeMs: s.ctime,
        });
      }
      const s = await lfs.stat(path);
      return toStats(s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file', {
        mode: s.mode,
        size: s.size,
        ino: s.ino,
        mtimeMs: s.mtimeMs,
        ctimeMs: s.ctimeMs,
      });
    },

    async lstat(path) {
      if (inMount(path)) {
        const s = await vfs.lstat(path);
        const type: 'file' | 'dir' | 'symlink' =
          s.type === 'directory' ? 'dir' : s.type === 'symlink' ? 'symlink' : 'file';
        return toStats(type, { size: s.size, mtimeMs: s.mtime, ctimeMs: s.ctime });
      }
      const s = await lfs.lstat(path);
      return toStats(s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : 'file', {
        mode: s.mode,
        size: s.size,
        ino: s.ino,
        mtimeMs: s.mtimeMs,
        ctimeMs: s.ctimeMs,
      });
    },

    async readlink(path) {
      if (inMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      return lfs.readlink(path);
    },

    async symlink(target, path) {
      if (inMount(path)) {
        throw new FsError('EINVAL', 'symlinks not supported on mounted filesystems', path);
      }
      await lfs.symlink(target, path);
    },
  };

  return { promises };
}
