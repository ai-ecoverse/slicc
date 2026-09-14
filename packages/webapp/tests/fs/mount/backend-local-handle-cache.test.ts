import { describe, expect, it } from 'vitest';
import { LocalMountBackend } from '../../../src/fs/mount/backend-local.js';
import {
  createCountingDirectoryHandle,
  createDirectoryHandle,
  createMutableDirectoryHandle,
} from '../fsa-test-helpers.js';

function packDirTree(fileCount: number): Record<string, unknown> {
  const pack: Record<string, string> = {};
  for (let i = 0; i < fileCount; i++) pack[`pack-${i}.idx`] = `idx-${i}`;
  return { '.git': { objects: { pack, info: { packs: 'P pack-0.pack\n' } } } };
}

describe('LocalMountBackend readDir stat laziness (#2733)', () => {
  it('lists N files with zero getFile() calls when stats are not requested', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle(packDirTree(91) as never)
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const entries = await backend.readDir('.git/objects/pack');

    expect(entries).toHaveLength(91);
    expect(entries.every((e) => e.kind === 'file')).toBe(true);
    expect(counts.getFile).toBe(0);

    expect(counts.getDirectoryHandle).toBe(3);
    expect(counts.entries).toBe(1);
  });

  it('omits size/lastModified rather than reporting zeros', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hello' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const [entry] = await backend.readDir('/');

    expect(entry).toEqual({ name: 'a.txt', kind: 'file' });
    expect(entry.size).toBeUndefined();
    expect(entry.lastModified).toBeUndefined();
  });

  it('fills size/lastModified — one getFile() per file entry — with includeStats', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ 'a.txt': 'hello', 'b.txt': 'hi', sub: {} })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const entries = await backend.readDir('/', { includeStats: true });

    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('a.txt')!.size).toBe(5);
    expect(byName.get('b.txt')!.size).toBe(2);
    expect(typeof byName.get('a.txt')!.lastModified).toBe('number');

    expect(byName.get('sub')!.size).toBeUndefined();
    expect(counts.getFile).toBe(2);
  });

  it('agrees with stat() for the same path when stats are requested', async () => {
    const handle = createDirectoryHandle({ 'a.txt': 'hello' });
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const [entry] = await backend.readDir('/', { includeStats: true });
    const stat = await backend.stat('a.txt');

    expect(entry.size).toBe(stat.size);
    expect(entry.lastModified).toBe(stat.mtime);
  });
});

