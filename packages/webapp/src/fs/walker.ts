import { normalizePath } from './path-utils.js';
import type { DirEntry, Stats } from './types.js';

// Bound `walk()`'s slow-path recursion. Symlink cycles surface as ELOOP via
// realpath, but realpath returns mount paths unchanged ("already real"), so a
// self-referential mount yields ever-distinct paths the visited-set can't
// collapse — cap depth and total entries so it can't loop forever.
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_ENTRIES = 100_000;

/** Structural view of the VirtualFS mount table consumed by the walker. */
export interface WalkMountView {
  readonly size: number;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
}

/** Structural view of the MountIndex readiness check consumed by the walker. */
export interface WalkIndexView {
  isReady(path: string): boolean;
}

/** Check whether the walk fast path (indexed mount, no nested mounts) is available. */
export function canUseWalkFastPath(
  mountPoints: WalkMountView,
  mountIndex: WalkIndexView,
  normalized: string
): boolean {
  if (mountPoints.size === 0 || !mountPoints.has(normalized)) return false;
  if (!mountIndex.isReady(normalized)) return false;
  const hasNestedMounts = Array.from(mountPoints.keys()).some(
    (mp) => mp !== normalized && mp.startsWith(normalized + '/')
  );
  return !hasNestedMounts;
}

/** Resolve realpath, falling back to the input path on any error. */
async function safeRealpath(
  realpath: (p: string) => Promise<string>,
  normalized: string
): Promise<string> {
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}

/** Dependencies the directory walker pulls from VirtualFS. */
export interface WalkDeps {
  mountPoints: WalkMountView;
  mountIndex: WalkIndexView & { getFiles(path: string): string[] | undefined };
  realpath(p: string): Promise<string>;
  readDir(p: string): Promise<DirEntry[]>;
  stat(p: string): Promise<Stats>;
}

/** Recursively walk a directory tree, yielding all file paths. */
export async function* walk(
  deps: WalkDeps,
  path: string,
  visited?: Set<string>,
  depth = 0
): AsyncGenerator<string> {
  const normalized = normalizePath(path);

  // Fast path: indexed mount with no nested mounts
  if (canUseWalkFastPath(deps.mountPoints, deps.mountIndex, normalized)) {
    const files = deps.mountIndex.getFiles(normalized);
    if (files) {
      for (const filePath of files) yield filePath;
      return;
    }
  }

  // Slow path: recursive readDir
  const seen = visited ?? new Set<string>();
  if (depth > MAX_WALK_DEPTH || seen.size >= MAX_WALK_ENTRIES) return;

  // Track the real path to detect symlink loops
  const realPath = await safeRealpath((p) => deps.realpath(p), normalized);
  if (seen.has(realPath)) return;
  seen.add(realPath);

  const entries = await deps.readDir(normalized);
  for (const entry of entries) {
    const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
    yield* walkEntry(deps, entry, childPath, seen, depth + 1);
  }
}

/** Yield files from a single walk entry (file, symlink, or directory). */
async function* walkEntry(
  deps: WalkDeps,
  entry: DirEntry,
  childPath: string,
  visited: Set<string>,
  depth: number
): AsyncGenerator<string> {
  if (entry.type === 'file') {
    yield childPath;
    return;
  }
  if (entry.type === 'symlink') {
    yield* walkSymlink(deps, childPath, visited, depth);
    return;
  }
  yield* walk(deps, childPath, visited, depth);
}

/** Follow a symlink during walk — yield as file or recurse as directory. */
async function* walkSymlink(
  deps: WalkDeps,
  childPath: string,
  visited: Set<string>,
  depth: number
): AsyncGenerator<string> {
  try {
    const targetStat = await deps.stat(childPath);
    if (targetStat.type === 'file') {
      yield childPath;
    } else if (targetStat.type === 'directory') {
      yield* walk(deps, childPath, visited, depth);
    }
  } catch {
    // Dangling symlink — skip
  }
}
