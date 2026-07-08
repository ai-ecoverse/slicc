/**
 * Unit tests for SyncFsCache — the pure in-memory FS tree backing
 * synchronous fs APIs in the realm.
 */

import { describe, expect, it } from 'vitest';
import { SyncFsCache, type SyncFsSnapshot } from '../../../src/kernel/realm/sync-fs-cache.js';

function textEntry(path: string, text: string, isDirectory = false) {
  return { path, content: new TextEncoder().encode(text), isDirectory };
}

function textOf(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

function emptySnapshot(): SyncFsSnapshot {
  return { entries: [] };
}

describe('SyncFsCache', () => {
  it('readFile sees writeFile within same execution', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('hello'));
    expect(textOf(cache.readFile('/workspace/a.txt'))).toBe('hello');
  });

  it('readFile throws ENOENT for missing file', () => {
    const cache = new SyncFsCache(emptySnapshot());
    expect(() => cache.readFile('/workspace/missing.txt')).toThrow();
    try {
      cache.readFile('/workspace/missing.txt');
      throw new Error('expected readFile to throw');
    } catch (e: any) {
      expect(e.code).toBe('ENOENT');
    }
  });

  it('existsSync returns false for missing, true after writeFile', () => {
    const cache = new SyncFsCache(emptySnapshot());
    expect(cache.exists('/workspace/x.txt')).toBe(false);
    cache.writeFile('/workspace/x.txt', new Uint8Array());
    expect(cache.exists('/workspace/x.txt')).toBe(true);
  });

  it('mkdir + readdir lists entries', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    cache.writeFile('/workspace/dir/b.txt', new Uint8Array());
    expect(cache.readdir('/workspace/dir').sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('mkdir recursive creates intermediate dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/a/b/c', true);
    expect(cache.exists('/workspace/a')).toBe(true);
    expect(cache.exists('/workspace/a/b')).toBe(true);
    expect(cache.exists('/workspace/a/b/c')).toBe(true);
    expect(cache.stat('/workspace/a/b/c').isDirectory).toBe(true);
  });

  it('rm removes files from cache', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new Uint8Array());
    cache.rm('/workspace/f.txt');
    expect(cache.exists('/workspace/f.txt')).toBe(false);
  });

  it('rm recursive removes dir and children', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    cache.rm('/workspace/dir', true);
    expect(cache.exists('/workspace/dir')).toBe(false);
    expect(cache.exists('/workspace/dir/a.txt')).toBe(false);
  });

  it('rm non-recursive throws on non-empty dir', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    expect(() => cache.rm('/workspace/dir')).toThrow();
  });

  it('copyFile copies content', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/src.txt', new TextEncoder().encode('content'));
    cache.copyFile('/workspace/src.txt', '/workspace/dest.txt');
    expect(textOf(cache.readFile('/workspace/dest.txt'))).toBe('content');
  });

  it('rename moves a file', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/old.txt', new TextEncoder().encode('data'));
    cache.rename('/workspace/old.txt', '/workspace/new.txt');
    expect(cache.exists('/workspace/old.txt')).toBe(false);
    expect(textOf(cache.readFile('/workspace/new.txt'))).toBe('data');
  });

  it('unlink removes file, throws on directory', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new Uint8Array());
    cache.unlink('/workspace/f.txt');
    expect(cache.exists('/workspace/f.txt')).toBe(false);

    cache.mkdir('/workspace/dir');
    expect(() => cache.unlink('/workspace/dir')).toThrow();
  });

  it('mkdtemp creates unique dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    const dir1 = cache.mkdtemp('/workspace/test-');
    const dir2 = cache.mkdtemp('/workspace/test-');
    expect(dir1).not.toBe(dir2);
    expect(cache.exists(dir1)).toBe(true);
    expect(cache.exists(dir2)).toBe(true);
    expect(cache.stat(dir1).isDirectory).toBe(true);
  });

  it('stat returns correct shape for files and dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new TextEncoder().encode('abc'));
    const fileStat = cache.stat('/workspace/f.txt');
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.size).toBe(3);

    cache.mkdir('/workspace/dir');
    const dirStat = cache.stat('/workspace/dir');
    expect(dirStat.isFile).toBe(false);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.size).toBe(0);

    expect(() => cache.stat('/workspace/missing')).toThrow();
  });

  it('getMutations: new file shows as created', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/new.txt', new TextEncoder().encode('x'));
    const mutations = cache.getMutations();
    expect(mutations.created.map((c) => c.path)).toContain('/workspace/new.txt');
    expect(mutations.modified).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: modified file shows as modified', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'old')] });
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('new'));
    const mutations = cache.getMutations();
    expect(mutations.modified.map((m) => m.path)).toContain('/workspace/a.txt');
    expect(mutations.created).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: deleted file shows as deleted', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'x')] });
    cache.unlink('/workspace/a.txt');
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a.txt');
    expect(mutations.created).toEqual([]);
    expect(mutations.modified).toEqual([]);
  });

  it('getMutations: unmodified file not in any list', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'x')] });
    const mutations = cache.getMutations();
    expect(mutations.created).toEqual([]);
    expect(mutations.modified).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: file replaced by directory emits delete + create', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a', 'x')] });
    cache.unlink('/workspace/a');
    cache.mkdir('/workspace/a', true);
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a');
    expect(mutations.created.map((c) => c.path)).toContain('/workspace/a');
    const created = mutations.created.find((c) => c.path === '/workspace/a');
    expect(created?.isDirectory).toBe(true);
  });

  it('getMutations: directory replaced by file emits delete + create', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a', '', true)] });
    cache.rm('/workspace/a', true);
    cache.writeFile('/workspace/a', new TextEncoder().encode('now a file'));
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a');
    const created = mutations.created.find((c) => c.path === '/workspace/a');
    expect(created?.isDirectory).toBe(false);
    expect(textOf(created!.content)).toBe('now a file');
  });

  it('mkdtemp retries on collision with an already-existing path', () => {
    const cache = new SyncFsCache(emptySnapshot());
    // Pre-create the path the first mkdtemp attempt would generate so the
    // implementation is forced to retry with an incremented counter.
    cache.mkdir('/workspace/test-_000000', true);
    const dir = cache.mkdtemp('/workspace/test-');
    expect(dir).not.toBe('/workspace/test-_000000');
    expect(cache.exists(dir)).toBe(true);
  });

  it('exists/stat report truncated files, readFile throws ENOSYNC', () => {
    const cache = new SyncFsCache({
      entries: [
        {
          path: '/workspace/big.bin',
          content: new Uint8Array(0),
          isDirectory: false,
          truncated: true,
        },
      ],
    });
    expect(cache.exists('/workspace/big.bin')).toBe(true);
    const stat = cache.stat('/workspace/big.bin');
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(0);
    try {
      cache.readFile('/workspace/big.bin');
      throw new Error('expected readFile to throw');
    } catch (e: any) {
      expect(e.code).toBe('ENOSYNC');
    }
  });

  it('path normalization handles trailing slashes, .. segments', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/a/../b.txt', new TextEncoder().encode('v'));
    expect(cache.exists('/workspace/b.txt')).toBe(true);
    expect(cache.exists('/workspace/b.txt/')).toBe(true);

    cache.mkdir('/workspace/dir/');
    expect(cache.exists('/workspace/dir')).toBe(true);
  });
});
