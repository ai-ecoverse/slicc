import { convertError } from './error-rebrand.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';
import { FsError, type FsStatsLike } from './types.js';

export const MAX_SYMLINK_DEPTH = 10;

export interface SymlinkLfs {
  lstat(path: string): Promise<FsStatsLike>;
  readlink(path: string): Promise<string>;
}

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

export async function realpath(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  const normalized = normalizePath(path);
  if (findMount(normalized)) return normalized;

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

export async function resolveSymlinks(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  if (findMount(path)) return path;
  return realpath(lfs, findMount, path);
}
