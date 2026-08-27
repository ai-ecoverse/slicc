/**
 * `Stats.ino` — the one field that tells "the same file" from "the same path".
 *
 * VirtualFS reported `{type, size, mtime, ctime}` and dropped the inode ZenFS
 * had already allocated. Path was therefore the only identity the layers above
 * could see, which silently disarmed every consumer that re-identifies a file
 * before committing to it — see `tests/shell/split-inode-identity.test.ts` for
 * the command this actually broke.
 *
 * Mount-backed subtrees stay identity-less on purpose: hostfs and the remote
 * backends expose `{kind, size, mtime}` and nothing inode-shaped, and inventing
 * a token that only encodes the path would claim a guarantee we cannot keep.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';

let dbCounter = 0;

async function makeFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `vfs-inode-${dbCounter++}`, wipe: true });
  await fs.mkdir('/workspace', { recursive: true });
  await fs.writeFile('/workspace/a.txt', 'aaa');
  await fs.writeFile('/workspace/b.txt', 'bbb');
  return fs;
}

describe('VirtualFS — inode identity', () => {
  it('stat reports an inode for a regular file', async () => {
    const fs = await makeFs();
    const st = await fs.stat('/workspace/a.txt');
    expect(st.ino).toBeGreaterThan(0);
  });

  it('gives two different files two different inodes', async () => {
    const fs = await makeFs();
    const [a, b] = [await fs.stat('/workspace/a.txt'), await fs.stat('/workspace/b.txt')];
    expect(a.ino).not.toBe(b.ino);
  });

  it('keeps the inode stable across a rewrite — same file, new contents', async () => {
    const fs = await makeFs();
    const before = await fs.stat('/workspace/a.txt');
    await fs.writeFile('/workspace/a.txt', 'a much longer body than before');
    const after = await fs.stat('/workspace/a.txt');
    expect(after.ino).toBe(before.ino);
    expect(after.size).not.toBe(before.size);
  });

  it('agrees between the async and the sync fast path', async () => {
    const fs = await makeFs();
    const async = await fs.stat('/workspace/a.txt');
    expect(fs.statSync('/workspace/a.txt')?.ino).toBe(async.ino);
  });

  it('agrees between stat and lstat on a non-symlink', async () => {
    const fs = await makeFs();
    const [st, lst] = [await fs.stat('/workspace/a.txt'), await fs.lstat('/workspace/a.txt')];
    expect(lst.ino).toBe(st.ino);
    expect(fs.lstatSync('/workspace/a.txt')?.ino).toBe(st.ino);
  });

  it('distinguishes a symlink from its target — lstat is not stat', async () => {
    const fs = await makeFs();
    await fs.symlink('/workspace/a.txt', '/workspace/link.txt');
    const link = await fs.lstat('/workspace/link.txt');
    const target = await fs.stat('/workspace/link.txt');
    expect(link.type).toBe('symlink');
    expect(target.ino).toBe((await fs.stat('/workspace/a.txt')).ino);
    expect(link.ino).not.toBe(target.ino);
  });

  it('reports a directory inode too', async () => {
    const fs = await makeFs();
    expect((await fs.stat('/workspace')).ino).toBeGreaterThan(0);
  });
});
