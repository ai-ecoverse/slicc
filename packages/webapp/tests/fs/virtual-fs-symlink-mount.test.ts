/**
 * #3311: a VFS symlink whose target is on a mount used to succeed and then
 * follow into the empty LightningFS placeholder `mount()` plants at the mount
 * root. Reads/writes diverged from the real mount, and `ln -s` exited 0.
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
  await vfs.mount(
    path,
    LocalMountBackend.fromHandle(createDirectoryHandle({ 'index.md': '# kb' }), {
      mountId: `symlink-mount-${mountIdCounter++}`,
    })
  );
}

describe('VirtualFS.symlink vs mounts (#3311)', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({
      dbName: `test-symlink-mount-${dbCounter++}`,
      wipe: true,
    });
  });

  it('creates a same-layer symlink under /tmp', async () => {
    await vfs.mkdir('/tmp/lntest', { recursive: true });
    await vfs.writeFile('/tmp/lntest/target', 'hello');
    await vfs.symlink('/tmp/lntest/target', '/tmp/lntest/link');

    expect((await vfs.lstat('/tmp/lntest/link')).type).toBe('symlink');
    expect(await vfs.readlink('/tmp/lntest/link')).toBe('/tmp/lntest/target');
    expect(await vfs.readFile('/tmp/lntest/link')).toBe('hello');
  });

  it('refuses a symlink whose target is a mount and does not leave an empty directory', async () => {
    await mountKb(vfs);
    await vfs.mkdir('/shared', { recursive: true });

    await expect(vfs.symlink('/mnt/kb', '/shared/wiki')).rejects.toMatchObject({
      name: 'FsError',
      code: 'EXDEV',
      path: '/shared/wiki',
      message: expect.stringMatching(/mount boundary/),
    });

    expect(await vfs.exists('/shared/wiki')).toBe(false);
    await expect(vfs.lstat('/shared/wiki')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlink to a file under the mount, including a relative target', async () => {
    await mountKb(vfs);
    await vfs.mkdir('/shared', { recursive: true });

    await expect(vfs.symlink('/mnt/kb/index.md', '/shared/index-link')).rejects.toMatchObject({
      code: 'EXDEV',
    });
    expect(await vfs.exists('/shared/index-link')).toBe(false);

    await expect(vfs.symlink('../mnt/kb', '/shared/wiki')).rejects.toMatchObject({
      code: 'EXDEV',
    });
    expect(await vfs.exists('/shared/wiki')).toBe(false);
  });

  it('still refuses creating the link itself on a mounted filesystem', async () => {
    await mountKb(vfs);
    await expect(vfs.symlink('/tmp/x', '/mnt/kb/link')).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });
});
