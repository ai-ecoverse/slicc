/**
 * Tests for RestrictedFS path access control.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';

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
    await expect(restricted.readFile('/scoops/andy-scoop/../../root-file.txt')).rejects.toThrow(
      'ENOENT'
    );
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
    await expect(restricted.writeFile('/scoops/other-scoop/hack.txt', 'hacked')).rejects.toThrow(
      'EACCES'
    );
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

  // ── Parent directory traversal (needed for cd) ──────────────────────

  it('stat on parent dir of allowed path works (cd needs this)', async () => {
    // /scoops is parent of /scoops/andy-scoop/ — stat should succeed
    const stat = await restricted.stat('/scoops');
    expect(stat.type).toBe('directory');
  });

  it('stat on root works (parent of all paths)', async () => {
    const stat = await restricted.stat('/');
    expect(stat.type).toBe('directory');
  });

  it('exists on parent dir returns true', async () => {
    expect(await restricted.exists('/scoops')).toBe(true);
  });

  it('readDir on parent dir filters to only allowed children', async () => {
    // /scoops has andy-scoop and other-scoop, but restricted should only show andy-scoop
    const entries = await restricted.readDir('/scoops');
    const names = entries.map((e) => e.name);
    expect(names).toContain('andy-scoop');
    expect(names).not.toContain('other-scoop');
  });

  it('readDir on root filters to relevant children', async () => {
    const entries = await restricted.readDir('/');
    const names = entries.map((e) => e.name);
    // /scoops and /shared lead toward allowed paths
    expect(names).toContain('scoops');
    expect(names).toContain('shared');
    // root-file.txt does NOT lead toward allowed paths
    expect(names).not.toContain('root-file.txt');
  });

  // ── Write protection on parent dirs ─────────────────────────────────

  it('mkdir on parent dir is blocked (EACCES)', async () => {
    await expect(restricted.mkdir('/other-top-dir')).rejects.toThrow('EACCES');
  });

  it('writeFile to parent dir is blocked (EACCES)', async () => {
    await expect(restricted.writeFile('/scoops/hack.txt', 'nope')).rejects.toThrow('EACCES');
  });

  it('rm on parent dir is blocked (EACCES)', async () => {
    await expect(restricted.rm('/scoops')).rejects.toThrow('EACCES');
  });

  // ── readTextFile strict check ───────────────────────────────────────

  it('readTextFile works within allowed dirs', async () => {
    const content = await restricted.readTextFile('/scoops/andy-scoop/file.txt');
    expect(content).toBe('hello');
  });

  it('readTextFile throws ENOENT for parent dirs (no reading parent files)', async () => {
    await vfs.writeFile('/scoops/secret-at-parent.txt', 'nope');
    await expect(restricted.readTextFile('/scoops/secret-at-parent.txt')).rejects.toThrow('ENOENT');
  });

  // ── getLightningFS delegation ───────────────────────────────────────

  it('getLightningFS returns the underlying LightningFS', () => {
    const lfs = restricted.getLightningFS();
    expect(lfs).toBeDefined();
    expect(typeof lfs.readFile).toBe('function');
  });

  // ── copyFile source/dest checks ─────────────────────────────────────

  it('copyFile within allowed dirs works', async () => {
    await restricted.writeFile('/scoops/andy-scoop/copy-src.txt', 'copy me');
    await restricted.copyFile('/scoops/andy-scoop/copy-src.txt', '/shared/copy-dest.txt');
    const content = await vfs.readFile('/shared/copy-dest.txt', { encoding: 'utf-8' });
    expect(content).toBe('copy me');
  });

  it('copyFile to outside dir throws EACCES', async () => {
    await expect(
      restricted.copyFile('/scoops/andy-scoop/file.txt', '/scoops/other-scoop/stolen.txt')
    ).rejects.toThrow('EACCES');
  });

  it('copyFile from outside dir throws ENOENT', async () => {
    await expect(
      restricted.copyFile('/scoops/other-scoop/secret.txt', '/scoops/andy-scoop/got-it.txt')
    ).rejects.toThrow('ENOENT');
  });

  // ── Mount path access (dynamic read-only) ──────────────────────────

  describe('mount paths as dynamic read-only prefixes', () => {
    let mountVfs: VirtualFS;
    let mountRestricted: RestrictedFS;

    beforeAll(async () => {
      mountVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-mounts', wipe: true });
      await mountVfs.mkdir('/scoops/scoop-a', { recursive: true });
      await mountVfs.writeFile('/scoops/scoop-a/file.txt', 'scoop file');

      // Simulate a mount by creating the directory and adding files,
      // then registering it as a mount point via the VFS mount mechanism.
      // Since we can't use real FileSystemDirectoryHandle in tests, we
      // create the content in LFS and mock listMounts to include the path.
      await mountVfs.mkdir('/mnt/kb', { recursive: true });
      await mountVfs.writeFile('/mnt/kb/README.md', 'mount readme');
      await mountVfs.writeFile('/mnt/kb/data.json', '{"key":"value"}');

      // Spy on listMounts to return our simulated mount path
      const originalListMounts = mountVfs.listMounts.bind(mountVfs);
      mountVfs.listMounts = () => [...originalListMounts(), '/mnt/kb'];

      mountRestricted = new RestrictedFS(mountVfs, ['/scoops/scoop-a/']);
    });

    it('readFile on a mounted path succeeds', async () => {
      const content = await mountRestricted.readFile('/mnt/kb/README.md', { encoding: 'utf-8' });
      expect(content).toBe('mount readme');
    });

    it('writeFile on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.writeFile('/mnt/kb/new.txt', 'nope')).rejects.toThrow('EACCES');
    });

    it('readDir on a mounted path returns entries', async () => {
      const entries = await mountRestricted.readDir('/mnt/kb');
      const names = entries.map((e) => e.name);
      expect(names).toContain('README.md');
      expect(names).toContain('data.json');
    });

    it('stat on a mounted path works', async () => {
      const stat = await mountRestricted.stat('/mnt/kb');
      expect(stat.type).toBe('directory');
    });

    it('exists on a mounted path returns true', async () => {
      expect(await mountRestricted.exists('/mnt/kb')).toBe(true);
      expect(await mountRestricted.exists('/mnt/kb/README.md')).toBe(true);
    });

    it('mkdir on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.mkdir('/mnt/kb/subdir')).rejects.toThrow('EACCES');
    });

    it('rm on a mounted path throws EACCES', async () => {
      await expect(mountRestricted.rm('/mnt/kb/README.md')).rejects.toThrow('EACCES');
    });

    it('readDir on root includes mount parent paths', async () => {
      const entries = await mountRestricted.readDir('/');
      const names = entries.map((e) => e.name);
      expect(names).toContain('mnt');
      expect(names).toContain('scoops');
    });
  });

  // ── Symlink target validation ─────────────────────────────────────

  describe('symlink target validation', () => {
    let symlinkVfs: VirtualFS;
    let symlinkRestricted: RestrictedFS;

    beforeAll(async () => {
      symlinkVfs = await VirtualFS.create({ dbName: 'test-restricted-fs-symlinks', wipe: true });
      // Set up directory structure
      await symlinkVfs.mkdir('/scoops/my-scoop', { recursive: true });
      await symlinkVfs.mkdir('/shared', { recursive: true });
      await symlinkVfs.mkdir('/secret', { recursive: true });
      await symlinkVfs.writeFile('/scoops/my-scoop/legit.txt', 'allowed content');
      await symlinkVfs.writeFile('/shared/data.txt', 'shared data');
      await symlinkVfs.writeFile('/secret/data.txt', 'top secret');

      // Create symlinks:
      // escape-link -> /secret/data.txt (points outside allowed)
      await symlinkVfs.symlink('/secret/data.txt', '/scoops/my-scoop/escape-link');
      // good-link -> /shared/data.txt (points to another allowed path)
      await symlinkVfs.symlink('/shared/data.txt', '/scoops/my-scoop/good-link');
      // chain: /scoops/my-scoop/chain-link -> /scoops/my-scoop/escape-link -> /secret/data.txt
      await symlinkVfs.symlink('/scoops/my-scoop/escape-link', '/scoops/my-scoop/chain-link');

      symlinkRestricted = new RestrictedFS(symlinkVfs, ['/scoops/my-scoop/'], ['/shared/']);
    });

    it('readFile through symlink pointing outside throws ENOENT', async () => {
      await expect(
        symlinkRestricted.readFile('/scoops/my-scoop/escape-link', { encoding: 'utf-8' })
      ).rejects.toThrow('ENOENT');
    });

    it('readFile through symlink pointing to allowed path succeeds', async () => {
      const content = await symlinkRestricted.readFile('/scoops/my-scoop/good-link', {
        encoding: 'utf-8',
      });
      expect(content).toBe('shared data');
    });

    it('readTextFile through symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.readTextFile('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('stat through symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.stat('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('exists returns false for symlink pointing outside', async () => {
      expect(await symlinkRestricted.exists('/scoops/my-scoop/escape-link')).toBe(false);
    });

    it('symlink chain where final target is outside throws ENOENT', async () => {
      await expect(
        symlinkRestricted.readFile('/scoops/my-scoop/chain-link', { encoding: 'utf-8' })
      ).rejects.toThrow('ENOENT');
    });

    it('writeFile through symlink pointing outside throws EACCES', async () => {
      // Create a symlink to a directory outside allowed
      await symlinkVfs.mkdir('/outside-dir', { recursive: true });
      await symlinkVfs.symlink('/outside-dir', '/scoops/my-scoop/dir-escape');
      await expect(
        symlinkRestricted.writeFile('/scoops/my-scoop/dir-escape/file.txt', 'hacked')
      ).rejects.toThrow('EACCES');
    });

    it('readlink on symlink pointing outside throws ENOENT', async () => {
      await expect(symlinkRestricted.readlink('/scoops/my-scoop/escape-link')).rejects.toThrow(
        'ENOENT'
      );
    });

    it('readlink on symlink pointing to allowed path succeeds', async () => {
      const target = await symlinkRestricted.readlink('/scoops/my-scoop/good-link');
      expect(target).toBe('/shared/data.txt');
    });
  });

  it('rename checks both paths', async () => {
    await restricted.writeFile('/scoops/andy-scoop/rename-src.txt', 'src');
    // Rename within allowed - should work
    await restricted.rename(
      '/scoops/andy-scoop/rename-src.txt',
      '/scoops/andy-scoop/rename-dest.txt'
    );
    const content = await restricted.readFile('/scoops/andy-scoop/rename-dest.txt', {
      encoding: 'utf-8',
    });
    expect(content).toBe('src');

    // Rename to outside - should fail
    await restricted.writeFile('/scoops/andy-scoop/escape.txt', 'escape');
    await expect(
      restricted.rename('/scoops/andy-scoop/escape.txt', '/root-escape.txt')
    ).rejects.toThrow('EACCES');
  });
});
