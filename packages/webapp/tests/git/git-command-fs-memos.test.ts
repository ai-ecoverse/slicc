/**
 * Composition tests for the three caches that meet in `GitCommands`:
 *
 * - the per-invocation read cache from issue #2709 (`fs-command-cache.ts`),
 * - wrapped around an adapter carrying the per-invocation `.git/objects` memo
 *   from issue #2712 (`vfs-fs-adapter.ts`),
 * - over the INSTANCE-wide object/pack cache from issue #2710 (`git-cache.ts`).
 *
 * They land in the same seam and are easy to compose wrongly — layering the
 * read cache under the object memo, building a per-invocation one once per
 * instance, or minting a fresh object/pack cache per command — and every one
 * of those still compiles and still passes each PR's own suite. So these
 * assert the observable consequences: BOTH per-invocation memos active for ONE
 * command, NEITHER shared by two commands, and the object/pack cache surviving
 * across commands while they do not. A clean rebase proves none of it.
 */

import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

const CWD = '/project';
const PACK_DIR = `${CWD}/.git/objects/pack`;
const INDEX = `${CWD}/.git/index`;

let dbCounter = 0;

/** Wrap a VirtualFS so the test can count what reached the filesystem. */
function countingVfs(vfs: VirtualFS): { fs: VirtualFS; counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const counted = new Set(['stat', 'lstat', 'readFile', 'readDir']);
  const proxy = new Proxy(vfs, {
    get(target, prop, _receiver) {
      // Bind to the raw target: VirtualFS uses private fields, which throw
      // when a method runs with the proxy as `this`.
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!counted.has(String(prop))) return fn.bind(target);
      return (...args: unknown[]) => {
        const key = `${String(prop)} ${String(args[0])}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return fn.apply(target, args);
      };
    },
  });
  return { fs: proxy as VirtualFS, counts };
}

describe('per-invocation git fs memos (#2709 read cache over #2712 object memo)', () => {
  let vfs: VirtualFS;
  let counting: { fs: VirtualFS; counts: Map<string, number> };
  let commands: GitCommands;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-fs-memos-${testId}`, wipe: true });
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-memos-global-${testId}`,
    });
    await setup.execute(['init'], CWD);
    for (let i = 0; i < 6; i++) {
      await vfs.writeFile(`${CWD}/tracked-${i}.txt`, `file ${i}\n`);
    }
    await setup.execute(['add', '.'], CWD);
    await setup.execute(['commit', '-m', 'first'], CWD);
    await packEverything();
    // Untracked candidates, so the workdir walk has work to do.
    for (let i = 0; i < 4; i++) await vfs.writeFile(`${CWD}/untracked-${i}.txt`, 'nope\n');

    counting = countingVfs(vfs);
    commands = new GitCommands({
      fs: counting.fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-memos-global-${testId}`,
    });
    counting.counts.clear();
  });

  /**
   * Move every loose object into a packfile, so reading an object has to go
   * through `readObjectPacked` — the path that re-lists `objects/pack` and
   * that a loose 404 is paid for first.
   */
  async function packEverything(): Promise<void> {
    const lfs = createIsomorphicGitFs(vfs);
    const oids: string[] = [];
    for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
      if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
      for (const file of await vfs.readDir(`${CWD}/.git/objects/${dir.name}`)) {
        oids.push(dir.name + file.name);
      }
    }
    const { filename } = await isoGit.packObjects({ fs: lfs, dir: CWD, oids, write: true });
    await isoGit.indexPack({ fs: lfs, dir: CWD, filepath: `.git/objects/pack/${filename}` });
    for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
      if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
      await vfs.rm(`${CWD}/.git/objects/${dir.name}`, { recursive: true });
    }
  }

  const countOf = (key: string): number => counting.counts.get(key) ?? 0;

  it('pays both costs without either memo (control)', async () => {
    // Guards the assertions below: this is what a bare adapter does, and if
    // these numbers ever fall on their own the tests stop proving anything.
    // `statCacheMax: 0` keeps it bare in the third dimension too — without it
    // the readdir-primed stat cache (#2716) answers some of these lstats from
    // the listing of `.git` and understates the baseline.
    await isoGit.statusMatrix({
      fs: createIsomorphicGitFs(counting.fs, { statCacheMax: 0 }),
      dir: CWD,
      refresh: false,
    });

    expect(countOf(`lstat ${INDEX}`)).toBeGreaterThan(5);
    // One listing per object `_readObject` resolves (3 here: the commit and
    // two trees). The point is that it is not already 1.
    expect(countOf(`readDir ${PACK_DIR}`)).toBeGreaterThan(1);
  });

  it('gives one command the read cache, the object memo AND the stat cache', async () => {
    const result = await commands.execute(['status', '--short'], CWD);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('?? untracked-0.txt');
    // #2716: the workdir walk lstats every entry it just listed, and the
    // listing already carried size/mtime/ino — so not one of those reaches
    // the filesystem. This is the fourth seam in the same stack: it sits
    // UNDER the read cache and beside the object memo, and if the read cache
    // stopped delegating through to the adapter it would go to 10.
    for (let i = 0; i < 6; i++) {
      expect(countOf(`lstat ${CWD}/tracked-${i}.txt`)).toBe(0);
      expect(countOf(`stat ${CWD}/tracked-${i}.txt`)).toBe(0);
    }
    for (let i = 0; i < 4; i++) {
      expect(countOf(`lstat ${CWD}/untracked-${i}.txt`)).toBe(0);
    }
    // …and it never answered a stat nobody listed: the walk still had to see
    // the working tree.
    expect(countOf(`readDir ${CWD}`)).toBeGreaterThan(0);
    // #2709: the index is stat'ed once for the whole walk, not once per file.
    expect(countOf(`lstat ${INDEX}`)).toBe(1);
    // #2712: TWO listings of `objects/pack` for the whole command, not one per
    // object — #2710's cache manager samples the directory to decide whether
    // its cached packs are still valid, and the walk itself lists it once.
    expect(countOf(`readDir ${PACK_DIR}`)).toBe(2);
    // The assertion that actually pins the object memo: a read cache alone
    // would still pay one real round trip per DISTINCT missing loose object
    // (46,696 of them in the issue's `log --all`), whereas the fan-out listing
    // answers all of them without touching the filesystem.
    expect(
      [...counting.counts.keys()].filter((key) => /^readFile .*\/objects\/[0-9a-f]{2}\//.test(key))
    ).toEqual([]);
  });

  it('carries none of the per-invocation memos across two sequential commands', async () => {
    await commands.execute(['status', '--short'], CWD);
    await commands.execute(['status', '--short'], CWD);

    expect(countOf(`lstat ${INDEX}`)).toBe(2);
    expect(countOf(`readDir ${PACK_DIR}`)).toBe(4);
    // #2716's stat cache is per-invocation for the same reason, and the way
    // to see that is the listing it primes from: the second command re-lists
    // the working tree rather than answering from the first command's view of
    // it. (That the adapter itself is rebuilt per call — the only thing that
    // could let a listing outlive its command — is asserted directly in
    // `git-commands-stat-cache.test.ts`.)
    expect(countOf(`readDir ${CWD}`)).toBe(2);
  });

  it('shares neither memo between two commands running at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce!: () => void;
    const parked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const realReadDir = vfs.readDir.bind(vfs);
    let gated = false;
    // Park the FIRST command inside its `objects/pack` listing, so the second
    // one runs entirely inside the first one's window.
    const gatedVfs = new Proxy(counting.fs, {
      get(target, prop, receiver) {
        if (prop !== 'readDir') return Reflect.get(target, prop, receiver);
        return async (path: string) => {
          const counted = Reflect.get(target, prop, receiver) as typeof realReadDir;
          if (path === PACK_DIR && !gated) {
            gated = true;
            announce();
            await gate;
          }
          return await counted(path);
        };
      },
    }) as VirtualFS;
    const overlapping = new GitCommands({
      fs: gatedVfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: 'git-fs-memos-overlap',
    });

    const first = overlapping.execute(['status', '--short'], CWD);
    await parked;
    const second = overlapping.execute(['status', '--short'], CWD);
    for (let i = 0; i < 50 && countOf(`readDir ${PACK_DIR}`) < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();

    expect((await second).exitCode).toBe(0);
    expect((await first).exitCode).toBe(0);
    // Each command listed the pack directory and stat'ed the index for itself:
    // the second never joined the first's in-flight memo.
    // Each command stat'ed the index for itself: the second never joined the
    // first's read memo.
    expect(countOf(`lstat ${INDEX}`)).toBe(2);
    // And it issued its own `objects/pack` listings rather than awaiting the
    // first command's still-pending one — measured 3 across the pair; sharing
    // the object memo makes it 2.
    expect(countOf(`readDir ${PACK_DIR}`)).toBe(3);
  });
});

