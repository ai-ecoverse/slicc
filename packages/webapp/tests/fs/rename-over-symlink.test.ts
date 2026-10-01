import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { sameFileIdentity } from '../../src/fs/same-file-identity.js';

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

  /** The store's rename, failing for the given [from, to] pairs. */
  function failRenames(...pairs: Array<[string, string]>) {
    const lfs = (fs as unknown as { lfs: { rename: (a: string, b: string) => Promise<void> } }).lfs;
    const real = lfs.rename.bind(lfs);
    return vi.spyOn(lfs, 'rename').mockImplementation(async (from: string, to: string) => {
      if (pairs.some(([f, t]) => from === f && (t === '*' || to === t))) {
        throw Object.assign(new Error(`EIO: injected ${from} -> ${to}`), { code: 'EIO' });
      }
      return real(from, to);
    });
  }

  it('a failed rename leaves the destination link itself, unchanged', async () => {
    await fs.symlink('/d/x', '/d/a');
    await fs.symlink('/d/y', '/d/t');
    const before = await fs.lstat('/d/a');
    const spy = failRenames(['/d/t', '/d/a']);
    await expect(fs.rename('/d/t', '/d/a')).rejects.toThrow(/injected/);
    spy.mockRestore();
    const after = await fs.lstat('/d/a');
    // The same entry, not a recreated one: identity and times survive.
    expect(sameFileIdentity(before, after)).toBe(true);
    expect(after.mtime).toBe(before.mtime);
    expect(await fs.readlink('/d/a')).toBe('/d/x');
    expect(await fs.readlink('/d/t')).toBe('/d/y');
    // Nothing parked is left behind.
    expect(
      (await fs.readDir('/d')).map((e) => (typeof e === 'string' ? e : e.name)).sort()
    ).toEqual(['a', 't', 'x', 'y']);
  });

  it('when the link cannot be put back either, the error says where it is', async () => {
    await fs.symlink('/d/x', '/d/a');
    await fs.symlink('/d/y', '/d/t');
    // The rename fails, and so does moving the parked link back.
    const both = failRenames(['/d/t', '/d/a']);
    const lfs = (fs as unknown as { lfs: { rename: (a: string, b: string) => Promise<void> } }).lfs;
    const parkedRestore = both.getMockImplementation() as (a: string, b: string) => Promise<void>;
    both.mockImplementation(async (from: string, to: string) => {
      if (from.includes('.slicc-rename-') && to === '/d/a') {
        throw Object.assign(new Error('EIO: restore'), { code: 'EIO' });
      }
      return parkedRestore.call(lfs, from, to);
    });
    const err = await fs.rename('/d/t', '/d/a').then(
      () => undefined,
      (e: Error) => e
    );
    both.mockRestore();
    expect(err?.message).toMatch(/rename.*could not be put back.*\/d\/\.a\.slicc-rename-/);
    // The link is not lost: it sits at the path the error names.
    const parked = /(\/d\/\.a\.slicc-rename-[a-z0-9]+)/.exec(err?.message ?? '')?.[1] as string;
    expect(await fs.readlink(parked)).toBe('/d/x');
    expect(await fs.readlink('/d/t')).toBe('/d/y');
  });
});
