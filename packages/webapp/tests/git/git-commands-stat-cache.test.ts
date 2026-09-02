/**
 * How the readdir-primed stat cache (#2716) composes with the command-scoped
 * read memo (#2709), and how both are scoped.
 *
 * Two caches now sit between isomorphic-git and the VirtualFS:
 * `GitCommands.contextFor` builds a fresh adapter per `execute()` and, for a
 * cacheable subcommand, wraps it in `createCommandScopedReadCache`. They have
 * to compose in both directions — the wrapper must delegate through to the
 * adapter (or the listing never primes anything), and the adapter must be
 * per-invocation (or a listing outlives the command that took it and answers
 * a stat issued after the host filesystem moved on).
 *
 * The first half of this file asserts the STRUCTURE through the factory (one
 * adapter built and cleared per command, success or failure); the second half
 * asserts the BEHAVIOR through a counting VirtualFS, which is what actually
 * proves the two layers are stacked and not shadowing each other.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, Stats } from '../../src/fs/types.js';
// Type-only: the VALUE comes from the dynamic import below, after `vi.mock`.
import type { VirtualFS as Vfs } from '../../src/fs/virtual-fs.js';

type AdapterOpts = { statCacheMax?: number; objectCache?: boolean } | undefined;

const builds: { count: number; opts: AdapterOpts[] } = {
  count: 0,
  opts: [],
};
const clears = { count: 0 };

vi.mock('../../src/git/vfs-fs-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git/vfs-fs-adapter.js')>();
  return {
    ...actual,
    createIsomorphicGitFs: (
      vfs: Parameters<typeof actual.createIsomorphicGitFs>[0],
      opts?: Parameters<typeof actual.createIsomorphicGitFs>[1]
    ) => {
      builds.count++;
      builds.opts.push(opts);
      const client = actual.createIsomorphicGitFs(vfs, opts);
      return {
        ...client,
        clearStatCache: () => {
          clears.count++;
          client.clearStatCache();
        },
      };
    },
  };
});

const { VirtualFS } = await import('../../src/fs/virtual-fs.js');
const { GitCommands } = await import('../../src/git/git-commands.js');

let dbCounter = 0;
const CWD = '/workspace';

describe('GitCommands scopes the adapter stat cache to one command (#2716)', () => {
  let git: InstanceType<typeof GitCommands>;
  /** Adapters built while the constructor ran, i.e. before any command. */
  let constructorOpts: AdapterOpts[];

  beforeEach(async () => {
    const id = dbCounter++;
    const vfs = await VirtualFS.create({ dbName: `git-stat-cache-${id}`, wipe: true });
    await vfs.mkdir(CWD, { recursive: true });
    builds.opts.length = 0;
    git = new GitCommands({ fs: vfs, globalDbName: `git-stat-cache-global-${id}` });
    constructorOpts = builds.opts.slice();
    builds.count = 0;
    builds.opts.length = 0;
    clears.count = 0;
  });

  it('builds and clears one adapter per command that succeeds', async () => {
    const result = await git.execute(['init'], CWD);
    expect(result.exitCode).toBe(0);
    expect(builds.count).toBe(1);
    expect(clears.count).toBe(1);
  });

  it('clears after a command that fails', async () => {
    // No repository here, so `status` bails out — the listing must go anyway.
    const result = await git.execute(['status'], CWD);
    expect(result.exitCode).not.toBe(0);
    expect(clears.count).toBe(1);
  });

  it('never shares one adapter between two commands', async () => {
    await git.execute(['init'], CWD);
    await git.execute(['status'], CWD);
    // A cache built in the constructor would be built once and shared by
    // every command — including two that overlap in time (#2709 review).
    expect(builds.count).toBe(2);
    expect(clears.count).toBe(2);
  });

  it('gives a command’s adapter both memos, and the pack sampler neither', async () => {
    // `GitCacheManager` (#2710) validates its cached packs by re-listing
    // `objects/pack` and lstat'ing `packed-refs`. A validator must not
    // validate against a memo — so the adapter it samples through is built
    // BARE: no object memo (#2712, which would memoize that very listing) and
    // no stat cache (#2716, which would memoize that very lstat).
    expect(constructorOpts).toEqual([{ statCacheMax: 0 }]);

    // A command's own adapter is the opposite: both memos on, for one call.
    await git.execute(['init'], CWD);
    expect(builds.opts).toEqual([{ objectCache: true }]);
  });
});