describe('git log --all across commands (#2710 pack cache under #2712 traversal)', () => {
  let vfs: VirtualFS;
  let counting: { fs: VirtualFS; counts: Map<string, number> };
  let commands: GitCommands;
  let packName = '';

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-log-all-cache-${testId}`, wipe: true });
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-all-cache-global-${testId}`,
    });
    await setup.execute(['init'], CWD);
    const commit = async (name: string, timestamp: number): Promise<void> => {
      await vfs.writeFile(`${CWD}/${name}.txt`, `${name}\n`);
      await setup.execute(['add', `${name}.txt`], CWD);
      await isoGit.commit({
        fs: createIsomorphicGitFs(vfs),
        dir: CWD,
        message: name,
        author: { name: 'Test User', email: 'test@example.com', timestamp },
      });
    };
    await commit('base', 1_700_000_000);
    for (let i = 0; i < 3; i++) {
      await setup.execute(['checkout', '-b', `topic-${i}`], CWD);
      await commit(`topic-${i}`, 1_700_001_000 + i);
      await setup.execute(['checkout', 'main'], CWD);
    }
    packName = await packAll(vfs);

    counting = countingVfs(vfs);
    commands = new GitCommands({
      fs: counting.fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-all-cache-global-${testId}`,
    });
    counting.counts.clear();
  });

  it('re-reads no pack on the second run, but rebuilds both per-invocation memos', async () => {
    const countOf = (key: string): number => counting.counts.get(key) ?? 0;
    const first = await commands.execute(['log', '--all', '-n', '20', '--oneline'], CWD);
    const idxAfterFirst = countOf(`readFile ${PACK_DIR}/${packName}.idx`);
    const packAfterFirst = countOf(`readFile ${PACK_DIR}/${packName}.pack`);

    const second = await commands.execute(['log', '--all', '-n', '20', '--oneline'], CWD);

    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout.split('\n').filter(Boolean)).toHaveLength(4);
    // #2710: the instance-wide object/pack cache SURVIVES the command, so the
    // second run re-reads neither the index nor the pack.
    expect(idxAfterFirst).toBe(1);
    expect(countOf(`readFile ${PACK_DIR}/${packName}.idx`)).toBe(1);
    expect(countOf(`readFile ${PACK_DIR}/${packName}.pack`)).toBe(packAfterFirst);
    // #2712 + #2709: the per-invocation memos do NOT survive — each command
    // lists the pack directory (twice: #2710's invalidation sample plus the
    // walk's own listing) and re-reads the refs for itself, so an outside
    // writer's new pack or moved branch is visible to the next command.
    expect(countOf(`readDir ${PACK_DIR}`)).toBe(4);
    expect(countOf(`readDir ${CWD}/.git/refs/heads`)).toBe(2);
    expect(countOf(`readFile ${CWD}/.git/refs/heads/main`)).toBe(2);
  });
});

/** Pack every loose object and delete the loose copies; returns the pack name. */
async function packAll(vfs: VirtualFS): Promise<string> {
  const lfs = createIsomorphicGitFs(vfs);
  const oids: string[] = [];
  for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
    if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
    for (const file of await vfs.readDir(`${CWD}/.git/objects/${dir.name}`)) {
      oids.push(dir.name + file.name);
    }
  }
  const { filename } = await isoGit.packObjects({ fs: lfs, dir: CWD, oids, write: true });
  await isoGit.indexPack({ fs: lfs, dir: CWD, filepath: `.git/objects/pack/${filename}` });
  for (const dir of await vfs.readDir(`${CWD}/.git/objects`)) {
    if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
    await vfs.rm(`${CWD}/.git/objects/${dir.name}`, { recursive: true });
  }
  return filename.replace(/\.pack$/, '');
}
