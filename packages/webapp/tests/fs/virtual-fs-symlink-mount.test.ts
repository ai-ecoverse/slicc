/**
 * A VFS symlink whose target is on a mount. #3311: it used to follow into the
 * empty LightningFS placeholder `mount()` plants at the mount root, so reads
 * and writes diverged from the real mount; the fix then refused such links
 * (EXDEV). But a symlink's target may be on any filesystem — `ln -s /mnt/x
 * /shared/y` must work — so resolution now stops at the mount boundary and
 * the rest of the path goes to the mount.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

let dbCounter = 0;
let mountIdCounter = 0;

async function mountKb(vfs: VirtualFS, path = '/mnt/kb'): Promise<void> {
  await vfs.mkdir(path, { recursive: true });
  const backend = LocalMountBackend.fromHandle(createDirectoryHandle({ 'index.md': '# kb' }), {
    mountId: `symlink-mount-${mountIdCounter++}`,
  });
  // A native rename, as hostfs has (the FSA backend has none).
  Object.assign(backend, {
    rename: async (from: string, to: string) => {
      await backend.writeFile(to, await backend.readFile(from));
      await backend.remove(from);
      return {};
    },
  });
  await vfs.mount(path, backend);
}

describe('VirtualFS.symlink onto a mount', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-symlink-mount-${dbCounter++}`,
      wipe: true,
    });
    await vfs.mkdir('/shared', { recursive: true });
  });

  it('creates a same-layer symlink under /tmp', async () => {
    await vfs.mkdir('/tmp/lntest', { recursive: true });
    await vfs.writeFile('/tmp/lntest/target', 'hello');
    await vfs.symlink('/tmp/lntest/target', '/tmp/lntest/link');

    expect((await vfs.lstat('/tmp/lntest/link')).type).toBe('symlink');
    expect(await vfs.readlink('/tmp/lntest/link')).toBe('/tmp/lntest/target');
    expect(await vfs.readFile('/tmp/lntest/link')).toBe('hello');
  });

  it('a link to a mounted directory reads, lists, stats and writes the mount', async () => {
    await mountKb(vfs);
    await vfs.symlink('/mnt/kb', '/shared/wiki');

    expect((await vfs.lstat('/shared/wiki')).type).toBe('symlink');
    expect(await vfs.readlink('/shared/wiki')).toBe('/mnt/kb');
    expect((await vfs.stat('/shared/wiki')).type).toBe('directory');
    expect(await vfs.exists('/shared/wiki/index.md')).toBe(true);
    expect(await vfs.readFile('/shared/wiki/index.md')).toBe('# kb');
    expect((await vfs.readDir('/shared/wiki')).map((e) => e.name)).toEqual(['index.md']);
    expect(await vfs.realpath('/shared/wiki/index.md')).toBe('/mnt/kb/index.md');

    // Writes land on the mount, not in the placeholder.
    await vfs.writeFile('/shared/wiki/new.md', 'fresh');
    expect(await vfs.readFile('/mnt/kb/new.md')).toBe('fresh');
    await vfs.appendFile('/shared/wiki/new.md', '!');
    expect(await vfs.readFile('/mnt/kb/new.md')).toBe('fresh!');
    await vfs.mkdir('/shared/wiki/sub');
    expect((await vfs.stat('/mnt/kb/sub')).type).toBe('directory');
  });

  it('a link to a mounted file, a relative target, and a link to such a link', async () => {
    await mountKb(vfs);
    await vfs.symlink('/mnt/kb/index.md', '/shared/index-link');
    expect(await vfs.readFile('/shared/index-link')).toBe('# kb');
    expect((await vfs.stat('/shared/index-link')).size).toBe(4);
    const range = await vfs.readFileRange('/shared/index-link', 2, 4);
    expect(new TextDecoder().decode(range)).toBe('kb');

    await vfs.symlink('../mnt/kb', '/shared/rel');
    expect(await vfs.readFile('/shared/rel/index.md')).toBe('# kb');

    await vfs.symlink('/shared/rel', '/tmp-chain');
    expect(await vfs.readFile('/tmp-chain/index.md')).toBe('# kb');
    expect(await vfs.realpath('/tmp-chain')).toBe('/mnt/kb');
  });

  it('the sync fast paths leave a link onto a mount to the async path (they cannot see the mount)', async () => {
    await mountKb(vfs);
    await vfs.symlink('/mnt/kb', '/shared/wiki');
    await vfs.symlink('/mnt/kb/index.md', '/shared/index-link');
    // null: "ask the async path" — never the empty placeholder's answer.
    expect(vfs.readDirSync('/shared/wiki')).toBeNull();
    expect(vfs.statSync('/shared/index-link')).toBeNull();
    expect(vfs.statSync('/shared/wiki')).toBeNull();
  });

  it('lstat, rm, rename and mkdir -p of a path beneath such a link act on the mount', async () => {
    await mountKb(vfs);
    await vfs.symlink('/mnt/kb', '/shared/wiki');
    expect((await vfs.lstat('/shared/wiki/index.md')).type).toBe('file');
    await vfs.writeFile('/shared/wiki/a.md', 'a');
    await vfs.rename('/shared/wiki/a.md', '/shared/wiki/b.md');
    expect(await vfs.readFile('/mnt/kb/b.md')).toBe('a');
    expect(await vfs.exists('/mnt/kb/a.md')).toBe(false);
    await vfs.rm('/shared/wiki/b.md');
    expect(await vfs.exists('/mnt/kb/b.md')).toBe(false);
    await vfs.mkdir('/shared/wiki/deep/er', { recursive: true });
    expect((await vfs.stat('/mnt/kb/deep/er')).type).toBe('directory');
    // Removing the link removes the link, not what it points at.
    await vfs.rm('/shared/wiki');
    expect(await vfs.readFile('/mnt/kb/index.md')).toBe('# kb');
    await expect(vfs.lstat('/shared/wiki')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still refuses creating the link itself on a mounted filesystem', async () => {
    await mountKb(vfs);
    await expect(vfs.symlink('/tmp/x', '/mnt/kb/link')).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });
});
