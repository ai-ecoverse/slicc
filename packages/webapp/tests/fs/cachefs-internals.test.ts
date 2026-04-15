/**
 * CacheFS internal structure canary tests.
 *
 * VirtualFS.readDirSync/statSync/lstatSync reach into LightningFS private
 * internals (PromisifiedFS._backend._cache) for synchronous file-tree access.
 * These tests validate the internal structure so that a LightningFS upgrade
 * that changes the CacheFS layout is caught immediately rather than silently
 * degrading to the async fallback.
 *
 * If these tests break after upgrading @isomorphic-git/lightning-fs, update
 * VirtualFS.getCacheFS() and the sync methods to match the new layout.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

const STAT = 0; // CacheFS uses numeric key 0 for stat entries

describe('CacheFS internal structure', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-cachefs-internals', wipe: true });
  });

  afterEach(async () => {
    await vfs.dispose();
    await new Promise((r) => setTimeout(r, 600));
  });

  function getCache(): any {
    return (vfs as any).lfs._backend._cache;
  }

  it('_backend._cache exists and is activated after create', () => {
    const cache = getCache();
    expect(cache).toBeDefined();
    expect(cache.activated).toBe(true);
  });

  it('_root is a Map with "/" key', () => {
    const cache = getCache();
    expect(cache._root).toBeInstanceOf(Map);
    expect(cache._root.has('/')).toBe(true);
  });

  it('root directory entry has STAT key 0 with type "dir"', () => {
    const root = getCache()._root.get('/');
    expect(root).toBeInstanceOf(Map);
    const stat = root.get(STAT);
    expect(stat).toBeDefined();
    expect(stat.type).toBe('dir');
    expect(typeof stat.mode).toBe('number');
    expect(typeof stat.mtimeMs).toBe('number');
  });

  it('file entries have type "file" with size and ino', async () => {
    await vfs.writeFile('/hello.txt', 'world');
    const root = getCache()._root.get('/');
    const entry = root.get('hello.txt');
    expect(entry).toBeInstanceOf(Map);
    const stat = entry.get(STAT);
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(5);
    expect(typeof stat.ino).toBe('number');
    expect(stat.ino).toBeGreaterThan(0);
  });

  it('directory entries have type "dir" with nested children', async () => {
    await vfs.writeFile('/project/src/index.ts', 'export {}');
    const root = getCache()._root.get('/');
    const project = root.get('project');
    expect(project).toBeInstanceOf(Map);
    expect(project.get(STAT).type).toBe('dir');
    const src = project.get('src');
    expect(src).toBeInstanceOf(Map);
    expect(src.get(STAT).type).toBe('dir');
    const indexTs = src.get('index.ts');
    expect(indexTs.get(STAT).type).toBe('file');
  });

  it('symlink entries have type "symlink" with target property', async () => {
    await vfs.writeFile('/target.txt', 'data');
    await vfs.symlink('/target.txt', '/link.txt');
    const root = getCache()._root.get('/');
    const link = root.get('link.txt');
    expect(link).toBeInstanceOf(Map);
    const stat = link.get(STAT);
    expect(stat.type).toBe('symlink');
    expect(stat.target).toBe('/target.txt');
  });

  it('readdir() is synchronous and returns string array of child names', async () => {
    await vfs.writeFile('/dir/a.txt', 'a');
    await vfs.writeFile('/dir/b.txt', 'b');
    const cache = getCache();
    const names = cache.readdir('/dir');
    expect(Array.isArray(names)).toBe(true);
    expect(names.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('stat() is synchronous, follows symlinks, returns stat object', async () => {
    await vfs.writeFile('/real.txt', 'content');
    await vfs.symlink('/real.txt', '/sym.txt');
    const cache = getCache();
    const stat = cache.stat('/sym.txt');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe(7);
  });

  it('lstat() is synchronous, does NOT follow symlinks', async () => {
    await vfs.writeFile('/real.txt', 'data');
    await vfs.symlink('/real.txt', '/sym.txt');
    const cache = getCache();
    const stat = cache.lstat('/sym.txt');
    expect(stat.type).toBe('symlink');
    expect(stat.target).toBe('/real.txt');
  });

  it('readdir() follows symlinks in the directory path', async () => {
    await vfs.writeFile('/actual/file.txt', 'f');
    await vfs.symlink('/actual', '/alias');
    const cache = getCache();
    const names = cache.readdir('/alias');
    expect(names).toContain('file.txt');
  });
});
