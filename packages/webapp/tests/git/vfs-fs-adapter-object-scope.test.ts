/**
 * Unit tests for the `.git/objects` memo in the isomorphic-git fs adapter
 * (issue #2712).
 *
 * isomorphic-git's `_readObject` probes the loose path for every object and
 * `readObjectPacked` re-lists `objects/pack` on every call, so an object store
 * that lives behind HTTP (the hostfs bridge) pays two avoidable round trips
 * per object. The adapter answers both from one listing each — but only when
 * the caller opted in with `{ objectCache: true }`, and never across a write.
 *
 * The memo's lifetime IS the adapter's, so these tests build adapters the way
 * `GitCommands.contextFor()` does: one per command.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

const GITDIR = '/repo/.git';
const PACK_DIR = `${GITDIR}/objects/pack`;
/** A well-formed loose-object path whose fan-out directory does not exist. */
const MISSING_LOOSE = `${GITDIR}/objects/ab/${'c'.repeat(38)}`;

let dbCounter = 0;

describe('isomorphic-git fs adapter object cache (issue #2712)', () => {
  let vfs: VirtualFS;
  /** An adapter with the memo on, as one `git` invocation would get. */
  let client: ReturnType<typeof createIsomorphicGitFs>;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `git-object-scope-${dbCounter++}`, wipe: true });
    await vfs.mkdir(PACK_DIR, { recursive: true });
    await vfs.writeFile(`${PACK_DIR}/pack-1.idx`, 'idx');
    await vfs.writeFile(`${PACK_DIR}/pack-1.pack`, 'pack');
    client = createIsomorphicGitFs(vfs, { objectCache: true });
  });

  it('lists objects/pack once per adapter', async () => {
    const spy = vi.spyOn(vfs, 'readDir');

    const first = await client.promises.readdir(PACK_DIR);
    const second = await client.promises.readdir(PACK_DIR);

    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining(['pack-1.idx', 'pack-1.pack']));
    expect(spy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(1);
  });

  it('gives each adapter its own memo, so overlapping commands cannot share one', async () => {
    const spy = vi.spyOn(vfs, 'readDir');
    const other = createIsomorphicGitFs(vfs, { objectCache: true });

    await client.promises.readdir(PACK_DIR);
    await other.promises.readdir(PACK_DIR);

    expect(spy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(2);
  });

  it('shares one listing between concurrent readers', async () => {
    const spy = vi.spyOn(vfs, 'readDir');

    await Promise.all([
      client.promises.readdir(PACK_DIR),
      client.promises.readdir(PACK_DIR),
      client.promises.readdir(PACK_DIR),
    ]);

    expect(spy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(1);
  });

  it('hands out a copy, so an in-place sort by one caller cannot corrupt the memo', async () => {
    const first = await client.promises.readdir(PACK_DIR);
    first.length = 0;
    const second = await client.promises.readdir(PACK_DIR);

    expect(second).toEqual(expect.arrayContaining(['pack-1.idx', 'pack-1.pack']));
  });

  it('caches nothing unless the caller asked for it', async () => {
    const plain = createIsomorphicGitFs(vfs);
    const dirSpy = vi.spyOn(vfs, 'readDir');
    const readSpy = vi.spyOn(vfs, 'readFile');

    await plain.promises.readdir(PACK_DIR);
    await plain.promises.readdir(PACK_DIR);
    await expect(plain.promises.readFile(MISSING_LOOSE)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(dirSpy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(2);
    // The loose read reached the filesystem instead of being answered from a
    // fan-out listing.
    expect(readSpy).toHaveBeenCalledWith(MISSING_LOOSE, expect.anything());
  });

  it('answers a loose-object read from the fan-out listing when the directory is absent', async () => {
    const readSpy = vi.spyOn(vfs, 'readFile');

    await expect(client.promises.readFile(MISSING_LOOSE)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(client.promises.readFile(MISSING_LOOSE)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    expect(readSpy).not.toHaveBeenCalled();
  });

  it('still reads a loose object whose fan-out directory exists', async () => {
    await vfs.mkdir(`${GITDIR}/objects/ab`, { recursive: true });
    await vfs.writeFile(MISSING_LOOSE, 'loose');

    expect(await client.promises.readFile(MISSING_LOOSE, 'utf-8')).toBe('loose');
  });

  it('re-reads the object store after a write through the adapter', async () => {
    const dirSpy = vi.spyOn(vfs, 'readDir');

    await client.promises.readdir(PACK_DIR);
    await expect(client.promises.readFile(MISSING_LOOSE)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // A `git commit` mid-command writes a loose object; the negative memo must
    // not survive it.
    await client.promises.mkdir(`${GITDIR}/objects/ab`);
    await client.promises.writeFile(MISSING_LOOSE, 'loose');
    const content = await client.promises.readFile(MISSING_LOOSE, 'utf-8');
    await client.promises.readdir(PACK_DIR);

    expect(content).toBe('loose');
    expect(dirSpy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(2);
  });

  it('drops a memo a concurrent read repopulated while a write was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realMkdir = vfs.mkdir.bind(vfs);
    vi.spyOn(vfs, 'mkdir').mockImplementation(async (path, options) => {
      await gate;
      return await realMkdir(path, options);
    });

    // The mutation clears the memo up front and then stalls mid-flight.
    const pending = client.promises.mkdir(`${GITDIR}/objects/ab`);
    // A concurrent reader repopulates it with the PRE-write listing.
    await expect(client.promises.readFile(MISSING_LOOSE)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    release();
    await pending;
    // Written straight to the VFS so the assertion is about the mkdir's memo
    // drop, not a second invalidation from the object write itself.
    await vfs.writeFile(MISSING_LOOSE, 'loose');

    await expect(client.promises.readFile(MISSING_LOOSE, 'utf-8')).resolves.toBe('loose');
  });

  it('coexists with a ranged read: the window is served, the memo survives', async () => {
    // #2752 added the `{ start, end }` passthrough to `readFile`. A ranged
    // read is a READ, so it must neither be blocked by nor drop the memo.
    await vfs.writeFile(`${PACK_DIR}/pack-2.pack`, 'abcdefghij');
    const client2 = createIsomorphicGitFs(vfs, { objectCache: true });
    const dirSpy = vi.spyOn(vfs, 'readDir');

    await client2.promises.readdir(PACK_DIR);
    const window = await client2.promises.readFile(`${PACK_DIR}/pack-2.pack`, {
      start: 2,
      end: 5,
    });
    await client2.promises.readdir(PACK_DIR);

    expect(new TextDecoder().decode(window as Uint8Array)).toBe('cde');
    expect(dirSpy.mock.calls.filter((call) => call[0] === PACK_DIR)).toHaveLength(1);
  });

  it('answers a ranged read of an absent loose object from the memo', async () => {
    const rangeSpy = vi.spyOn(vfs, 'readFileRange');
    const readSpy = vi.spyOn(vfs, 'readFile');

    await expect(
      client.promises.readFile(MISSING_LOOSE, { start: 0, end: 4 })
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(rangeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('does not intercept paths that only look like loose objects', async () => {
    await vfs.mkdir('/repo/objects/ab', { recursive: true });
    await vfs.writeFile(`/repo/objects/ab/short`, 'not an object');

    expect(await client.promises.readFile('/repo/objects/ab/short', 'utf-8')).toBe('not an object');
  });
});