/**
 * A VirtualFS that counts the metadata questions reaching it. Anything the
 * two caches answer never gets here, which is the whole point.
 */
function countingVfs(inner: Vfs): {
  fs: Vfs;
  counts: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const fs = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'stat' || prop === 'lstat' || prop === 'readDir') {
        return (path: string, ...rest: unknown[]) => {
          bump(`${String(prop)} ${path}`);
          return (value as (...a: unknown[]) => unknown).call(target, path, ...rest);
        };
      }
      return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as Vfs;
  return { fs, counts };
}

describe('the two caches compose over one command (#2716 + #2709)', () => {
  let vfs: Vfs;
  let counting: ReturnType<typeof countingVfs>;
  let git: InstanceType<typeof GitCommands>;

  beforeEach(async () => {
    const id = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-stat-compose-${id}`, wipe: true });
    const setup = new GitCommands({ fs: vfs, globalDbName: `git-stat-compose-global-${id}` });
    await vfs.mkdir(CWD, { recursive: true });
    await setup.execute(['init'], CWD);
    for (let i = 0; i < 6; i++) {
      await vfs.writeFile(`${CWD}/tracked-${i}.txt`, `file ${i}\n`);
    }
    expect((await setup.execute(['add', '.'], CWD)).exitCode).toBe(0);
    expect((await setup.execute(['commit', '-m', 'first'], CWD)).exitCode).toBe(0);

    counting = countingVfs(vfs);
    git = new GitCommands({ fs: counting.fs, globalDbName: `git-stat-compose-global-${id}` });
    counting.counts.clear();
  });

  it('stats none of the working-tree files a cacheable command listed', async () => {
    // `status` is on CACHEABLE_COMMANDS, so its adapter is wrapped in the
    // #2709 read memo. The wrapper has to delegate through to the adapter for
    // the listing to prime anything at all — if it shadowed `readdir`, or if
    // the adapter were built without the listing fields, every one of these
    // would be a round trip (on a hostfs mount, an HTTP request each).
    const result = await git.execute(['status'], CWD);
    expect(result.exitCode).toBe(0);

    expect(counting.counts.get(`readDir ${CWD}`) ?? 0).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) {
      expect(counting.counts.get(`lstat ${CWD}/tracked-${i}.txt`) ?? 0).toBe(0);
      expect(counting.counts.get(`stat ${CWD}/tracked-${i}.txt`) ?? 0).toBe(0);
    }
  });

  it('keeps the #2709 memo working underneath (index stat’d once)', async () => {
    const result = await git.execute(['ls-files'], CWD);
    expect(result.exitCode).toBe(0);
    // The read memo still collapses the per-file `.git/index` re-stat; adding
    // a second cache under it must not have knocked that out.
    expect(counting.counts.get(`lstat ${CWD}/.git/index`) ?? 0).toBeLessThanOrEqual(1);
  });
});

/** The listing fields the whole stack depends on, at their source. */
describe('the listing a command primes from', () => {
  it('carries what a stat would report', async () => {
    const vfs = await VirtualFS.create({ dbName: `git-stat-src-${dbCounter++}`, wipe: true });
    await vfs.mkdir(CWD, { recursive: true });
    await vfs.writeFile(`${CWD}/a.txt`, 'abc');
    const entries: DirEntry[] = await vfs.readDir(CWD);
    const entry = entries.find((e) => e.name === 'a.txt');
    const stats: Stats = await vfs.stat(`${CWD}/a.txt`);
    expect(entry?.size).toBe(stats.size);
    expect(entry?.mtime).toBe(stats.mtime);
    expect(entry?.ino).toBe(stats.ino);
  });
});
