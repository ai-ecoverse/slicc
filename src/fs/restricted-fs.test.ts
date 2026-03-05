/**
 * Tests for RestrictedFS path access control.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from './virtual-fs.js';
import { RestrictedFS } from './restricted-fs.js';

describe('RestrictedFS', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs', wipe: true });
    // Set up directory structure
    await vfs.mkdir('/scoops/andy-scoop', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.mkdir('/scoops/other-scoop', { recursive: true });
    await vfs.writeFile('/scoops/andy-scoop/file.txt', 'hello');
    await vfs.writeFile('/shared/data.txt', 'shared data');
    await vfs.writeFile('/scoops/other-scoop/secret.txt', 'secret');
    await vfs.writeFile('/root-file.txt', 'root');

    restricted = new RestrictedFS(vfs, ['/scoops/andy-scoop/', '/shared/']);
  });

  it('reads files within allowed dirs', async () => {
    const content = await restricted.readFile('/scoops/andy-scoop/file.txt', { encoding: 'utf-8' });
    expect(content).toBe('hello');
  });

  it('reads files in shared dir', async () => {
    const content = await restricted.readFile('/shared/data.txt', { encoding: 'utf-8' });
    expect(content).toBe('shared data');
  });

  it('throws ENOENT for reads outside allowed dirs (not EACCES)', async () => {
    await expect(restricted.readFile('/scoops/other-scoop/secret.txt')).rejects.toThrow('ENOENT');
  });

  it('throws ENOENT for root-level reads', async () => {
    await expect(restricted.readFile('/root-file.txt')).rejects.toThrow('ENOENT');
  });

  it('prevents path traversal (returns ENOENT)', async () => {
    await expect(restricted.readFile('/scoops/andy-scoop/../../root-file.txt')).rejects.toThrow('ENOENT');
  });

  it('returns false for exists() outside allowed dirs', async () => {
    expect(await restricted.exists('/scoops/other-scoop/secret.txt')).toBe(false);
    expect(await restricted.exists('/usr/bin/mkdir')).toBe(false);
  });

  it('returns empty array for readDir outside allowed dirs', async () => {
    const entries = await restricted.readDir('/usr/bin');
    expect(entries).toEqual([]);
  });

  it('writes within allowed dirs', async () => {
    await restricted.writeFile('/scoops/andy-scoop/new.txt', 'new content');
    const content = await vfs.readFile('/scoops/andy-scoop/new.txt', { encoding: 'utf-8' });
    expect(content).toBe('new content');
  });

  it('prevents writing outside allowed dirs', async () => {
    await expect(restricted.writeFile('/scoops/other-scoop/hack.txt', 'hacked')).rejects.toThrow('EACCES');
  });

  it('allows stat on allowed directory root', async () => {
    const stat = await restricted.stat('/scoops/andy-scoop');
    expect(stat.type).toBe('directory');
  });

  it('allows readDir on allowed dirs', async () => {
    const entries = await restricted.readDir('/scoops/andy-scoop');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('walk only yields files within allowed paths', async () => {
    // Write a file in shared too
    await vfs.writeFile('/shared/walk-test.txt', 'walkable');
    const files: string[] = [];
    for await (const f of restricted.walk('/shared')) {
      files.push(f);
    }
    expect(files).toContain('/shared/walk-test.txt');
    expect(files).toContain('/shared/data.txt');
  });

  it('getUnderlyingFS returns the raw VFS', () => {
    expect(restricted.getUnderlyingFS()).toBe(vfs);
  });

  it('rename checks both paths', async () => {
    await restricted.writeFile('/scoops/andy-scoop/rename-src.txt', 'src');
    // Rename within allowed - should work
    await restricted.rename('/scoops/andy-scoop/rename-src.txt', '/scoops/andy-scoop/rename-dest.txt');
    const content = await restricted.readFile('/scoops/andy-scoop/rename-dest.txt', { encoding: 'utf-8' });
    expect(content).toBe('src');

    // Rename to outside - should fail
    await restricted.writeFile('/scoops/andy-scoop/escape.txt', 'escape');
    await expect(restricted.rename('/scoops/andy-scoop/escape.txt', '/root-escape.txt')).rejects.toThrow('EACCES');
  });
});
