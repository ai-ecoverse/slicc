import { describe, expect, it } from 'vitest';
import type { DirEntry, Stats } from '../../src/fs/types.js';
import {
  canUseWalkFastPath,
  MAX_WALK_DEPTH,
  type WalkDeps,
  type WalkIndexView,
  type WalkMountView,
  walk,
} from '../../src/fs/walker.js';

function entry(name: string, type: DirEntry['type']): DirEntry {
  return { name, type };
}

function statOf(type: Stats['type']): Stats {
  return { type, size: 0, mtime: 0, ctime: 0 };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

const emptyIndex: WalkIndexView & { getFiles(p: string): string[] | undefined } = {
  isReady: () => false,
  getFiles: () => undefined,
};

describe('canUseWalkFastPath', () => {
  it('is false when the path is not a mount', () => {
    const mounts: WalkMountView = new Map<string, unknown>() as unknown as WalkMountView;
    expect(canUseWalkFastPath(mounts, { isReady: () => true }, '/x')).toBe(false);
  });

  it('is true for a ready indexed mount with no nested mounts', () => {
    const mounts = new Map<string, unknown>([['/mnt', {}]]) as unknown as WalkMountView;
    expect(canUseWalkFastPath(mounts, { isReady: () => true }, '/mnt')).toBe(true);
  });

  it('is false when a nested mount exists under the path', () => {
    const mounts = new Map<string, unknown>([
      ['/mnt', {}],
      ['/mnt/inner', {}],
    ]) as unknown as WalkMountView;
    expect(canUseWalkFastPath(mounts, { isReady: () => true }, '/mnt')).toBe(false);
  });

  it('is false when the index is not ready', () => {
    const mounts = new Map<string, unknown>([['/mnt', {}]]) as unknown as WalkMountView;
    expect(canUseWalkFastPath(mounts, { isReady: () => false }, '/mnt')).toBe(false);
  });
});

describe('walk', () => {
  it('uses the index fast path when available', async () => {
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>([['/mnt', {}]]) as unknown as WalkMountView,
      mountIndex: { isReady: () => true, getFiles: () => ['/mnt/a', '/mnt/b'] },
      realpath: async (p) => p,
      readDir: async () => [],
      stat: async () => statOf('file'),
    };
    expect(await collect(walk(deps, '/mnt'))).toEqual(['/mnt/a', '/mnt/b']);
  });

  it('recurses the slow path over a small tree', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/root': [entry('dir', 'directory'), entry('f.txt', 'file')],
      '/root/dir': [entry('g.txt', 'file')],
    };
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>() as unknown as WalkMountView,
      mountIndex: emptyIndex,
      realpath: async (p) => p,
      readDir: async (p) => tree[p] ?? [],
      stat: async () => statOf('file'),
    };
    expect((await collect(walk(deps, '/root'))).sort()).toEqual(['/root/dir/g.txt', '/root/f.txt']);
  });

  it('follows a symlink entry that points at a file', async () => {
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>() as unknown as WalkMountView,
      mountIndex: emptyIndex,
      realpath: async (p) => p,
      readDir: async (p) => (p === '/root' ? [entry('link', 'symlink')] : []),
      stat: async () => statOf('file'),
    };
    expect(await collect(walk(deps, '/root'))).toEqual(['/root/link']);
  });

  it('recurses into a symlink that resolves to a directory', async () => {
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>() as unknown as WalkMountView,
      mountIndex: emptyIndex,
      realpath: async (p) => p,
      readDir: async (p) => {
        if (p === '/root') return [entry('dirlink', 'symlink')];
        if (p === '/root/dirlink') return [entry('child.txt', 'file')];
        return [];
      },
      stat: async () => statOf('directory'),
    };
    expect(await collect(walk(deps, '/root'))).toEqual(['/root/dirlink/child.txt']);
  });

  it('skips a dangling symlink whose target cannot be stat-ed', async () => {
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>() as unknown as WalkMountView,
      mountIndex: emptyIndex,
      realpath: async (p) => p,
      readDir: async (p) => (p === '/root' ? [entry('dead', 'symlink')] : []),
      stat: async () => {
        throw new Error('ENOENT');
      },
    };
    expect(await collect(walk(deps, '/root'))).toEqual([]);
  });

  it('terminates on a self-referential tree via the depth bound', async () => {
    // Every directory re-exposes a same-shaped child; realpath keeps paths
    // distinct so the visited-set can't collapse it — only the depth cap stops it.
    const deps: WalkDeps = {
      mountPoints: new Map<string, unknown>() as unknown as WalkMountView,
      mountIndex: emptyIndex,
      realpath: async (p) => p,
      readDir: async () => [entry('loop', 'directory')],
      stat: async () => statOf('directory'),
    };
    const out = await collect(walk(deps, '/root'));
    expect(out).toEqual([]); // no files, and it returns rather than looping
    expect(MAX_WALK_DEPTH).toBe(64);
  });
});
