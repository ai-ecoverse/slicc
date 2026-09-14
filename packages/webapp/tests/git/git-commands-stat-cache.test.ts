import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, Stats } from '../../src/fs/types.js';

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
    const result = await git.execute(['status'], CWD);
    expect(result.exitCode).not.toBe(0);
    expect(clears.count).toBe(1);
  });

  it('never shares one adapter between two commands', async () => {
    await git.execute(['init'], CWD);
    await git.execute(['status'], CWD);

    expect(builds.count).toBe(2);
    expect(clears.count).toBe(2);
  });

  it('gives a command’s adapter both memos, and the pack sampler neither', async () => {
    expect(constructorOpts).toEqual([{ statCacheMax: 0 }]);

    await git.execute(['init'], CWD);
    expect(builds.opts).toEqual([{ objectCache: true }]);
  });
});

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

    expect(counting.counts.get(`lstat ${CWD}/.git/index`) ?? 0).toBeLessThanOrEqual(1);
  });
});

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