describe('LocalMountBackend directory-handle cache (#2733)', () => {
  it('does not re-walk from the root for a second op under the same directory', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ a: { b: { c: { 'x.txt': 'x', 'y.txt': 'yy' } } } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    await backend.readFile('a/b/c/x.txt');
    expect(counts.getDirectoryHandle).toBe(3);

    const before = counts.getDirectoryHandle;
    const body = await backend.readFile('a/b/c/y.txt');
    const entries = await backend.readDir('a/b/c');
    const stat = await backend.stat('a/b/c/x.txt');

    expect(new TextDecoder().decode(body)).toBe('yy');
    expect(entries.map((e) => e.name).sort()).toEqual(['x.txt', 'y.txt']);
    expect(stat).toMatchObject({ kind: 'file', size: 1 });
    expect(counts.getDirectoryHandle).toBe(before);
  });

  it('reuses the longest cached prefix when descending further', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ a: { b: { c: { d: { 'z.txt': 'z' } } } } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    await backend.readDir('a/b');
    expect(counts.getDirectoryHandle).toBe(2);

    await backend.readDir('a/b/c/d');

    expect(counts.getDirectoryHandle).toBe(4);
  });

  it('stat() resolves the parent once instead of walking the root twice', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ a: { b: { 'x.txt': 'x', sub: {} } } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    const fileStat = await backend.stat('a/b/x.txt');
    expect(fileStat).toMatchObject({ kind: 'file', size: 1 });
    expect(counts.getDirectoryHandle).toBe(2);
    expect(counts.getFileHandle).toBe(1);

    const dirStat = await backend.stat('a/b/sub');
    expect(dirStat).toEqual({ kind: 'directory', size: 0, mtime: 0 });
    expect(counts.getDirectoryHandle).toBe(3);
    expect(counts.getFileHandle).toBe(2);
  });

  it('stat() of a missing path still reports ENOENT and caches nothing', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ a: { b: {} } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });

    await expect(backend.stat('a/b/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    const cached = backend.getDirCacheSize();

    await expect(backend.stat('a/b/nope')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(backend.getDirCacheSize()).toBe(cached);

    expect(counts.getDirectoryHandle).toBe(4);
  });

  it('reports EACCES for a permission-denied file instead of masking it as ENOTDIR', async () => {
    const denied = createDirectoryHandle({ a: { 'secret.txt': 'x' } });
    const guarded = new Proxy(denied, {
      get(target, prop, receiver) {
        if (prop === 'getDirectoryHandle') {
          return async (name: string, options?: { create?: boolean }) => {
            const dir = await target.getDirectoryHandle(name, options);
            return new Proxy(dir, {
              get(dirTarget, dirProp, dirReceiver) {
                if (dirProp === 'getFileHandle') {
                  return async (fileName: string) => ({
                    kind: 'file' as const,
                    name: fileName,
                    getFile: async () => {
                      throw new DOMException('permission denied', 'NotAllowedError');
                    },
                  });
                }
                const v = Reflect.get(dirTarget, dirProp, dirReceiver);
                return typeof v === 'function' ? v.bind(dirTarget) : v;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const backend = LocalMountBackend.fromHandle(guarded, { mountId: 'm1' });

    await expect(backend.stat('a/secret.txt')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('still falls through to the directory branch for ENOENT and type mismatch', async () => {
    const backend = LocalMountBackend.fromHandle(
      createDirectoryHandle({ a: { sub: {}, 'f.txt': 'x' } }),
      { mountId: 'm1' }
    );

    expect(await backend.stat('a/sub')).toEqual({ kind: 'directory', size: 0, mtime: 0 });

    await expect(backend.stat('a/gone')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await backend.stat('a/f.txt')).toMatchObject({ kind: 'file', size: 1 });
  });

  it('is bounded — the cache never exceeds its ceiling', async () => {
    const tree: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) tree[`d${i}`] = { 'f.txt': 'x' };
    const backend = LocalMountBackend.fromHandle(createDirectoryHandle(tree as never), {
      mountId: 'm1',
      dirCacheMax: 4,
    });

    for (let i = 0; i < 20; i++) await backend.readDir(`d${i}`);

    expect(backend.getDirCacheSize()).toBe(4);

    expect((await backend.readDir('d0')).map((e) => e.name)).toEqual(['f.txt']);
  });
});

describe('LocalMountBackend cache invalidation (#2733)', () => {
  it('drops a removed directory and its descendants', async () => {
    const mut = createMutableDirectoryHandle({ a: { b: { 'x.txt': 'x' } } });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });

    expect((await backend.readDir('a/b')).map((e) => e.name)).toEqual(['x.txt']);

    await backend.remove('a/b', { recursive: true });

    await expect(backend.readDir('a/b')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(backend.stat('a/b/x.txt')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await backend.readDir('a')).toEqual([]);
  });

  it('keeps a sibling of a removed directory cached', async () => {
    const mut = createMutableDirectoryHandle({ a: { b: { 'x.txt': 'x' }, c: { 'y.txt': 'y' } } });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.readDir('a/b');
    await backend.readDir('a/c');

    await backend.remove('a/b', { recursive: true });

    expect((await backend.readDir('a/c')).map((e) => e.name)).toEqual(['y.txt']);
  });

  it('sees a write made through the backend on the next listing and stat', async () => {
    const mut = createMutableDirectoryHandle({ a: { b: {} } });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    expect(await backend.readDir('a/b')).toEqual([]);

    await backend.writeFile('a/b/new.txt', new TextEncoder().encode('body'));

    expect((await backend.readDir('a/b')).map((e) => e.name)).toEqual(['new.txt']);
    expect(await backend.stat('a/b/new.txt')).toMatchObject({ kind: 'file', size: 4 });
    expect((await backend.readDir('a/b', { includeStats: true }))[0].size).toBe(4);
  });

  it('sees a mkdir made through the backend', async () => {
    const mut = createMutableDirectoryHandle({ a: {} });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await expect(backend.readDir('a/fresh')).rejects.toMatchObject({ code: 'ENOENT' });

    await backend.mkdir('a/fresh');

    expect(await backend.readDir('a/fresh')).toEqual([]);
    expect(await backend.stat('a/fresh')).toEqual({ kind: 'directory', size: 0, mtime: 0 });
  });

  it('mkdir re-creates a path whose cached ancestor vanished outside the backend', async () => {
    const mut = createMutableDirectoryHandle({ a: { b: {} } });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.readDir('a/b');

    mut.removeEntry('a');

    await backend.mkdir('a/b/c');
    expect(await backend.readDir('a/b/c')).toEqual([]);
  });

  it('a read miss under a cached directory does not flush the cached ancestor', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ '.git': { objects: { pack: { 'p.idx': 'x' } } } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await backend.readDir('.git/objects/pack');
    const warm = counts.getDirectoryHandle;

    await expect(backend.readFile('.git/objects/ab/deadbeef')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    expect(counts.getDirectoryHandle).toBe(warm + 1);

    await backend.readDir('.git/objects/pack');
    expect(counts.getDirectoryHandle).toBe(warm + 1);
  });

  it('re-removing an already-removed path reports ENOENT', async () => {
    const mut = createMutableDirectoryHandle({ a: { b: {} } });
    const backend = LocalMountBackend.fromHandle(mut.handle, { mountId: 'm1' });
    await backend.remove('a/b');

    await expect(backend.remove('a/b')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refresh() drops resolved handles so the next op re-walks', async () => {
    const { handle, counts } = createCountingDirectoryHandle(
      createDirectoryHandle({ a: { b: {} } })
    );
    const backend = LocalMountBackend.fromHandle(handle, { mountId: 'm1' });
    await backend.readDir('a/b');
    expect(counts.getDirectoryHandle).toBe(2);

    await backend.refresh();

    expect(backend.getDirCacheSize()).toBe(0);
    await backend.readDir('a/b');
    expect(counts.getDirectoryHandle).toBe(4);
  });

  it('close() empties the cache', async () => {
    const backend = LocalMountBackend.fromHandle(createDirectoryHandle({ a: { b: {} } }), {
      mountId: 'm1',
    });
    await backend.readDir('a/b');
    expect(backend.getDirCacheSize()).toBeGreaterThan(0);

    await backend.close();

    expect(backend.getDirCacheSize()).toBe(0);
    await expect(backend.readDir('a/b')).rejects.toMatchObject({ code: 'EBADF' });
  });
});
