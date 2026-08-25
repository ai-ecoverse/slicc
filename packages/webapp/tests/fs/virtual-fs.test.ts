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

    it('mkdir -p over a FILE component fails ENOTDIR naming the component (#2146)', async () => {
      await vfs.writeFile('/plainfile', 'i am a file');
      // Pre-fix the kind-blind EEXIST swallow resolved this silently,
      // leaving a poisoned prefix that failed deep inside ZenFS later.
      await expect(vfs.mkdir('/plainfile', { recursive: true })).rejects.toMatchObject({
        code: 'ENOTDIR',
        path: '/plainfile',
      });
      await expect(vfs.mkdir('/plainfile/sub/dir', { recursive: true })).rejects.toMatchObject({
        code: 'ENOTDIR',
        path: '/plainfile',
      });
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

    it('flushes metadata once after removing a large directory tree', async () => {
      const paths = Array.from(
        { length: 100 },
        (_, i) => `/large-tree/pkg${i % 10}/nested/file${i}.txt`
      );
      await Promise.all(paths.map((path) => vfs.writeFile(path, path)));
      // rm persists eagerly INSIDE its write-lock critical section, so it
      // calls the unlocked variant (the locked wrapper would deadlock).
      const flushSpy = vi.spyOn(
        vfs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );

      await vfs.rm('/large-tree', { recursive: true });

      expect(await vfs.exists('/large-tree')).toBe(false);
      expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('serializes recursive removal with concurrent mkdir and writes', async () => {
      const oldPaths = Array.from(
        { length: 100 },
        (_, i) => `/rm-race/old/pkg${i % 10}/file${i}.txt`
      );
      await Promise.all(oldPaths.map((path) => vfs.writeFile(path, path)));

      const concurrentCreates = Array.from({ length: 50 }, (_, i) => [
        vfs.mkdir(`/rm-race/new/pkg${i}`, { recursive: true }),
        vfs.writeFile(`/rm-race/new/pkg${i}/file.txt`, `data-${i}`),
      ]).flat();

      await expect(
        Promise.all([vfs.rm('/rm-race', { recursive: true }), ...concurrentCreates])
      ).resolves.toBeDefined();
    });

    it('recursive rm unlinks a directory symlink without removing its target', async () => {
      await vfs.writeFile('/keep-dir/important.txt', 'important');
      await vfs.mkdir('/remove-tree');
      await vfs.symlink('/keep-dir', '/remove-tree/link-to-keep');

      await vfs.rm('/remove-tree', { recursive: true });

      expect(await vfs.exists('/remove-tree')).toBe(false);
      expect(await vfs.readTextFile('/keep-dir/important.txt')).toBe('important');
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

    it('persists sidecar metadata eagerly inside the rename critical section', async () => {
      await vfs.writeFile('/ren-src/file.txt', 'x');
      // rename persists INSIDE its write-lock critical section (same shape
      // as rm/symlink), so it calls the unlocked variant — marking dirty
      // after an unlocked rename would let a concurrent flush resurrect
      // the on-disk /old subtree (PR #1993 review).
      const flushSpy = vi.spyOn(
        vfs as unknown as { writeOpfsMetadataSidecarUnlocked(): Promise<void> },
        'writeOpfsMetadataSidecarUnlocked'
      );

      await vfs.rename('/ren-src', '/ren-dest');

      expect(await vfs.readTextFile('/ren-dest/file.txt')).toBe('x');
      expect(flushSpy).toHaveBeenCalledTimes(1);
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

    it('rm removes a symlink to a non-empty directory without touching the target', async () => {
      await vfs.mkdir('/keep-dir');
      await vfs.writeFile('/keep-dir/important.txt', 'important');
      await vfs.symlink('/keep-dir', '/remove-dir-link');
      await vfs.rm('/remove-dir-link');
      expect(await vfs.exists('/remove-dir-link')).toBe(false);
      expect(await vfs.readTextFile('/keep-dir/important.txt')).toBe('important');
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

    // #2409: the `LocalVfsClient.watch` contract, so an in-process reader
    // (no kernel RPC in between) gets the same event-driven refresh the
    // panel does.
    it('watch() subscribes to every base path and unsubscribes them all', async () => {
      const { FsWatcher } = await import('../../src/fs/fs-watcher.js');
      const watcher = new FsWatcher();
      vfs.setWatcher(watcher);
      const callback = vi.fn();

      const off = await vfs.watch(['/a', '/b'], callback);
      expect(watcher.size).toBe(2);
      await vfs.mkdir('/a', { recursive: true });
      await vfs.writeFile('/a/file.txt', 'x');
      expect(callback).toHaveBeenCalled();

      callback.mockClear();
      off();
      expect(watcher.size).toBe(0);
      await vfs.writeFile('/a/after.txt', 'y');
      expect(callback).not.toHaveBeenCalled();

      vfs.setWatcher(null as any);
    });

    it('watch() rejects with ENOSYS when no watcher is attached', async () => {
      vfs.setWatcher(null as any);
      // A silently dead subscription would leave the caller waiting on
      // events that cannot arrive; the throw is what tells it to poll.
      await expect(vfs.watch(['/'], vi.fn())).rejects.toMatchObject({ code: 'ENOSYS' });
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

describe('in-session kind-mismatch reconcile (#2006)', () => {
  const S_IFDIR = 0o40000;
  const S_IFREG = 0o100000;

  /** A fake OPFS directory handle tree the probe can walk. */
  function fakeDirHandle(children: Record<string, unknown>): unknown {
    return {
      kind: 'directory',
      getDirectoryHandle: async (name: string) => {
        const child = children[name] as { kind?: string } | undefined;
        if (child?.kind !== 'directory') throw new Error('TypeMismatch');
        return child;
      },
      getFileHandle: async (name: string) => {
        const child = children[name] as { kind?: string } | undefined;
        if (child?.kind !== 'file') throw new Error('TypeMismatch');
        return child;
      },
    };
  }
  const fakeFileHandle = (size = 5): unknown => ({ kind: 'file', getFile: async () => ({ size }) });

  /** Detach the injected fakes so dispose()'s sidecar flush stays a no-op. */
  function detachFakes(vfs: VirtualFS): void {
    const internal = vfs as unknown as { backend: string; opfsBackendFs: unknown };
    internal.backend = 'memory';
    internal.opfsBackendFs = null;
  }

  type Wrapped = {
    withKindMismatchRetry<T>(path: string, op: () => Promise<T>): Promise<T>;
  };

  async function corruptedVfs() {
    const vfs = await VirtualFS.create({ dbName: `test-2006-${Date.now()}`, wipe: true });
    // OPFS reality: a genuine file — what the probe sees. Memory: a directory.
    const opfsRoot = fakeDirHandle({
      workspace: fakeDirHandle({ 'CLAUDE.md': fakeFileHandle(16249) }),
    });
    const fakeIndex = new Map<string, { mode?: number }>([
      ['/workspace/CLAUDE.md', { mode: S_IFDIR | 0o755 }],
      ['/workspace/CLAUDE.md/phantom-child.txt', { mode: S_IFREG | 0o644 }],
      ['/workspace/keep.txt', { mode: S_IFREG | 0o644 }],
    ]);
    const fakeHandles = new Map<string, { kind?: string }>([
      ['/workspace/CLAUDE.md', { kind: 'directory' }],
      ['/workspace/keep.txt', { kind: 'file' }],
    ]);
    const internal = vfs as unknown as {
      backend: string;
      opfsBackendFs: unknown;
      opfsHandle: unknown;
    };
    internal.backend = 'opfs';
    internal.opfsBackendFs = { index: fakeIndex, _handles: fakeHandles };
    internal.opfsHandle = opfsRoot;
    return { vfs, fakeIndex, fakeHandles };
  }

  // The acceptance case: an in-memory kind that disagrees with the backing
  // store reconciles in-session — the retried read succeeds, no reload.
  it('a poisoned EISDIR read heals the index and the single retry succeeds', async () => {
    const { vfs, fakeIndex, fakeHandles } = await corruptedVfs();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      // First attempt: ZenFS serves the poisoned index -> EISDIR. After the
      // eviction the retry re-reads OPFS truth and succeeds.
      if (fakeIndex.has('/workspace/CLAUDE.md')) {
        throw new FsError('EISDIR', 'is a directory', '/workspace/CLAUDE.md');
      }
      return 'real content';
    };

    const result = await (vfs as unknown as Wrapped).withKindMismatchRetry(
      '/workspace/CLAUDE.md',
      op
    );
    expect(result).toBe('real content');
    expect(calls).toBe(2); // one failure, one retry — never a loop
    expect(fakeIndex.has('/workspace/CLAUDE.md')).toBe(false);
    expect(fakeHandles.has('/workspace/CLAUDE.md')).toBe(false);
    // Phantom children of the phantom directory are evicted with it.
    expect(fakeIndex.has('/workspace/CLAUDE.md/phantom-child.txt')).toBe(false);
    // Innocent bystanders are untouched.
    expect(fakeIndex.has('/workspace/keep.txt')).toBe(true);
    expect(fakeHandles.has('/workspace/keep.txt')).toBe(true);
    detachFakes(vfs);
    await vfs.dispose();
  });

  it('a genuine EISDIR (reality agrees) reconciles nothing and does not retry', async () => {
    const vfs = await VirtualFS.create({ dbName: `test-2006b-${Date.now()}`, wipe: true });
    const fakeIndex = new Map<string, { mode?: number }>([
      ['/workspace/real-dir', { mode: S_IFDIR | 0o755 }],
    ]);
    const internal = vfs as unknown as {
      backend: string;
      opfsBackendFs: unknown;
      opfsHandle: unknown;
    };
    internal.backend = 'opfs';
    internal.opfsBackendFs = { index: fakeIndex, _handles: new Map() };
    internal.opfsHandle = fakeDirHandle({
      workspace: fakeDirHandle({ 'real-dir': fakeDirHandle({}) }),
    });

    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      throw new FsError('EISDIR', 'is a directory', '/workspace/real-dir');
    };
    await expect(
      (vfs as unknown as Wrapped).withKindMismatchRetry('/workspace/real-dir', op)
    ).rejects.toMatchObject({ code: 'EISDIR' });
    expect(calls).toBe(1); // no retry: memory agreed with reality
    expect(fakeIndex.has('/workspace/real-dir')).toBe(true);
    detachFakes(vfs);
    await vfs.dispose();
  });

  it('non-kind errors pass through untouched, without probing', async () => {
    const { vfs, fakeIndex } = await corruptedVfs();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      throw new FsError('ENOENT', 'no such file', '/workspace/CLAUDE.md');
    };
    await expect(
      (vfs as unknown as Wrapped).withKindMismatchRetry('/workspace/CLAUDE.md', op)
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toBe(1);
    expect(fakeIndex.has('/workspace/CLAUDE.md')).toBe(true); // untouched
    detachFakes(vfs);
    await vfs.dispose();
  });

  it('the memory backend never reconciles (no OPFS to probe)', async () => {
    const vfs = await VirtualFS.create({ dbName: `test-2006c-${Date.now()}`, wipe: true });
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      throw new FsError('EISDIR', 'is a directory', '/d');
    };
    await expect((vfs as unknown as Wrapped).withKindMismatchRetry('/d', op)).rejects.toMatchObject(
      { code: 'EISDIR' }
    );
    expect(calls).toBe(1);
    await vfs.dispose();
  });

  // #2146: rm and rename must ROUTE through the heal — pin the delegation
  // (the memory backend never triggers kind errors, so an op-level fake
  // cannot exercise it; the spy proves the wiring).
  it('rm and rename route through the kind-mismatch retry (#2146)', async () => {
    const vfs = await VirtualFS.create({ dbName: `test-2146-wire-${Date.now()}`, wipe: true });
    const spy = vi.spyOn(
      vfs as unknown as {
        withKindMismatchRetryPaths<T>(paths: readonly string[], op: () => Promise<T>): Promise<T>;
      },
      'withKindMismatchRetryPaths'
    );
    await vfs.writeFile('/wire/a.txt', 'x');
    spy.mockClear();
    await vfs.rm('/wire/a.txt');
    expect(spy).toHaveBeenCalledWith(['/wire/a.txt'], expect.any(Function));

    await vfs.writeFile('/wire/b.txt', 'y');
    spy.mockClear();
    await vfs.rename('/wire/b.txt', '/wire/c.txt');
    expect(spy).toHaveBeenCalledWith(['/wire/b.txt', '/wire/c.txt'], expect.any(Function));
    await vfs.dispose();
  });

  // #2146: the delete family fails ENOTDIR on a poisoned entry (rm dispatches
  // on the lying lstat type), and reads/writes surface EINVAL — both must
  // route through the same heal-and-retry.
  it('a poisoned ENOTDIR delete heals the index and the retry succeeds (#2146)', async () => {
    const { vfs, fakeIndex } = await corruptedVfs();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      if (fakeIndex.has('/workspace/CLAUDE.md')) {
        throw new FsError('ENOTDIR', 'not a directory', '/workspace/CLAUDE.md');
      }
      return 'deleted';
    };
    const result = await (vfs as unknown as Wrapped).withKindMismatchRetry(
      '/workspace/CLAUDE.md',
      op
    );
    expect(result).toBe('deleted');
    expect(calls).toBe(2);
    expect(fakeIndex.has('/workspace/CLAUDE.md')).toBe(false);
    detachFakes(vfs);
    await vfs.dispose();
  });

  it('a poisoned EINVAL read heals and retries; a genuine EINVAL does not (#2146)', async () => {
    const { vfs, fakeIndex } = await corruptedVfs();
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      if (fakeIndex.has('/workspace/CLAUDE.md')) {
        throw new FsError('EINVAL', 'invalid operation', '/workspace/CLAUDE.md');
      }
      return 'read after heal';
    };
    const result = await (vfs as unknown as Wrapped).withKindMismatchRetry(
      '/workspace/CLAUDE.md',
      op
    );
    expect(result).toBe('read after heal');
    expect(calls).toBe(2);
    detachFakes(vfs);
    await vfs.dispose();

    // Genuine EINVAL (reality agrees with memory): one probe, no retry.
    // Reality must CONTAIN keep.txt as a file for agreement — a missing
    // path would legitimately heal.
    const vfs2 = await VirtualFS.create({ dbName: `test-2146-${Date.now()}`, wipe: true });
    const idx2 = new Map<string, { mode?: number }>([
      ['/workspace/keep.txt', { mode: S_IFREG | 0o644 }],
    ]);
    const h2 = new Map<string, { kind?: string }>([['/workspace/keep.txt', { kind: 'file' }]]);
    const internal2 = vfs2 as unknown as {
      backend: string;
      opfsBackendFs: unknown;
      opfsHandle: unknown;
    };
    internal2.backend = 'opfs';
    internal2.opfsBackendFs = { index: idx2, _handles: h2 };
    internal2.opfsHandle = fakeDirHandle({
      workspace: fakeDirHandle({ 'keep.txt': fakeFileHandle(10) }),
    });
    let calls2 = 0;
    const op2 = async (): Promise<string> => {
      calls2 += 1;
      throw new FsError('EINVAL', 'bad argument', '/workspace/keep.txt');
    };
    await expect(
      (vfs2 as unknown as Wrapped).withKindMismatchRetry('/workspace/keep.txt', op2)
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls2).toBe(1);
    expect(h2.has('/workspace/keep.txt')).toBe(true);
    detachFakes(vfs2);
    await vfs2.dispose();
  });

  it('rename heals whichever end is poisoned (multi-path retry, #2146)', async () => {
    const { vfs, fakeIndex } = await corruptedVfs();
    // Give reality a keep.txt so the healthy source AGREES with memory and
    // reconciles nothing — only the poisoned destination heals.
    const internalR = vfs as unknown as { opfsHandle: unknown };
    internalR.opfsHandle = fakeDirHandle({
      workspace: fakeDirHandle({
        'CLAUDE.md': fakeFileHandle(16249),
        'keep.txt': fakeFileHandle(10),
      }),
    });
    type WrappedPaths = {
      withKindMismatchRetryPaths<T>(paths: readonly string[], op: () => Promise<T>): Promise<T>;
    };
    let calls = 0;
    const op = async (): Promise<string> => {
      calls += 1;
      // The poisoned entry is the DESTINATION; the source is healthy.
      if (fakeIndex.has('/workspace/CLAUDE.md')) {
        throw new FsError('ENOTDIR', 'not a directory', '/workspace/CLAUDE.md');
      }
      return 'renamed';
    };
    const result = await (vfs as unknown as WrappedPaths).withKindMismatchRetryPaths(
      ['/workspace/keep.txt', '/workspace/CLAUDE.md'],
      op
    );
    expect(result).toBe('renamed');
    // keep.txt reconciles nothing (healthy), CLAUDE.md heals — exactly one retry.
    expect(calls).toBe(2);
    expect(fakeIndex.has('/workspace/CLAUDE.md')).toBe(false);
    expect(fakeIndex.has('/workspace/keep.txt')).toBe(true);
    detachFakes(vfs);
    await vfs.dispose();
  });
});

describe('sidecar flush guard against in-memory kind flips (#2006)', () => {
  const S_IFDIR = 0o40000;
  const S_IFREG = 0o100000;

  it('a write cannot propagate a lying in-memory kind onto a correct sidecar', async () => {
    const dbName = `test-2006-flush-${Date.now()}`;
    const vfs = await VirtualFS.create({ dbName, wipe: true });

    // On disk: the CORRECT sidecar — CLAUDE.md is a file.
    const onDisk = {
      version: 1,
      entries: {
        '/workspace/CLAUDE.md': { mode: S_IFREG | 0o644, size: 16249 },
      },
    };
    let written: string | null = null;
    const metadataFile = {
      kind: 'file',
      getFile: async () => ({ text: async () => JSON.stringify(onDisk), size: 100 }),
      createWritable: async () => ({
        write: async (data: string) => {
          written = data;
        },
        close: async () => {},
      }),
    };
    // OPFS reality: CLAUDE.md is a real file (sides with the disk record).
    const opfsRoot = {
      kind: 'directory',
      getFileHandle: async (name: string) => {
        if (name === '.metadata.json') return metadataFile;
        throw new Error('TypeMismatch');
      },
      getDirectoryHandle: async (name: string) => {
        if (name === 'workspace') {
          return {
            kind: 'directory',
            getFileHandle: async (n: string) => {
              if (n === 'CLAUDE.md')
                return { kind: 'file', getFile: async () => ({ size: 16249 }) };
              throw new Error('TypeMismatch');
            },
            getDirectoryHandle: async () => {
              throw new Error('TypeMismatch');
            },
          };
        }
        throw new Error('TypeMismatch');
      },
    };

    // In memory: the POISONED index wants to persist CLAUDE.md as a directory.
    const fakeIndex = new Map<string, { mode?: number }>([
      ['/workspace/CLAUDE.md', { mode: S_IFDIR | 0o755 }],
    ]);
    const backendFs = {
      index: Object.assign(fakeIndex, {
        toJSON: () => ({
          version: 1,
          entries: Object.fromEntries(fakeIndex),
        }),
      }),
      _handles: new Map<string, unknown>([['/workspace/CLAUDE.md', { kind: 'directory' }]]),
    };
    const internal = vfs as unknown as {
      backend: string;
      opfsBackendFs: unknown;
      opfsHandle: unknown;
      writeOpfsMetadataSidecarUnlocked(): Promise<void>;
    };
    internal.backend = 'opfs';
    internal.opfsBackendFs = backendFs;
    internal.opfsHandle = opfsRoot;
    // The realm marked the flipped path dirty (the re-corruption window).
    const statics = VirtualFS as unknown as {
      opfsBackends: Map<string, { backendFs: unknown; refs: number; sidecarDirty: unknown }>;
    };
    statics.opfsBackends.set(dbName, {
      backendFs,
      refs: 1,
      sidecarDirty: { paths: new Set(['/workspace/CLAUDE.md']), prefixes: new Set() },
    });

    try {
      await internal.writeOpfsMetadataSidecarUnlocked();

      expect(written).not.toBeNull();
      const flushed = JSON.parse(written as unknown as string) as {
        entries: Record<string, { mode: number }>;
      };
      // The on-disk (correct) kind survived the flush…
      expect(flushed.entries['/workspace/CLAUDE.md'].mode & 0o170000).toBe(S_IFREG);
      // …and the lying in-memory entry was evicted so the next access re-reads truth.
      expect(fakeIndex.has('/workspace/CLAUDE.md')).toBe(false);
      expect(backendFs._handles.has('/workspace/CLAUDE.md')).toBe(false);
    } finally {
      statics.opfsBackends.delete(dbName);
      internal.backend = 'memory';
      internal.opfsBackendFs = null;
      await vfs.dispose();
    }
  });

  // Review catches on #2135, both against the flush guard:
  //  - a poisoned entry reached only via a dirty PREFIX must not bypass the
  //    probe (rename subtree marks overlay entries dirty.paths never names);
  //  - a flip whose probe reports missing/unreadable must be excluded from
  //    the overlay rather than accepted (fail closed).
  it('prefix-covered and unverifiable flips cannot overwrite the sidecar record', async () => {
    const dbName = `test-2006-flush2-${Date.now()}`;
    const vfs = await VirtualFS.create({ dbName, wipe: true });

    const onDisk = {
      version: 1,
      entries: {
        '/renamed/poisoned.md': { mode: S_IFREG | 0o644, size: 10 },
        '/gone/unverifiable.md': { mode: S_IFREG | 0o644, size: 20 },
      },
    };
    let written: string | null = null;
    const metadataFile = {
      kind: 'file',
      getFile: async () => ({ text: async () => JSON.stringify(onDisk), size: 100 }),
      createWritable: async () => ({
        write: async (data: string) => {
          written = data;
        },
        close: async () => {},
      }),
    };
    // OPFS reality: /renamed/poisoned.md is a real FILE (memory lies);
    // /gone is absent entirely (probe reports missing).
    const opfsRoot = {
      kind: 'directory',
      getFileHandle: async (name: string) => {
        if (name === '.metadata.json') return metadataFile;
        throw new Error('TypeMismatch');
      },
      getDirectoryHandle: async (name: string) => {
        if (name === 'renamed') {
          return {
            kind: 'directory',
            getFileHandle: async (n: string) => {
              if (n === 'poisoned.md') return { kind: 'file', getFile: async () => ({ size: 10 }) };
              throw new Error('TypeMismatch');
            },
            getDirectoryHandle: async () => {
              throw new Error('TypeMismatch');
            },
          };
        }
        throw new Error('TypeMismatch'); // '/gone' does not exist
      },
    };

    const fakeIndex = new Map<string, { mode?: number }>([
      ['/renamed/poisoned.md', { mode: S_IFDIR | 0o755 }],
      ['/gone/unverifiable.md', { mode: S_IFDIR | 0o755 }],
    ]);
    const backendFs = {
      index: Object.assign(fakeIndex, {
        toJSON: () => ({ version: 1, entries: Object.fromEntries(fakeIndex) }),
      }),
      _handles: new Map<string, unknown>(),
    };
    const internal = vfs as unknown as {
      backend: string;
      opfsBackendFs: unknown;
      opfsHandle: unknown;
      writeOpfsMetadataSidecarUnlocked(): Promise<void>;
    };
    internal.backend = 'opfs';
    internal.opfsBackendFs = backendFs;
    internal.opfsHandle = opfsRoot;
    const statics = VirtualFS as unknown as {
      opfsBackends: Map<string, { backendFs: unknown; refs: number; sidecarDirty: unknown }>;
    };
    // Neither path is in dirty.paths — they are covered only by prefixes,
    // exactly the overlay route the first review comment named.
    statics.opfsBackends.set(dbName, {
      backendFs,
      refs: 1,
      sidecarDirty: { paths: new Set(), prefixes: new Set(['/renamed', '/gone']) },
    });

    try {
      await internal.writeOpfsMetadataSidecarUnlocked();
      const flushed = JSON.parse(written as unknown as string) as {
        entries: Record<string, { mode: number }>;
      };
      // Prefix-covered poison: reality sided with the disk — record survives,
      // liar evicted.
      expect(flushed.entries['/renamed/poisoned.md'].mode & 0o170000).toBe(S_IFREG);
      expect(fakeIndex.has('/renamed/poisoned.md')).toBe(false);
      // Unverifiable flip: on-disk record survives, but the live index is
      // NOT evicted on an unverified probe.
      expect(flushed.entries['/gone/unverifiable.md'].mode & 0o170000).toBe(S_IFREG);
      expect(fakeIndex.has('/gone/unverifiable.md')).toBe(true);
    } finally {
      statics.opfsBackends.delete(dbName);
      internal.backend = 'memory';
      internal.opfsBackendFs = null;
      await vfs.dispose();
    }
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
