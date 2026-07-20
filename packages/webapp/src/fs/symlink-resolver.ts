import { convertError } from './error-rebrand.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';

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
export async function lstatOrThrow(
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
export async function readAndResolveLink(
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
