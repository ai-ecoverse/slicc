import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from './virtual-fs.js';
import { FsError } from './types.js';

describe('VirtualFS', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    // Force IndexedDB backend for Node.js testing
    vfs = await VirtualFS.create({
      backend: 'indexeddb',
      dbName: `test-vfs-${dbCounter++}`,
    });
  });

  it('reports indexeddb backend type', () => {
    expect(vfs.getBackendType()).toBe('indexeddb');
  });

  describe('file operations', () => {
    it('writes and reads text files', async () => {
      await vfs.writeFile('/test.txt', 'Hello VirtualFS!');
      const content = await vfs.readFile('/test.txt');
      expect(content).toBe('Hello VirtualFS!');
    });

    it('writes and reads binary files', async () => {
      const data = new Uint8Array([10, 20, 30]);
      await vfs.writeFile('/binary.dat', data);
      const result = await vfs.readFile('/binary.dat', { encoding: 'binary' });
      expect(result).toEqual(data);
    });

    it('readTextFile is a convenience for utf-8 read', async () => {
      await vfs.writeFile('/text.txt', 'convenience');
      const text = await vfs.readTextFile('/text.txt');
      expect(text).toBe('convenience');
    });

    it('overwrites files', async () => {
      await vfs.writeFile('/file.txt', 'v1');
      await vfs.writeFile('/file.txt', 'v2');
      expect(await vfs.readTextFile('/file.txt')).toBe('v2');
    });
  });

  describe('directory operations', () => {
    it('creates and lists directories', async () => {
      await vfs.mkdir('/projects', { recursive: true });
      await vfs.writeFile('/projects/readme.md', '# Hello');
      await vfs.writeFile('/projects/index.ts', 'export {}');

      const entries = await vfs.readDir('/projects');
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['index.ts', 'readme.md']);
    });

    it('creates nested directories recursively', async () => {
      await vfs.mkdir('/a/b/c/d', { recursive: true });
      expect(await vfs.exists('/a/b/c/d')).toBe(true);
    });
  });

  describe('stat and exists', () => {
    it('stats a file', async () => {
      await vfs.writeFile('/file.txt', 'data');
      const stat = await vfs.stat('/file.txt');
      expect(stat.type).toBe('file');
      expect(stat.size).toBe(4);
    });

    it('stats a directory', async () => {
      await vfs.mkdir('/dir');
      const stat = await vfs.stat('/dir');
      expect(stat.type).toBe('directory');
    });

    it('exists returns false for missing paths', async () => {
      expect(await vfs.exists('/nope')).toBe(false);
    });
  });

  describe('rm', () => {
    it('removes files', async () => {
      await vfs.writeFile('/tmp.txt', 'temp');
      await vfs.rm('/tmp.txt');
      expect(await vfs.exists('/tmp.txt')).toBe(false);
    });

    it('removes directory trees', async () => {
      await vfs.writeFile('/tree/a/b.txt', 'leaf');
      await vfs.rm('/tree', { recursive: true });
      expect(await vfs.exists('/tree')).toBe(false);
    });
  });

  describe('rename', () => {
    it('renames files', async () => {
      await vfs.writeFile('/old.txt', 'content');
      await vfs.rename('/old.txt', '/new.txt');
      expect(await vfs.exists('/old.txt')).toBe(false);
      expect(await vfs.readTextFile('/new.txt')).toBe('content');
    });

    it('renames directories', async () => {
      await vfs.writeFile('/src/main.ts', 'code');
      await vfs.rename('/src', '/source');
      expect(await vfs.exists('/src')).toBe(false);
      expect(await vfs.readTextFile('/source/main.ts')).toBe('code');
    });
  });

  describe('copyFile', () => {
    it('copies a file', async () => {
      await vfs.writeFile('/orig.txt', 'original');
      await vfs.copyFile('/orig.txt', '/copy.txt');
      expect(await vfs.readTextFile('/copy.txt')).toBe('original');
      // Original still exists
      expect(await vfs.readTextFile('/orig.txt')).toBe('original');
    });

    it('throws EISDIR for directory source', async () => {
      await vfs.mkdir('/dir');
      await expect(vfs.copyFile('/dir', '/copy')).rejects.toMatchObject({
        code: 'EISDIR',
      });
    });
  });

  describe('walk', () => {
    it('recursively lists all files', async () => {
      await vfs.writeFile('/project/src/a.ts', 'a');
      await vfs.writeFile('/project/src/b.ts', 'b');
      await vfs.writeFile('/project/readme.md', 'readme');

      const files: string[] = [];
      for await (const path of vfs.walk('/project')) {
        files.push(path);
      }
      files.sort();
      expect(files).toEqual(['/project/readme.md', '/project/src/a.ts', '/project/src/b.ts']);
    });

    it('returns empty for empty directory', async () => {
      await vfs.mkdir('/empty');
      const files: string[] = [];
      for await (const path of vfs.walk('/empty')) {
        files.push(path);
      }
      expect(files).toEqual([]);
    });
  });

  describe('path utilities', () => {
    it('dirname returns parent directory', () => {
      expect(vfs.dirname('/a/b/c.txt')).toBe('/a/b');
      expect(vfs.dirname('/file.txt')).toBe('/');
    });

    it('basename returns file name', () => {
      expect(vfs.basename('/a/b/c.txt')).toBe('c.txt');
      expect(vfs.basename('/file.txt')).toBe('file.txt');
    });
  });

  describe('error handling', () => {
    it('throws FsError with correct code for missing file', async () => {
      try {
        await vfs.readFile('/missing.txt');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FsError);
        expect((err as FsError).code).toBe('ENOENT');
      }
    });
  });
});
