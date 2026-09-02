/**
 * `walkBounded` — a depth-capped, skip-list-aware directory walk over any
 * `readDir` + `stat` pair: the real `VirtualFS`, or the worker-RPC-backed
 * adapter in `kernel/remote-sprinkle-vfs.ts`.
 *
 * Why this exists (issue #2717): the page-side sprinkle discovery used to
 * walk `/`, and every directory it touched cost one page→worker RPC plus,
 * under a `--mount`ed host folder, one `/api/hostfs/list` request. On a
 * mounted checkout that meant descending into `node_modules/…/.build/…`
 * at depth 11 — tens of thousands of requests queued into the browser's
 * 6-connection pool alongside the cone's own commands. A walk that can be
 * pointed at a mount MUST be able to say how deep it goes and what it
 * refuses to enter.
 *
 * Yield semantics match `VirtualFS.walk`: files and file-symlinks are
 * yielded, directories and directory-symlinks are recursed, broken
 * symlinks and unreadable directories are skipped.
 */

import type { DirEntry, EntryType } from './types.js';
import { MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from './walker.js';

/**
 * Directory basenames never entered by default discovery walks (sprinkle
 * scan, MountIndex). Dot-directories (`.git`, `.build`, `.venv`, …) are
 * skipped separately via {@link shouldSkipNoiseDir}. Shared so callers do
 * not grow a third copy of the same list (issue #2764 / #2717).
 */
export const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * True for build-output directory names and any dot-directory. Used as the
 * default `skip` predicate for bounded walks and MountIndex ingestion.
 */
export function shouldSkipNoiseDir(name: string): boolean {
  return name.startsWith('.') || DEFAULT_SKIP_DIRS.has(name);
}

/** Minimal read surface the bounded walker needs. */
export interface BoundedWalkReader {
  readDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ type: EntryType }>;
}

export interface BoundedWalkOptions {
  /**
   * Deepest entry the walk may touch, counting the root's own children
   * as depth 1. The cap applies to FILES as well as directories: with
   * `maxDepth: 2`, `<root>/a/file` and `<root>/a/b` are reached but
   * `<root>/a/b/file` is not. A directory sitting AT the cap can only
   * hold entries past it, so it is never read at all. `0` reads the
   * root and yields nothing. Defaults to `MAX_WALK_DEPTH`, the same
   * ceiling `VirtualFS.walk` applies.
   */
  maxDepth?: number;
  /**
   * Prune predicate for directories, called with the entry basename and
   * its full path. Returning `true` skips the whole subtree — no
   * `readDir` is ever issued for it.
   */
  skip?: (name: string, path: string) => boolean;
  /**
   * Hard cap on directories read, so a pathological tree (or a mount
   * that keeps growing under the walk) can't fan out without limit.
   * Defaults to `MAX_WALK_ENTRIES`.
   */
  maxDirs?: number;
}

/** A directory queued for reading, with its depth below the walk root. */
interface Frame {
  dir: string;
  depth: number;
}

/** Resolved limits, threaded through the recursion helpers. */
interface Limits {
  maxDepth: number;
  skip?: (name: string, path: string) => boolean;
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** `readDir` that returns null on any rejection (the walk skips that dir). */
async function safeReadDir(reader: BoundedWalkReader, dir: string): Promise<DirEntry[] | null> {
  try {
    return await reader.readDir(dir);
  } catch {
    return null;
  }
}

/**
 * Queue a directory unless it is on the skip list or its own children
 * would already be past the depth cap — reading a directory at the cap
 * would spend an RPC (and, under a mount, an HTTP request) on entries
 * the walk must then discard.
 */
function pushDir(stack: Frame[], name: string, path: string, depth: number, limits: Limits): void {
  if (depth >= limits.maxDepth) return;
  if (limits.skip?.(name, path)) return;
  stack.push({ dir: path, depth });
}

/**
 * Follow a symlink: yield it if it resolves to a file, queue it if it
 * resolves to a directory, skip it if it dangles.
 */
async function* walkSymlink(
  reader: BoundedWalkReader,
  name: string,
  child: string,
  depth: number,
  stack: Frame[],
  limits: Limits
): AsyncGenerator<string> {
  try {
    const s = await reader.stat(child);
    if (s.type === 'file') {
      yield child;
      return;
    }
    if (s.type === 'directory') pushDir(stack, name, child, depth, limits);
  } catch {
    /* dangling symlink — skip, matches VirtualFS.walk */
  }
}

/**
 * Yield or queue a single `DirEntry`. The depth cap is enforced HERE,
 * before the entry is yielded, so a file is bounded exactly like a
 * directory — `pushDir` alone would let the children of a directory
 * read at the cap slip out one level too deep.
 */
async function* walkEntry(
  reader: BoundedWalkReader,
  entry: DirEntry,
  child: string,
  depth: number,
  stack: Frame[],
  limits: Limits
): AsyncGenerator<string> {
  if (depth > limits.maxDepth) return;
  if (entry.type === 'file') {
    yield child;
    return;
  }
  if (entry.type === 'directory') {
    pushDir(stack, entry.name, child, depth, limits);
    return;
  }
  if (entry.type === 'symlink') {
    yield* walkSymlink(reader, entry.name, child, depth, stack, limits);
  }
}

/**
 * Iterative walk of `root`, honouring `maxDepth`, `skip` and `maxDirs`.
 * Already-visited directories are read once, so symlink loops terminate.
 */
export async function* walkBounded(
  reader: BoundedWalkReader,
  root: string,
  options: BoundedWalkOptions = {}
): AsyncGenerator<string> {
  const limits: Limits = { maxDepth: options.maxDepth ?? MAX_WALK_DEPTH, skip: options.skip };
  const maxDirs = options.maxDirs ?? MAX_WALK_ENTRIES;
  const stack: Frame[] = [{ dir: root, depth: 0 }];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (visited.has(frame.dir)) continue;
    visited.add(frame.dir);
    if (visited.size > maxDirs) return;
    const entries = await safeReadDir(reader, frame.dir);
    if (!entries) continue;
    for (const entry of entries) {
      const child = joinPath(frame.dir, entry.name);
      yield* walkEntry(reader, entry, child, frame.depth + 1, stack, limits);
    }
  }
}
