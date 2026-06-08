/**
 * Tests for `createRemoteSprinkleVfs` — the read/write adapter that
 * lets `SprinkleManager` discover and mutate the canonical VFS over
 * the worker-RPC wire when `slicc_opfs_vfs === 'opfs'` strands the
 * page-side `localFs` as an empty memory backend.
 *
 * Covers: read pass-through, write pass-through, `exists` ENOENT and
 * non-ENOENT error swallow, and `walk` over a mixed tree containing
 * files, nested directories, symlinks (→ file, → directory, dangling),
 * and a directory `readDir` rejection (skipped, walk continues).
 */

import { describe, expect, it, vi } from 'vitest';
import type { DirEntry, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import { createRemoteSprinkleVfs } from '../../src/kernel/remote-sprinkle-vfs.js';
import type { WritableVfsBackend } from '../../src/kernel/writable-vfs-client.js';

function makeReader(overrides: Partial<LocalVfsClient> = {}): LocalVfsClient {
  return {
    readDir: vi.fn(async () => [] as DirEntry[]),
    readFile: vi.fn(async () => 'x'),
    stat: vi.fn(async () => ({ type: 'file', size: 0, mtime: 0, ctime: 0 }) as Stats),
    ...overrides,
  };
}

function makeWriter(overrides: Partial<WritableVfsBackend> = {}): WritableVfsBackend {
  return {
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createRemoteSprinkleVfs', () => {
  it('forwards read ops to the reader and write ops to the writer', async () => {
    const reader = makeReader();
    const writer = makeWriter();
    const fs = createRemoteSprinkleVfs({ reader, writer });

    await fs.readFile('/a', { encoding: 'utf-8' });
    expect(reader.readFile).toHaveBeenCalledWith('/a', { encoding: 'utf-8' });

    await fs.readDir('/d');
    expect(reader.readDir).toHaveBeenCalledWith('/d');

    await fs.stat('/s');
    expect(reader.stat).toHaveBeenCalledWith('/s');

    await fs.writeFile('/w', 'hi', { recursive: true });
    expect(writer.writeFile).toHaveBeenCalledWith('/w', 'hi', { recursive: true });

    await fs.mkdir('/m', { recursive: true });
    expect(writer.mkdir).toHaveBeenCalledWith('/m', { recursive: true });

    await fs.rm('/r', { recursive: false });
    expect(writer.rm).toHaveBeenCalledWith('/r', { recursive: false });

    await fs.flush();
    expect(writer.flush).toHaveBeenCalled();
  });

  it('exists() returns true when stat resolves', async () => {
    const reader = makeReader();
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });
    await expect(fs.exists('/yes')).resolves.toBe(true);
  });

  it('exists() returns false on FsError(ENOENT)', async () => {
    const reader = makeReader({
      stat: vi.fn(async () => {
        throw new FsError('ENOENT', 'missing', '/no');
      }),
    });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });
    await expect(fs.exists('/no')).resolves.toBe(false);
  });

  it('exists() returns false on non-ENOENT errors too (defensive)', async () => {
    const reader = makeReader({
      stat: vi.fn(async () => {
        throw new Error('transport blew up');
      }),
    });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });
    await expect(fs.exists('/boom')).resolves.toBe(false);
  });

  it('walk() yields files, recurses into directories, and joins paths from /', async () => {
    // /
    //   a.txt   (file)
    //   sub/    (dir)
    //     b.txt (file)
    const tree: Record<string, DirEntry[]> = {
      '/': [
        { name: 'a.txt', type: 'file' },
        { name: 'sub', type: 'directory' },
      ],
      '/sub': [{ name: 'b.txt', type: 'file' }],
    };
    const reader = makeReader({
      readDir: vi.fn(async (path: string) => tree[path] ?? []),
    });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });

    const seen: string[] = [];
    for await (const p of fs.walk('/')) seen.push(p);
    expect(seen.sort()).toEqual(['/a.txt', '/sub/b.txt']);
  });

  it('walk() resolves symlinks: file-target yielded, dir-target recursed, dangling skipped', async () => {
    // /root
    //   link-to-file   (symlink → /target.txt)
    //   link-to-dir    (symlink → /sub)
    //   broken         (symlink → /missing)
    // /sub
    //   inner.txt      (file)
    const tree: Record<string, DirEntry[]> = {
      '/root': [
        { name: 'link-to-file', type: 'symlink' },
        { name: 'link-to-dir', type: 'symlink' },
        { name: 'broken', type: 'symlink' },
      ],
      '/sub': [{ name: 'inner.txt', type: 'file' }],
    };
    const statMap: Record<string, Stats> = {
      '/root/link-to-file': { type: 'file', size: 1, mtime: 0, ctime: 0 },
      '/root/link-to-dir': { type: 'directory', size: 0, mtime: 0, ctime: 0 },
    };
    const reader = makeReader({
      readDir: vi.fn(async (path: string) => {
        const entries = tree[path];
        if (entries) return entries;
        // /sub via the resolved symlink — return its inner entries.
        if (path === '/root/link-to-dir') return tree['/sub'];
        return [];
      }),
      stat: vi.fn(async (path: string) => {
        if (path in statMap) return statMap[path];
        throw new FsError('ENOENT', 'missing', path);
      }),
    });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });

    const seen: string[] = [];
    for await (const p of fs.walk('/root')) seen.push(p);
    // file symlink yielded, dir symlink recursed (inner.txt), broken skipped.
    expect(seen.sort()).toEqual(['/root/link-to-dir/inner.txt', '/root/link-to-file']);
  });

  it('walk() swallows readDir rejections and continues with siblings', async () => {
    const tree: Record<string, DirEntry[]> = {
      '/': [
        { name: 'good', type: 'directory' },
        { name: 'bad', type: 'directory' },
      ],
      '/good': [{ name: 'ok.txt', type: 'file' }],
    };
    const reader = makeReader({
      readDir: vi.fn(async (path: string) => {
        if (path === '/bad') throw new FsError('EACCES', 'denied', path);
        return tree[path] ?? [];
      }),
    });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });

    const seen: string[] = [];
    for await (const p of fs.walk('/')) seen.push(p);
    expect(seen).toEqual(['/good/ok.txt']);
  });

  it('walk() de-duplicates already-visited directories', async () => {
    const readDir = vi.fn(async (path: string) => {
      if (path === '/') return [{ name: 'only.txt', type: 'file' as const }];
      return [] as DirEntry[];
    });
    const reader = makeReader({ readDir });
    const fs = createRemoteSprinkleVfs({ reader, writer: makeWriter() });

    const seen: string[] = [];
    for await (const p of fs.walk('/')) seen.push(p);
    expect(seen).toEqual(['/only.txt']);
    expect(readDir).toHaveBeenCalledTimes(1);
  });
});
