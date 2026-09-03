/**
 * `getNativeFile` across the VFS read surface: VirtualFS (mount and
 * OPFS-less root), LocalMountBackend, RestrictedFS, and the shell adapter.
 * The contract every consumer relies on is "a lazy `File`, or `null`,
 * never a throw" — the null is what makes the whole-file fallback safe.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MountBackend } from '../../src/fs/mount/backend.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

function handleless(): MountBackend {
  return {
    kind: 'da',
    source: 'da://test/repo',
    mountId: 'no-handle',
    readDir: async () => [],
    readFile: async () => new Uint8Array([1]),
    stat: async () => ({ kind: 'file', size: 1, mtime: 0 }),
    writeFile: async () => {},
    mkdir: async () => {},
    remove: async () => {},
    refresh: async () => ({ added: [], removed: [], changed: [], unchanged: 0, errors: [] }),
    describe: () => ({ displayName: 'test/repo' }),
    close: async () => {},
  };
}

describe('LocalMountBackend.getNativeFile', () => {
  const backend = LocalMountBackend.fromHandle(
    createDirectoryHandle({ 'a.mp4': 'AAAA', sub: { 'b.mp4': 'BB' } }),
    { mountId: 'm1' }
  );

  it('returns the lazy File behind a path without reading it', async () => {
    const file = await backend.getNativeFile('sub/b.mp4');
    expect(file).not.toBeNull();
    expect((file as File).size).toBe(2);
    expect(await (file as File).text()).toBe('BB');
  });

  it('answers null for a missing path or a directory', async () => {
    await expect(backend.getNativeFile('nope.mp4')).resolves.toBeNull();
    await expect(backend.getNativeFile('sub')).resolves.toBeNull();
  });
});

describe('VirtualFS.getNativeFile', () => {
  let vfs: VirtualFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: `test-native-file-${Date.now()}`, wipe: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.writeFile('/workspace/plain.mp4', new Uint8Array([1, 2, 3]));
    await vfs.mount(
      '/mnt/fsa',
      LocalMountBackend.fromHandle(createDirectoryHandle({ 'clip.mp4': 'CLIP' }), {
        mountId: 'fsa',
      })
    );
    await vfs.mount('/mnt/remote', handleless());
  });

  afterAll(async () => {
    await vfs.dispose();
  });

  it('hands out the File of an FSA-mounted path', async () => {
    const file = await vfs.getNativeFile('/mnt/fsa/clip.mp4');
    expect(await (file as File).text()).toBe('CLIP');
  });

  it('answers null for the mount point itself and for a backend without handles', async () => {
    await expect(vfs.getNativeFile('/mnt/fsa')).resolves.toBeNull();
    await expect(vfs.getNativeFile('/mnt/remote/anything.mp4')).resolves.toBeNull();
  });

  it('answers null on the memory backend (no OPFS handle) so callers fall back', async () => {
    await expect(vfs.getNativeFile('/workspace/plain.mp4')).resolves.toBeNull();
    // ...and the fallback read still works, which is the whole point.
    const bytes = (await vfs.readFile('/workspace/plain.mp4', {
      encoding: 'binary',
    })) as Uint8Array;
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('is reachable through the shell adapter and RestrictedFS', async () => {
    const adapter = new VfsAdapter(vfs);
    expect(await (await adapter.getNativeFile('/mnt/fsa/clip.mp4'))?.text()).toBe('CLIP');

    const restricted = new RestrictedFS(vfs, ['/mnt/fsa/']);
    expect(await (await restricted.getNativeFile('/mnt/fsa/clip.mp4'))?.text()).toBe('CLIP');
    // Outside the sandbox: null, not a throw — the caller's fallback
    // `readFile` is what raises the sandbox ENOENT.
    await expect(restricted.getNativeFile('/workspace/plain.mp4')).resolves.toBeNull();
    await expect(restricted.readFile('/workspace/plain.mp4')).rejects.toThrow('ENOENT');
    await expect(restricted.getNativeFile('/dev/null')).resolves.toBeNull();
  });
});
