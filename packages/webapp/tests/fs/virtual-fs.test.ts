import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

describe('VirtualFS', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    // Create fresh VFS with constant DB name — wipe: true ensures isolation
    // while reusing a single in-memory IndexedDB store (prevents OOM)
    vfs = await VirtualFS.create({
      dbName: 'test-vfs',
      wipe: true,
    });
  });

  afterEach(async () => {
    // Drop the ZenFS memory mount + InMemoryStore so each test sheds
    // its store between runs (good hygiene; not the root of the OOM
    // this file used to hit — see {@link VirtualFS.realpath}).
    await vfs.dispose();
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
      const result = (await vfs.readFile('/binary.dat', { encoding: 'binary' })) as Uint8Array;
      // LightningFS may return a view into a larger buffer, so compare actual bytes
      expect(result.length).toBe(data.length);
      expect(Array.from(result)).toEqual(Array.from(data));
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

  describe('concurrent writes (parallel-checkout race)', () => {
    // Regression for the OPFS/ZenFS parallel-checkout race: isomorphic-git
    // fires many writeFile/symlink calls CONCURRENTLY, each first doing
    // mkdir(parent, { recursive: true }). On the shared, non-atomic ZenFS
    // index those overlapping dir-creates + writes could interleave so a
    // write hit a not-yet-materialized parent → spurious ENOENT (aggregated
    // into MultipleGitError, non-deterministic across runs). The write lock
    // makes parent-ensure-then-write one critical section.
    it('writes many files across overlapping nested dirs concurrently', async () => {
      const paths: string[] = [];
      for (let d = 0; d < 20; d++) {
        for (let f = 0; f < 10; f++) {
          paths.push(`/repo/pkg${d}/src/nested/deep/file${f}.txt`);
        }
      }
      await Promise.all(paths.map((p) => vfs.writeFile(p, p)));
      const contents = await Promise.all(paths.map((p) => vfs.readTextFile(p)));
      expect(contents).toEqual(paths);
    });

    it('creates many symlinks across overlapping nested dirs concurrently', async () => {
      const links: { link: string; target: string }[] = [];
      for (let d = 0; d < 15; d++) {
        for (let f = 0; f < 8; f++) {
          links.push({
            link: `/repo/tiles/basic/skills/g${d}/link${f}`,
            target: `../../../../target/g${d}/dest${f}`,
          });
        }
      }
      await Promise.all(links.map(({ link, target }) => vfs.symlink(target, link)));
      const targets = await Promise.all(links.map(({ link }) => vfs.readlink(link)));
      expect(targets).toEqual(links.map((l) => l.target));
    });

    it('mixes concurrent files and symlinks sharing the same parent dirs', async () => {
      const ops: Promise<void>[] = [];
      const files: string[] = [];
      const symlinks: string[] = [];
      for (let i = 0; i < 60; i++) {
        const dir = `/mix/a/b/c${i % 5}`;
        const file = `${dir}/f${i}.txt`;
        const link = `${dir}/l${i}`;
        files.push(file);
        symlinks.push(link);
        ops.push(vfs.writeFile(file, `data-${i}`));
        ops.push(vfs.symlink(`./f${i}.txt`, link));
      }
      await Promise.all(ops);
      for (let i = 0; i < files.length; i++) {
        expect(await vfs.readTextFile(files[i])).toBe(`data-${i}`);
        expect(await vfs.readlink(symlinks[i])).toBe(`./f${i}.txt`);
      }
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

  describe('symlinks', () => {
    it('creates and reads symlinks to files', async () => {
      await vfs.writeFile('/target.txt', 'hello');
      await vfs.symlink('/target.txt', '/link.txt');
      const target = await vfs.readlink('/link.txt');
      expect(target).toBe('/target.txt');
    });

    it('creates and reads symlinks to directories', async () => {
      await vfs.mkdir('/mydir');
      await vfs.writeFile('/mydir/file.txt', 'inside');
      await vfs.symlink('/mydir', '/dirlink');
      const target = await vfs.readlink('/dirlink');
      expect(target).toBe('/mydir');
    });

    it('stat() follows symlinks', async () => {
      await vfs.writeFile('/real.txt', 'content');
      await vfs.symlink('/real.txt', '/sym.txt');
      const s = await vfs.stat('/sym.txt');
      expect(s.type).toBe('file');
      expect(s.size).toBe(7);
    });

    it('lstat() returns symlink metadata', async () => {
      await vfs.writeFile('/target.txt', 'data');
      await vfs.symlink('/target.txt', '/link.txt');
      const s = await vfs.lstat('/link.txt');
      expect(s.type).toBe('symlink');
      expect(s.isSymlink).toBe(true);
      expect(s.symlinkTarget).toBe('/target.txt');
    });

    it('readFile through symlinks', async () => {
      await vfs.writeFile('/original.txt', 'symlinked content');
      await vfs.symlink('/original.txt', '/alias.txt');
      const content = await vfs.readFile('/alias.txt');
      expect(content).toBe('symlinked content');
    });

    it('writeFile through symlinks', async () => {
      await vfs.writeFile('/target.txt', 'old');
      await vfs.symlink('/target.txt', '/link.txt');
      await vfs.writeFile('/link.txt', 'new');
      const content = await vfs.readFile('/target.txt');
      expect(content).toBe('new');
    });

    it('readDir includes symlinks with correct type', async () => {
      await vfs.mkdir('/dir');
      await vfs.writeFile('/dir/file.txt', 'f');
      await vfs.symlink('/dir/file.txt', '/dir/link.txt');
      const entries = await vfs.readDir('/dir');
      const fileEntry = entries.find((e) => e.name === 'file.txt');
      const linkEntry = entries.find((e) => e.name === 'link.txt');
      expect(fileEntry?.type).toBe('file');
      expect(linkEntry?.type).toBe('symlink');
    });

    it('rm removes symlink not target', async () => {
      await vfs.writeFile('/keep.txt', 'important');
      await vfs.symlink('/keep.txt', '/remove-me.txt');
      await vfs.rm('/remove-me.txt');
      expect(await vfs.exists('/remove-me.txt')).toBe(false);
      expect(await vfs.exists('/keep.txt')).toBe(true);
      expect(await vfs.readTextFile('/keep.txt')).toBe('important');
    });

    it('circular symlink detection (ELOOP)', async () => {
      await vfs.symlink('/b', '/a');
      await vfs.symlink('/a', '/b');
      try {
        await vfs.readFile('/a');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FsError);
        expect((err as FsError).code).toBe('ELOOP');
      }
    });

    it('realpath resolves symlinks', async () => {
      await vfs.mkdir('/real');
      await vfs.writeFile('/real/file.txt', 'data');
      await vfs.symlink('/real', '/alias');
      const resolved = await vfs.realpath('/alias/file.txt');
      expect(resolved).toBe('/real/file.txt');
    });

    it('relative symlinks work correctly', async () => {
      await vfs.mkdir('/proj');
      await vfs.writeFile('/proj/target.txt', 'relative');
      await vfs.symlink('target.txt', '/proj/link.txt');
      const content = await vfs.readFile('/proj/link.txt');
      expect(content).toBe('relative');
    });

    it('walk follows symlinks to directories', async () => {
      await vfs.mkdir('/src');
      await vfs.writeFile('/src/a.ts', 'a');
      await vfs.symlink('/src', '/linked-src');
      const files: string[] = [];
      for await (const p of vfs.walk('/linked-src')) {
        files.push(p);
      }
      expect(files).toContain('/linked-src/a.ts');
    });

    it('walk avoids infinite loops from circular directory symlinks', async () => {
      await vfs.mkdir('/loop');
      await vfs.writeFile('/loop/file.txt', 'content');
      await vfs.symlink('/loop', '/loop/self');
      const files: string[] = [];
      for await (const p of vfs.walk('/loop')) {
        files.push(p);
      }
      expect(files).toContain('/loop/file.txt');
      // Should terminate without infinite recursion
      expect(files.length).toBeGreaterThan(0);
    });
  });

  describe('fs watcher integration', () => {
    it('writeFile notifies watcher on create', async () => {
      const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      const callback = vi.fn();
      watcher.watch('/', () => true, callback);

      await vfs.writeFile('/watched.txt', 'hello');
      expect(callback).toHaveBeenCalled();
      const events = callback.mock.calls[0][0];
      expect(events[0].type).toBe('create');
      expect(events[0].path).toBe('/watched.txt');

      vfs.setWatcher(null as any);
    });

    it('writeFile notifies watcher on modify', async () => {
      const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
      await vfs.writeFile('/existing.txt', 'old');
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      const callback = vi.fn();
      watcher.watch('/', () => true, callback);

      await vfs.writeFile('/existing.txt', 'new');
      expect(callback).toHaveBeenCalled();
      const events = callback.mock.calls[0][0];
      expect(events[0].type).toBe('modify');

      vfs.setWatcher(null as any);
    });

    it('rm notifies watcher', async () => {
      const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
      await vfs.writeFile('/to-delete.txt', 'data');
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      const callback = vi.fn();
      watcher.watch('/', () => true, callback);

      await vfs.rm('/to-delete.txt');
      expect(callback).toHaveBeenCalled();
      const events = callback.mock.calls[0][0];
      expect(events[0].type).toBe('delete');

      vfs.setWatcher(null as any);
    });

    it('mkdir notifies watcher', async () => {
      const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      const callback = vi.fn();
      watcher.watch('/', () => true, callback);

      await vfs.mkdir('/watched-dir');
      expect(callback).toHaveBeenCalled();
      const events = callback.mock.calls[0][0];
      expect(events[0].type).toBe('create');
      expect(events[0].entryType).toBe('directory');

      vfs.setWatcher(null as any);
    });
  });

  describe('canWrite', () => {
    it('returns true for any path (unrestricted filesystem)', () => {
      expect(vfs.canWrite('/')).toBe(true);
      expect(vfs.canWrite('/anywhere')).toBe(true);
      expect(vfs.canWrite('/scoops/other-scoop/secret.txt')).toBe(true);
    });
  });

  describe('invalidatePaths', () => {
    it('is a no-op on the memory backend', () => {
      // Should not throw — early-returns because backend !== 'opfs'
      expect(() => vfs.invalidatePaths(['/foo.txt', '/bar/baz.txt'])).not.toThrow();
    });

    it('deletes entries from index and _handles when opfs backend is present', () => {
      const fakeIndex = new Map<string, unknown>([
        ['/tmp/test.txt', { size: 100 }],
        ['/workspace/keep.txt', { size: 50 }],
      ]);
      const fakeHandles = new Map<string, unknown>([
        ['/tmp/test.txt', {}],
        ['/workspace/keep.txt', {}],
      ]);
      // Inject a fake OPFS backend to bypass the early return
      const internal = vfs as unknown as {
        backend: string;
        opfsBackendFs: unknown;
      };
      internal.backend = 'opfs';
      internal.opfsBackendFs = {
        index: { delete: (p: string) => fakeIndex.delete(p) },
        _handles: fakeHandles,
      };

      vfs.invalidatePaths(['/tmp/test.txt']);

      expect(fakeIndex.has('/tmp/test.txt')).toBe(false);
      expect(fakeHandles.has('/tmp/test.txt')).toBe(false);
      // Unrelated paths are untouched
      expect(fakeIndex.has('/workspace/keep.txt')).toBe(true);
      expect(fakeHandles.has('/workspace/keep.txt')).toBe(true);
    });
  });
});

describe('writeFile truncation (shrinking rewrites)', () => {
  it('a shorter rewrite must not leave the previous tail behind', async () => {
    // ZenFS' OPFS backend writes at offset 0 without truncating; the
    // VirtualFS layer pins the exact byte length after every write so a
    // shrinking rewrite can't corrupt the file (live repro: a rebuilt
    // /sessions/index.json read back as valid JSON + stale tail garbage).
    const fs = await VirtualFS.create({ dbName: `trunc-${Date.now()}`, wipe: true });
    await fs.writeFile('/tmp/trunc.txt', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await fs.writeFile('/tmp/trunc.txt', 'short');
    expect(await fs.readFile('/tmp/trunc.txt', { encoding: 'utf-8' })).toBe('short');

    // Binary writes shrink correctly too.
    await fs.writeFile('/tmp/trunc.bin', new Uint8Array(64).fill(7));
    await fs.writeFile('/tmp/trunc.bin', new Uint8Array([1, 2, 3]));
    const back = (await fs.readFile('/tmp/trunc.bin', { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(back)).toEqual([1, 2, 3]);
  });
});
