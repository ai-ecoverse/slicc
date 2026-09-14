import { normalizePath } from './path-utils.js';
import type { DirEntry, Stats } from './types.js';

export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_ENTRIES = 100_000;

export interface WalkMountView {
  readonly size: number;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
}

export interface WalkIndexView {
  isReady(path: string): boolean;
}

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

export interface WalkDeps {
  mountPoints: WalkMountView;
  mountIndex: WalkIndexView & { getFiles(path: string): string[] | undefined };
  realpath(p: string): Promise<string>;
  readDir(p: string): Promise<DirEntry[]>;
  stat(p: string): Promise<Stats>;
}

export async function* walk(
  deps: WalkDeps,
  path: string,
  visited?: Set<string>,
  depth = 0
): AsyncGenerator<string> {
  const normalized = normalizePath(path);

  if (canUseWalkFastPath(deps.mountPoints, deps.mountIndex, normalized)) {
    const files = deps.mountIndex.getFiles(normalized);
    if (files) {
      for (const filePath of files) yield filePath;
      return;
    }
  }

  const seen = visited ?? new Set<string>();
  if (depth > MAX_WALK_DEPTH || seen.size >= MAX_WALK_ENTRIES) return;

  const realPath = await safeRealpath((p) => deps.realpath(p), normalized);
  if (seen.has(realPath)) return;
  seen.add(realPath);

  const entries = await deps.readDir(normalized);
  for (const entry of entries) {
    const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
    yield* walkEntry(deps, entry, childPath, seen, depth + 1);
  }
}

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
  } catch {}
}
