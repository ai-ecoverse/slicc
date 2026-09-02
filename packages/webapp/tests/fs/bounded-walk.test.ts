/**
 * `walkBounded` — the depth-capped, skip-list-aware walk that replaced
 * sprinkle discovery's `walk('/')` (issue #2717).
 *
 * The reader is a plain in-memory tree so each test can count exactly
 * how many `readDir` calls the walk issued — on the page side every one
 * of those is a worker RPC and, under a `--mount`, an `/api/hostfs/list`
 * request, which is the cost this module exists to bound.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKIP_DIRS, shouldSkipNoiseDir, walkBounded } from '../../src/fs/bounded-walk.js';
import type { DirEntry, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';

function makeReader(tree: Record<string, DirEntry[]>, statMap: Record<string, Stats> = {}) {
  return {
    readDir: vi.fn(async (path: string): Promise<DirEntry[]> => tree[path] ?? []),
    stat: vi.fn(async (path: string): Promise<Stats> => {
      const s = statMap[path];
      if (!s) throw new FsError('ENOENT', 'missing', path);
      return s;
    }),
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of gen) out.push(p);
  return out.sort();
}

describe('shouldSkipNoiseDir', () => {
  it('skips the shared build-output set and every dot-directory', () => {
    for (const name of DEFAULT_SKIP_DIRS) {
      expect(shouldSkipNoiseDir(name)).toBe(true);
    }
    expect(shouldSkipNoiseDir('.git')).toBe(true);
    expect(shouldSkipNoiseDir('.build')).toBe(true);
    expect(shouldSkipNoiseDir('src')).toBe(false);
    expect(shouldSkipNoiseDir('README.md')).toBe(false);
  });
});

describe('walkBounded', () => {
  it('yields files and recurses into directories', async () => {
    const reader = makeReader({
      '/root': [
        { name: 'a.txt', type: 'file' },
        { name: 'sub', type: 'directory' },
      ],
      '/root/sub': [{ name: 'b.txt', type: 'file' }],
    });
    expect(await collect(walkBounded(reader, '/root'))).toEqual(['/root/a.txt', '/root/sub/b.txt']);
  });

  it('joins paths correctly from the filesystem root', async () => {
    const reader = makeReader({ '/': [{ name: 'a.txt', type: 'file' }] });
    expect(await collect(walkBounded(reader, '/'))).toEqual(['/a.txt']);
  });

  it('maxDepth: 1 reads only the root directory', async () => {
    const reader = makeReader({
      '/root': [
        { name: 'a.txt', type: 'file' },
        { name: 'sub', type: 'directory' },
      ],
      '/root/sub': [{ name: 'b.txt', type: 'file' }],
    });
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 1 }))).toEqual(['/root/a.txt']);
    // `sub` sits AT the cap, so it is never worth an RPC.
    expect(reader.readDir).toHaveBeenCalledTimes(1);
  });

  it('maxDepth: 0 yields nothing — every child of the root is already past it', async () => {
    const reader = makeReader({ '/root': [{ name: 'a.txt', type: 'file' }] });
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 0 }))).toEqual([]);
  });

  it('maxDepth caps FILES, not just directories', async () => {
    // The boundary Codex flagged on #2725: reading a directory at the cap
    // used to leak its files out one level too deep.
    const reader = makeReader({
      '/root': [{ name: 'a', type: 'directory' }],
      '/root/a': [
        { name: 'at-cap.txt', type: 'file' },
        { name: 'b', type: 'directory' },
      ],
      '/root/a/b': [{ name: 'past-cap.txt', type: 'file' }],
    });
    // Depth 2 = `/root/a/at-cap.txt`; `/root/a/b/past-cap.txt` is depth 3.
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 2 }))).toEqual([
      '/root/a/at-cap.txt',
    ]);
    expect(reader.readDir).not.toHaveBeenCalledWith('/root/a/b');
  });

  it('accepts a file exactly at maxDepth and rejects the next level down', async () => {
    const reader = makeReader({
      '/root': [{ name: 'a', type: 'directory' }],
      '/root/a': [{ name: 'b', type: 'directory' }],
      '/root/a/b': [
        { name: 'at-cap.txt', type: 'file' },
        { name: 'c', type: 'directory' },
      ],
      '/root/a/b/c': [{ name: 'past-cap.txt', type: 'file' }],
    });
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 3 }))).toEqual([
      '/root/a/b/at-cap.txt',
    ]);
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 4 }))).toEqual([
      '/root/a/b/at-cap.txt',
      '/root/a/b/c/past-cap.txt',
    ]);
  });

  it('caps file symlinks at the same depth as plain files', async () => {
    const reader = makeReader(
      {
        '/root': [{ name: 'a', type: 'directory' }],
        '/root/a': [{ name: 'link', type: 'symlink' }],
      },
      { '/root/a/link': { type: 'file', size: 1, mtime: 0, ctime: 0 } }
    );
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 2 }))).toEqual(['/root/a/link']);
    expect(await collect(walkBounded(reader, '/root', { maxDepth: 1 }))).toEqual([]);
  });

  it('skip prunes a subtree without ever reading it', async () => {
    const reader = makeReader({
      '/root': [
        { name: 'node_modules', type: 'directory' },
        { name: 'src', type: 'directory' },
      ],
      '/root/node_modules': [{ name: 'vendored.txt', type: 'file' }],
      '/root/src': [{ name: 'kept.txt', type: 'file' }],
    });
    const skip = (name: string) => name === 'node_modules';
    expect(await collect(walkBounded(reader, '/root', { skip }))).toEqual(['/root/src/kept.txt']);
    expect(reader.readDir).not.toHaveBeenCalledWith('/root/node_modules');
  });

  it('skip receives the full path as well as the basename', async () => {
    const reader = makeReader({
      '/root': [{ name: 'build', type: 'directory' }],
      '/root/build': [{ name: 'out.txt', type: 'file' }],
    });
    const skip = vi.fn(() => false);
    await collect(walkBounded(reader, '/root', { skip }));
    expect(skip).toHaveBeenCalledWith('build', '/root/build');
  });

  it('maxDirs caps the total number of directories read', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/root': Array.from({ length: 20 }, (_, i) => ({
        name: `d${i}`,
        type: 'directory' as const,
      })),
    };
    for (let i = 0; i < 20; i++) tree[`/root/d${i}`] = [{ name: 'f.txt', type: 'file' }];
    const reader = makeReader(tree);
    const seen = await collect(walkBounded(reader, '/root', { maxDirs: 5 }));
    expect(reader.readDir).toHaveBeenCalledTimes(5);
    expect(seen.length).toBe(4); // root + 4 subdirs read, one file each
  });

  it('resolves symlinks: file yielded, directory recursed, dangling skipped', async () => {
    const reader = makeReader(
      {
        '/root': [
          { name: 'to-file', type: 'symlink' },
          { name: 'to-dir', type: 'symlink' },
          { name: 'broken', type: 'symlink' },
        ],
        '/root/to-dir': [{ name: 'inner.txt', type: 'file' }],
      },
      {
        '/root/to-file': { type: 'file', size: 1, mtime: 0, ctime: 0 },
        '/root/to-dir': { type: 'directory', size: 0, mtime: 0, ctime: 0 },
      }
    );
    expect(await collect(walkBounded(reader, '/root'))).toEqual([
      '/root/to-dir/inner.txt',
      '/root/to-file',
    ]);
  });

  it('applies skip and maxDepth to directory symlinks too', async () => {
    const reader = makeReader(
      {
        '/root': [{ name: 'node_modules', type: 'symlink' }],
        '/root/node_modules': [{ name: 'vendored.txt', type: 'file' }],
      },
      { '/root/node_modules': { type: 'directory', size: 0, mtime: 0, ctime: 0 } }
    );
    const skip = (name: string) => name === 'node_modules';
    expect(await collect(walkBounded(reader, '/root', { skip }))).toEqual([]);
    expect(reader.readDir).not.toHaveBeenCalledWith('/root/node_modules');
  });

  it('swallows readDir rejections and continues with siblings', async () => {
    const reader = makeReader({
      '/root': [
        { name: 'good', type: 'directory' },
        { name: 'bad', type: 'directory' },
      ],
      '/root/good': [{ name: 'ok.txt', type: 'file' }],
    });
    reader.readDir.mockImplementation(async (path: string) => {
      if (path === '/root/bad') throw new FsError('EACCES', 'denied', path);
      if (path === '/root')
        return [
          { name: 'good', type: 'directory' },
          { name: 'bad', type: 'directory' },
        ];
      if (path === '/root/good') return [{ name: 'ok.txt', type: 'file' }];
      return [];
    });
    expect(await collect(walkBounded(reader, '/root'))).toEqual(['/root/good/ok.txt']);
  });

  it('reads an already-visited directory only once', async () => {
    const reader = makeReader({ '/': [{ name: 'only.txt', type: 'file' }] });
    expect(await collect(walkBounded(reader, '/'))).toEqual(['/only.txt']);
    expect(reader.readDir).toHaveBeenCalledTimes(1);
  });
});
