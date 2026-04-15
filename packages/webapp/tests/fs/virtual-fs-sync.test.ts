/**
 * Tests for VirtualFS synchronous fast-path methods (readDirSync, statSync, lstatSync).
 *
 * These methods bypass async LightningFS wrappers by reading directly from the
 * in-memory CacheFS tree. They return null when the path is under a mount or
 * the CacheFS internal isn't available, signaling the caller to fall back to
 * the async path.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

describe('VirtualFS sync fast-path', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-vfs-sync', wipe: true });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

  describe('readDirSync', () => {
    it('returns entries for a directory with files', async () => {
      await vfs.writeFile('/project/a.ts', 'a');
      await vfs.writeFile('/project/b.ts', 'b');
      const entries = vfs.readDirSync('/project');
      expect(entries).not.toBeNull();
      const names = entries!.map((e) => e.name).sort();
      expect(names).toEqual(['a.ts', 'b.ts']);
      entries!.forEach((e) => expect(e.type).toBe('file'));
    });

    it('returns directory entries with correct type', async () => {
      await vfs.mkdir('/parent/child', { recursive: true });
      await vfs.writeFile('/parent/file.txt', 'f');
      const entries = vfs.readDirSync('/parent');
      expect(entries).not.toBeNull();
      const childDir = entries!.find((e) => e.name === 'child');
      const file = entries!.find((e) => e.name === 'file.txt');
      expect(childDir?.type).toBe('directory');
      expect(file?.type).toBe('file');
    });

    it('returns symlink entries with type "symlink"', async () => {
      await vfs.writeFile('/dir/target.txt', 'data');
      await vfs.symlink('/dir/target.txt', '/dir/link.txt');
      const entries = vfs.readDirSync('/dir');
      expect(entries).not.toBeNull();
      const link = entries!.find((e) => e.name === 'link.txt');
      expect(link?.type).toBe('symlink');
    });

    it('follows symlinks in the directory path', async () => {
      await vfs.writeFile('/real-dir/file.txt', 'content');
      await vfs.symlink('/real-dir', '/linked-dir');
      const entries = vfs.readDirSync('/linked-dir');
      expect(entries).not.toBeNull();
      expect(entries!.map((e) => e.name)).toContain('file.txt');
    });

    it('returns null for nonexistent directory', () => {
      const entries = vfs.readDirSync('/nonexistent');
      expect(entries).toBeNull();
    });

    it('returns empty array for empty directory', async () => {
      await vfs.mkdir('/empty');
      const entries = vfs.readDirSync('/empty');
      expect(entries).not.toBeNull();
      expect(entries).toEqual([]);
    });

    it('matches async readDir results', async () => {
      await vfs.writeFile('/cmp/a.ts', 'a');
      await vfs.writeFile('/cmp/b.ts', 'b');
      await vfs.mkdir('/cmp/sub');
      await vfs.symlink('/cmp/a.ts', '/cmp/link.ts');

      const syncEntries = vfs.readDirSync('/cmp');
      const asyncEntries = await vfs.readDir('/cmp');

      expect(syncEntries).not.toBeNull();
      const syncSorted = syncEntries!.slice().sort((a, b) => a.name.localeCompare(b.name));
      const asyncSorted = asyncEntries.slice().sort((a, b) => a.name.localeCompare(b.name));
      expect(syncSorted).toEqual(asyncSorted);
    });
  });

  describe('statSync', () => {
    it('returns stats for a file', async () => {
      await vfs.writeFile('/file.txt', 'hello');
      const s = vfs.statSync('/file.txt');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('file');
      expect(s!.size).toBe(5);
    });

    it('returns stats for a directory', async () => {
      await vfs.mkdir('/mydir');
      const s = vfs.statSync('/mydir');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('directory');
    });

    it('follows symlinks to file', async () => {
      await vfs.writeFile('/target.txt', 'data');
      await vfs.symlink('/target.txt', '/link.txt');
      const s = vfs.statSync('/link.txt');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('file');
      expect(s!.size).toBe(4);
    });

    it('follows symlinks to directory', async () => {
      await vfs.mkdir('/real-dir');
      await vfs.symlink('/real-dir', '/dir-link');
      const s = vfs.statSync('/dir-link');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('directory');
    });

    it('returns null for nonexistent path', () => {
      const s = vfs.statSync('/nope');
      expect(s).toBeNull();
    });

    it('returns null for dangling symlink', async () => {
      await vfs.symlink('/nonexistent', '/dangling');
      const s = vfs.statSync('/dangling');
      expect(s).toBeNull();
    });

    it('matches async stat results for files', async () => {
      await vfs.writeFile('/check.txt', 'verify');
      const sync = vfs.statSync('/check.txt');
      const async_ = await vfs.stat('/check.txt');
      expect(sync).not.toBeNull();
      expect(sync!.type).toBe(async_.type);
      expect(sync!.size).toBe(async_.size);
    });
  });

  describe('lstatSync', () => {
    it('returns file stats without following symlinks', async () => {
      await vfs.writeFile('/file.txt', 'data');
      const s = vfs.lstatSync('/file.txt');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('file');
    });

    it('returns symlink type for symlinks (does not follow)', async () => {
      await vfs.writeFile('/target.txt', 'data');
      await vfs.symlink('/target.txt', '/link.txt');
      const s = vfs.lstatSync('/link.txt');
      expect(s).not.toBeNull();
      expect(s!.type).toBe('symlink');
      expect(s!.isSymlink).toBe(true);
      expect(s!.symlinkTarget).toBe('/target.txt');
    });

    it('returns null for nonexistent path', () => {
      expect(vfs.lstatSync('/nope')).toBeNull();
    });

    it('matches async lstat results', async () => {
      await vfs.writeFile('/target.txt', 'data');
      await vfs.symlink('/target.txt', '/link.txt');
      const sync = vfs.lstatSync('/link.txt');
      const async_ = await vfs.lstat('/link.txt');
      expect(sync).not.toBeNull();
      expect(sync!.type).toBe(async_.type);
      expect(sync!.isSymlink).toBe(async_.isSymlink);
      expect(sync!.symlinkTarget).toBe(async_.symlinkTarget);
    });
  });
});
