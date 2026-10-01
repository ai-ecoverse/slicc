import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { createDirectoryHandle } from './fsa-test-helpers.js';

/** Names in `dir`, sorted. */
async function names(fs: VirtualFS, dir: string): Promise<string[]> {
  return (await fs.readDir(dir)).map((e) => (typeof e === 'string' ? e : e.name)).sort();
}

// rename(2) of a directory onto an existing directory replaces it when it is
// empty and fails with ENOTEMPTY otherwise. The store answered EISDIR for
// both, so zig build's cache (tmp/<x> renamed onto an o/<hash> a previous
// build made) failed every warm build with `error: IsDir`.
describe('rename of a directory onto a directory', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-rename-dir-${Math.random()}`, wipe: true });
    await fs.mkdir('/c/src', { recursive: true });
    await fs.writeFile('/c/src/f', 'new');
    await fs.mkdir('/c/dst');
  });
  afterEach(async () => {
    await fs.dispose();
  });

  it('replaces an empty directory', async () => {
    await fs.rename('/c/src', '/c/dst');
    expect(await fs.readFile('/c/dst/f', { encoding: 'utf-8' })).toBe('new');
    await expect(fs.lstat('/c/src')).rejects.toThrow();
    // Nothing parked is left behind.
    expect(await names(fs, '/c')).toEqual(['dst']);
  });

  it('fails with ENOTEMPTY onto a non-empty directory, moving nothing', async () => {
    await fs.writeFile('/c/dst/old', 'old');
    await expect(fs.rename('/c/src', '/c/dst')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(await names(fs, '/c/dst')).toEqual(['old']);
    expect(await names(fs, '/c/src')).toEqual(['f']);
    expect(await names(fs, '/c')).toEqual(['dst', 'src']);
  });

  it('puts the empty directory back when the rename itself fails', async () => {
    const lfs = (fs as unknown as { lfs: { rename: (a: string, b: string) => Promise<void> } }).lfs;
    const real = lfs.rename.bind(lfs);
    const spy = vi.spyOn(lfs, 'rename').mockImplementation(async (from, to) => {
      if (from === '/c/src') throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
      return real(from, to);
    });
    await expect(fs.rename('/c/src', '/c/dst')).rejects.toThrow(/injected/);
    spy.mockRestore();
    expect((await fs.lstat('/c/dst')).type).toBe('directory');
    expect(await names(fs, '/c')).toEqual(['dst', 'src']);
  });

  it('keeps the other cases POSIX: a file onto a directory, a directory onto a file', async () => {
    await fs.writeFile('/c/file', 'x');
    await expect(fs.rename('/c/file', '/c/dst')).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(fs.rename('/c/src', '/c/file')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it("refuses to replace a mount's root (EBUSY): the store sees only its empty placeholder", async () => {
    await fs.mount(
      '/c/mnt',
      LocalMountBackend.fromHandle(createDirectoryHandle({ inside: 'I' }), { mountId: 'm' })
    );
    await expect(fs.rename('/c/src', '/c/mnt')).rejects.toMatchObject({ code: 'EBUSY' });
    expect(await fs.readFile('/c/mnt/inside', { encoding: 'utf-8' })).toBe('I');
    expect(await names(fs, '/c/src')).toEqual(['f']);
  });
});
