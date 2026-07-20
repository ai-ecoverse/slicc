import { convertError } from './error-rebrand.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';
import { FsError } from './types.js';

/**
 * Maximum number of symlink hops {@link realpath} follows before throwing
 * `ELOOP`. ZenFS' own `vfs/async.js#resolve` recurses without a hop counter,
 * so a `/a → /b → /a` cycle explodes the async stack and OOMs the process;
 * the bounded loop in {@link realpath} protects against that.
 */
export const MAX_SYMLINK_DEPTH = 10;

/** Structural subset of stats consumed by symlink resolution. */
export interface FsStatsLike {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Structural subset of `fs.promises` consumed by symlink resolution. */
export interface SymlinkLfs {
  lstat(path: string): Promise<FsStatsLike>;
  readlink(path: string): Promise<string>;
}

/**
 * lstat a path for realpath. Returns null if ENOENT on the tail component
 * (allowed per POSIX realpath). Throws for all other errors.
 */
async function lstatOrThrow(
  lfs: SymlinkLfs,
  next: string,
  isTail: boolean,
  originalPath: string
): Promise<FsStatsLike | null> {
  try {
    return await lfs.lstat(next);
  } catch (err) {
    const converted = convertError(err, originalPath);
    if (converted.code === 'ENOENT' && isTail) return null;
    throw converted;
  }
}

/** Read a symlink target and resolve it to an absolute normalized path. */
async function readAndResolveLink(
  lfs: SymlinkLfs,
  linkPath: string,
  originalPath: string
): Promise<string> {
  let target: string;
  try {
    target = await lfs.readlink(linkPath);
  } catch (err) {
    throw convertError(err, originalPath);
  }
  return target.startsWith('/')
    ? normalizePath(target)
    : normalizePath(joinPath(splitPath(linkPath).dir, target));
}

/**
 * Resolve a single path component for realpath, following symlinks up to the
 * hop limit. Returns the updated resolved path and hop count.
 */
async function resolveRealpathComponent(
  lfs: SymlinkLfs,
  resolved: string,
  part: string,
  isTail: boolean,
  originalPath: string,
  hops: number
): Promise<{ resolved: string; hops: number }> {
  let next = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
  while (true) {
    const stats = await lstatOrThrow(lfs, next, isTail, originalPath);
    if (stats === null) {
      // ENOENT on tail component — canonical form is current next
      return { resolved: next, hops };
    }
    if (!stats.isSymbolicLink()) {
      return { resolved: next, hops };
    }
    if (++hops > MAX_SYMLINK_DEPTH) {
      throw new FsError('ELOOP', 'too many symbolic links encountered', originalPath);
    }
    next = await readAndResolveLink(lfs, next, originalPath);
  }
}

/**
 * Resolve all symlinks in a path to produce the final canonical path.
 *
 * Walks the path component-by-component (so intermediate directory symlinks
 * like `/alias → /real` are resolved when reading `/alias/file.txt`) and
 * bounds total hops by {@link MAX_SYMLINK_DEPTH}; a circular chain surfaces as
 * `ELOOP`. We can't delegate to ZenFS' native `realpath` because
 * `@zenfs/core`'s `vfs/async.js#resolve` recurses without a hop counter — a
 * `/a → /b → /a` cycle blows the async stack and exhausts the heap before any
 * error is raised. This bounded loop mirrors the POSIX realpath contract.
 *
 * `findMount` reports whether a path is under an active mount; mount paths are
 * already canonical (mount backends do not support symlinks).
 */
export async function realpath(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  const normalized = normalizePath(path);
  if (findMount(normalized)) return normalized; // Mount paths are already real

  const parts = normalized.split('/').filter(Boolean);
  let resolved = '/';
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const result = await resolveRealpathComponent(
      lfs,
      resolved,
      parts[i],
      i === parts.length - 1,
      normalized,
      hops
    );
    resolved = result.resolved;
    hops = result.hops;
  }
  return resolved;
}

/**
 * Resolve symlinks in a path before an operation; mount points pass through
 * unchanged (mount backends do not support symlinks).
 */
export async function resolveSymlinks(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  if (findMount(path)) return path;
  return realpath(lfs, findMount, path);
}
