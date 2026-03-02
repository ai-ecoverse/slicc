import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbBackend } from './indexeddb-backend.js';
import { FsError } from './types.js';

describe('IndexedDbBackend', () => {
  let fs: IndexedDbBackend;

  // Use a unique DB name per test to avoid state leaking
  let dbCounter = 0;
  beforeEach(() => {
    fs = new IndexedDbBackend(`test-fs-${dbCounter++}`);
  });

  describe('writeFile + readFile', () => {
    it('writes and reads a text file', async () => {
      await fs.writeFile('/hello.txt', 'Hello, world!');
      const content = await fs.readFile('/hello.txt');
      expect(content).toBe('Hello, world!');
    });

    it('writes and reads binary content', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await fs.writeFile('/data.bin', data);
      const result = await fs.readFile('/data.bin', 'binary');
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(data);
    });

    it('overwrites existing file', async () => {
      await fs.writeFile('/file.txt', 'first');
      await fs.writeFile('/file.txt', 'second');
      const content = await fs.readFile('/file.txt');
      expect(content).toBe('second');
    });

    it('creates parent directories automatically', async () => {
      await fs.writeFile('/a/b/c/file.txt', 'nested');
      const content = await fs.readFile('/a/b/c/file.txt');
      expect(content).toBe('nested');
    });

    it('throws ENOENT for non-existent file', async () => {
      await expect(fs.readFile('/missing.txt')).rejects.toThrow(FsError);
      await expect(fs.readFile('/missing.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('throws EISDIR when reading a directory', async () => {
      await fs.mkdir('/dir');
      await expect(fs.readFile('/dir')).rejects.toMatchObject({
        code: 'EISDIR',
      });
    });
  });

  describe('mkdir', () => {
    it('creates a directory', async () => {
      await fs.mkdir('/mydir');
      const stat = await fs.stat('/mydir');
      expect(stat.type).toBe('directory');
    });

    it('creates nested directories with recursive', async () => {
      await fs.mkdir('/a/b/c', { recursive: true });
      expect(await fs.exists('/a')).toBe(true);
      expect(await fs.exists('/a/b')).toBe(true);
      expect(await fs.exists('/a/b/c')).toBe(true);
    });

    it('throws EEXIST for existing directory without recursive', async () => {
      await fs.mkdir('/dir');
      await expect(fs.mkdir('/dir')).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });

    it('does not throw for existing directory with recursive', async () => {
      await fs.mkdir('/dir');
      await expect(fs.mkdir('/dir', { recursive: true })).resolves.toBeUndefined();
    });

    it('throws ENOENT when parent does not exist without recursive', async () => {
      await expect(fs.mkdir('/a/b')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('readDir', () => {
    it('lists files and directories', async () => {
      await fs.writeFile('/dir/file1.txt', 'a');
      await fs.writeFile('/dir/file2.txt', 'b');
      await fs.mkdir('/dir/sub', { recursive: true });

      const entries = await fs.readDir('/dir');
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['file1.txt', 'file2.txt', 'sub']);

      const fileEntry = entries.find((e) => e.name === 'file1.txt');
      expect(fileEntry?.type).toBe('file');

      const dirEntry = entries.find((e) => e.name === 'sub');
      expect(dirEntry?.type).toBe('directory');
    });

    it('returns empty array for empty directory', async () => {
      await fs.mkdir('/empty');
      const entries = await fs.readDir('/empty');
      expect(entries).toEqual([]);
    });

    it('lists root directory', async () => {
      await fs.writeFile('/root-file.txt', 'hello');
      const entries = await fs.readDir('/');
      expect(entries.some((e) => e.name === 'root-file.txt')).toBe(true);
    });

    it('throws ENOENT for non-existent directory', async () => {
      await expect(fs.readDir('/missing')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('throws ENOTDIR for file path', async () => {
      await fs.writeFile('/file.txt', 'hello');
      await expect(fs.readDir('/file.txt')).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });
  });

  describe('rm', () => {
    it('removes a file', async () => {
      await fs.writeFile('/file.txt', 'hello');
      await fs.rm('/file.txt');
      expect(await fs.exists('/file.txt')).toBe(false);
    });

    it('removes empty directory', async () => {
      await fs.mkdir('/dir');
      await fs.rm('/dir');
      expect(await fs.exists('/dir')).toBe(false);
    });

    it('removes directory recursively', async () => {
      await fs.writeFile('/dir/a/b.txt', 'hello');
      await fs.rm('/dir', { recursive: true });
      expect(await fs.exists('/dir')).toBe(false);
      expect(await fs.exists('/dir/a')).toBe(false);
      expect(await fs.exists('/dir/a/b.txt')).toBe(false);
    });

    it('throws ENOTEMPTY for non-empty directory without recursive', async () => {
      await fs.writeFile('/dir/file.txt', 'hello');
      await expect(fs.rm('/dir')).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      });
    });

    it('throws ENOENT for non-existent path', async () => {
      await expect(fs.rm('/missing')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('throws EINVAL for root', async () => {
      await expect(fs.rm('/')).rejects.toMatchObject({
        code: 'EINVAL',
      });
    });
  });

  describe('stat', () => {
    it('returns file stats', async () => {
      await fs.writeFile('/file.txt', 'hello');
      const stat = await fs.stat('/file.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(5); // 'hello' = 5 bytes
      expect(stat.mtime).toBeGreaterThan(0);
      expect(stat.ctime).toBeGreaterThan(0);
    });

    it('returns directory stats', async () => {
      await fs.mkdir('/dir');
      const stat = await fs.stat('/dir');
      expect(stat.type).toBe('directory');
    });

    it('returns root stats', async () => {
      const stat = await fs.stat('/');
      expect(stat.type).toBe('directory');
    });

    it('throws ENOENT for non-existent path', async () => {
      await expect(fs.stat('/missing')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await fs.writeFile('/file.txt', 'hello');
      expect(await fs.exists('/file.txt')).toBe(true);
    });

    it('returns true for existing directory', async () => {
      await fs.mkdir('/dir');
      expect(await fs.exists('/dir')).toBe(true);
    });

    it('returns true for root', async () => {
      expect(await fs.exists('/')).toBe(true);
    });

    it('returns false for non-existent path', async () => {
      expect(await fs.exists('/missing')).toBe(false);
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      await fs.writeFile('/old.txt', 'content');
      await fs.rename('/old.txt', '/new.txt');

      expect(await fs.exists('/old.txt')).toBe(false);
      expect(await fs.readFile('/new.txt')).toBe('content');
    });

    it('moves a file to a different directory', async () => {
      await fs.writeFile('/src/file.txt', 'content');
      await fs.mkdir('/dest', { recursive: true });
      await fs.rename('/src/file.txt', '/dest/file.txt');

      expect(await fs.exists('/src/file.txt')).toBe(false);
      expect(await fs.readFile('/dest/file.txt')).toBe('content');
    });

    it('renames a directory', async () => {
      await fs.writeFile('/old/file.txt', 'content');
      await fs.rename('/old', '/new');

      expect(await fs.exists('/old')).toBe(false);
      expect(await fs.readFile('/new/file.txt')).toBe('content');
    });

    it('throws ENOENT for non-existent source', async () => {
      await expect(fs.rename('/missing', '/new')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  describe('nested directory structures', () => {
    it('handles deeply nested paths', async () => {
      const deepPath = '/a/b/c/d/e/f/g/file.txt';
      await fs.writeFile(deepPath, 'deep');
      expect(await fs.readFile(deepPath)).toBe('deep');

      // All intermediate dirs should exist
      expect(await fs.exists('/a')).toBe(true);
      expect(await fs.exists('/a/b')).toBe(true);
      expect(await fs.exists('/a/b/c')).toBe(true);
      expect(await fs.exists('/a/b/c/d/e/f/g')).toBe(true);
    });

    it('lists only direct children', async () => {
      await fs.writeFile('/parent/child1/file1.txt', 'a');
      await fs.writeFile('/parent/child2/file2.txt', 'b');
      await fs.writeFile('/parent/file3.txt', 'c');

      const entries = await fs.readDir('/parent');
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['child1', 'child2', 'file3.txt']);
    });
  });
});
