import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';

describe('rename onto an existing symlink', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-rename-link-${Math.random()}`, wipe: true });
    await fs.mkdir('/d', { recursive: true });
    await fs.writeFile('/d/x', 'X');
    await fs.writeFile('/d/y', 'Y');
  });
  afterEach(async () => {
    await fs.dispose();
  });

  it('replaces the link (ln -sf, mv -f), leaving the source gone', async () => {
    await fs.symlink('/d/x', '/d/a');
    await fs.symlink('/d/y', '/d/t');
    await fs.rename('/d/t', '/d/a');
    expect(await fs.readlink('/d/a')).toBe('/d/y');
    await expect(fs.lstat('/d/t')).rejects.toThrow();
    expect(
      (await fs.readDir('/d')).map((e) => (typeof e === 'string' ? e : e.name)).sort()
    ).toEqual(['a', 'x', 'y']);
  });

  it('a file renamed onto a link replaces the link, not its target', async () => {
    await fs.symlink('/d/x', '/d/a');
    await fs.writeFile('/d/f', 'F');
    await fs.rename('/d/f', '/d/a');
    expect((await fs.lstat('/d/a')).type).toBe('file');
    expect(await fs.readFile('/d/a', { encoding: 'utf-8' })).toBe('F');
    expect(await fs.readFile('/d/x', { encoding: 'utf-8' })).toBe('X');
  });

  it('a link to a directory is replaced as a link, never followed', async () => {
    await fs.mkdir('/d/dir');
    await fs.writeFile('/d/dir/inside', 'I');
    await fs.symlink('/d/dir', '/d/a');
    await fs.symlink('/d/y', '/d/t');
    await fs.rename('/d/t', '/d/a');
    expect(await fs.readlink('/d/a')).toBe('/d/y');
    expect((await fs.readDir('/d/dir')).map((e) => (typeof e === 'string' ? e : e.name))).toEqual([
      'inside',
    ]);
  });

  it('keeps the link when the rename itself fails', async () => {
    await fs.symlink('/d/x', '/d/a');
    await fs.symlink('/d/y', '/d/t');

    const lfs = (fs as unknown as { lfs: { rename: (a: string, b: string) => Promise<void> } }).lfs;
    const rename = vi
      .spyOn(lfs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(fs.rename('/d/t', '/d/a')).rejects.toThrow();
    rename.mockRestore();
    expect(await fs.readlink('/d/a')).toBe('/d/x');
    expect(await fs.readlink('/d/t')).toBe('/d/y');
  });
});
