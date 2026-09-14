import type { DirEntry, EntryType } from './types.js';
import { MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from './walker.js';

export const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

export function shouldSkipNoiseDir(name: string): boolean {
  return name.startsWith('.') || DEFAULT_SKIP_DIRS.has(name);
}

export interface BoundedWalkReader {
  readDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ type: EntryType }>;
}

export interface BoundedWalkOptions {
  maxDepth?: number;

  skip?: (name: string, path: string) => boolean;

  maxDirs?: number;
}

interface Frame {
  dir: string;
  depth: number;
}

interface Limits {
  maxDepth: number;
  skip?: (name: string, path: string) => boolean;
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

async function safeReadDir(reader: BoundedWalkReader, dir: string): Promise<DirEntry[] | null> {
  try {
    return await reader.readDir(dir);
  } catch {
    return null;
  }
}

function pushDir(stack: Frame[], name: string, path: string, depth: number, limits: Limits): void {
  if (depth >= limits.maxDepth) return;
  if (limits.skip?.(name, path)) return;
  stack.push({ dir: path, depth });
}

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
  } catch {}
}

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
