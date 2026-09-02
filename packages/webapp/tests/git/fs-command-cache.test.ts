/**
 * Tests for the command-scoped read cache in front of the isomorphic-git ↔
 * VirtualFS adapter — issue #2709.
 *
 * Warm `git ls-files` over a 3,549-file `--mount`ed host repo cost 11.1 s and
 * 16,336 hostfs round trips, two thirds of which were the SAME few paths:
 * `.git/index` was `lstat`ed once per tracked file (isomorphic-git's
 * `GitIndexManager.acquire` → `isIndexStale`) and every ancestor `.gitignore`
 * was re-read once per untracked candidate (`GitIgnoreManager.isIgnored`).
 *
 * The first half of this file unit-tests the wrapper (memoization, negative
 * caching, invalidation, budgets, scope lifetime); the second half drives real
 * `GitCommands.execute()` calls against a counting VirtualFS and asserts the
 * round-trip counts an actual `ls-files` / `status` produces.
 */

import 'fake-indexeddb/auto';
import * as git from 'isomorphic-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createCommandScopedReadCache } from '../../src/git/fs-command-cache.js';
import { GitCommands } from '../../src/git/git-commands.js';
import {
  createIsomorphicGitFs,
  type IsoGitFsPromises,
  type NodeLikeStats,
} from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;
const CWD = '/repo';

class FakeFsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function stubStats(size: number): NodeLikeStats {
  return {
    type: 'file',
    mode: 0o100644,
    size,
    ino: 1,
    mtimeMs: 1,
    ctimeMs: 1,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  };
}

/**
 * Minimal in-memory `IsoGitFsPromises` that records every call it is asked to
 * serve, so a test can assert "the cache absorbed the repeat".
 */
function fakeFs(): {
  fs: IsoGitFsPromises;
  calls: string[];
  files: Map<string, Uint8Array | string>;
  dirs: Map<string, string[]>;
  errors: Map<string, string>;
} {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array | string>();
  const dirs = new Map<string, string[]>();
  const errors = new Map<string, string>();
  const record = (op: string, path: string): void => {
    calls.push(`${op} ${path}`);
  };
  const raise = (path: string): void => {
    const code = errors.get(path);
    if (code) throw new FakeFsError(code);
  };
  const fs: IsoGitFsPromises = {
    async readFile(path) {
      record('readFile', path);
      raise(path);
      const value = files.get(path);
      if (value === undefined) throw new FakeFsError('ENOENT');
      return typeof value === 'string' ? value : new Uint8Array(value);
    },
    async writeFile(path, data) {
      record('writeFile', path);
      files.set(path, data);
    },
    async unlink(path) {
      record('unlink', path);
      files.delete(path);
    },
    async readdir(path) {
      record('readdir', path);
      raise(path);
      return [...(dirs.get(path) ?? [])];
    },
    async mkdir(path) {
      record('mkdir', path);
      dirs.set(path, []);
    },
    async rmdir(path) {
      record('rmdir', path);
      dirs.delete(path);
    },
    async stat(path) {
      record('stat', path);
      raise(path);
      return stubStats(1);
    },
    async lstat(path) {
      record('lstat', path);
      raise(path);
      return stubStats(1);
    },
    async readlink(path) {
      record('readlink', path);
      return '/target';
    },
    async symlink(_target, path) {
      record('symlink', path);
    },
  };
  return { fs, calls, files, dirs, errors };
}

function countOf(calls: string[], entry: string): number {
  return calls.filter((c) => c === entry).length;
}

describe('createCommandScopedReadCache (issue #2709)', () => {
  it('serves repeated stat/lstat of one path from a single round trip', async () => {
    const inner = fakeFs();
    const fs = createCommandScopedReadCache(inner.fs);
    await Promise.all([
      fs.lstat('/repo/.git/index'),
      fs.lstat('/repo/.git/index'),
      fs.lstat('/repo/.git/index'),
    ]);
    await fs.lstat('/repo/.git/index');
    await fs.stat('/repo/.git/index');
    expect(countOf(inner.calls, 'lstat /repo/.git/index')).toBe(1);
    // stat and lstat differ on symlinks, so they never share an entry.
    expect(countOf(inner.calls, 'stat /repo/.git/index')).toBe(1);
  });

  it('never shares a memo between two wrappers over one filesystem', async () => {
    // The memo IS the wrapper: two commands — even overlapping ones — hold
    // two wrappers and therefore two memos.
    const inner = fakeFs();
    const first = createCommandScopedReadCache(inner.fs);
    const second = createCommandScopedReadCache(inner.fs);
    await Promise.all([first.lstat('/a'), second.lstat('/a')]);
    await first.lstat('/a');
    await second.lstat('/a');
    expect(countOf(inner.calls, 'lstat /a')).toBe(2);
  });

  it('stops memoizing once the entry cap is reached, misses included', async () => {
    // Negative results carry no bytes, so only the entry cap bounds them — a
    // walk that probes thousands of absent loose objects must not grow the
    // memo without limit.
    const inner = fakeFs();
    const fs = createCommandScopedReadCache(inner.fs, { maxEntries: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(fs.readFile(`/repo/miss-${i}`, 'utf8')).rejects.toThrow('ENOENT');
      await expect(fs.readFile(`/repo/miss-${i}`, 'utf8')).rejects.toThrow('ENOENT');
    }
    // The first three misses are remembered: one round trip each.
    expect(inner.calls.filter((c) => c.startsWith('readFile /repo/miss-')).length).toBe(3);
    // The memo is full, so the next one is served but never retained.
    await expect(fs.readFile('/repo/over', 'utf8')).rejects.toThrow('ENOENT');
    await expect(fs.readFile('/repo/over', 'utf8')).rejects.toThrow('ENOENT');
    expect(countOf(inner.calls, 'readFile /repo/over')).toBe(2);
  });

  it('shares one entry budget across stat, readdir and readFile', async () => {
    const inner = fakeFs();
    inner.files.set('/repo/a.txt', 'a');
    const fs = createCommandScopedReadCache(inner.fs, { maxEntries: 2 });
    await fs.lstat('/repo');
    await fs.readdir('/repo');
    // Two entries already used, so this read is not retained.
    await fs.readFile('/repo/a.txt', 'utf8');
    await fs.readFile('/repo/a.txt', 'utf8');
    expect(countOf(inner.calls, 'readFile /repo/a.txt')).toBe(2);
    expect(countOf(inner.calls, 'lstat /repo')).toBe(1);
  });

  it('normalizes duplicate and trailing slashes onto one entry', async () => {
    const inner = fakeFs();
    const promises = createCommandScopedReadCache(inner.fs);
    await promises.lstat('/repo/.git/index');
    await promises.lstat('/repo//.git/index');
    expect(inner.calls.filter((c) => c.startsWith('lstat ')).length).toBe(1);
  });

  it('remembers a missing file but retries after a transient error', async () => {
    const inner = fakeFs();
    inner.errors.set('/repo/.gitignore', 'ENOENT');
    inner.errors.set('/repo/flaky', 'EIO');
    const promises = createCommandScopedReadCache(inner.fs);
    await expect(promises.readFile('/repo/.gitignore', 'utf8')).rejects.toThrow('ENOENT');
    await expect(promises.readFile('/repo/.gitignore', 'utf8')).rejects.toThrow('ENOENT');
    await expect(promises.readFile('/repo/flaky', 'utf8')).rejects.toThrow('EIO');
    await expect(promises.readFile('/repo/flaky', 'utf8')).rejects.toThrow('EIO');
    // The ENOENT is the answer; the EIO (hostfs bridge hiccup, #2720) is not.
    expect(countOf(inner.calls, 'readFile /repo/.gitignore')).toBe(1);
    expect(countOf(inner.calls, 'readFile /repo/flaky')).toBe(2);
  });

  it('keys reads by encoding and hands out copies of the bytes', async () => {
    const inner = fakeFs();
    inner.files.set('/repo/.git/index', new Uint8Array([1, 2, 3]));
    const promises = createCommandScopedReadCache(inner.fs);
    const first = (await promises.readFile('/repo/.git/index')) as Uint8Array;
    first[0] = 99;
    const second = (await promises.readFile('/repo/.git/index')) as Uint8Array;
    await promises.readFile('/repo/.git/index', 'utf8');
    expect(Array.from(second)).toEqual([1, 2, 3]);
    expect(countOf(inner.calls, 'readFile /repo/.git/index')).toBe(2); // binary + utf8
  });

  it('hands out an independent readdir array (isomorphic-git sorts in place)', async () => {
    const inner = fakeFs();
    inner.dirs.set('/repo', ['b', 'a']);
    const promises = createCommandScopedReadCache(inner.fs);
    const first = await promises.readdir('/repo');
    first.sort();
    first.push('injected');
    const second = await promises.readdir('/repo');
    expect(second).toEqual(['b', 'a']);
    expect(countOf(inner.calls, 'readdir /repo')).toBe(1);
  });

  it('never caches packfiles or pack indexes', async () => {
    const inner = fakeFs();
    inner.files.set('/repo/.git/objects/pack/p.pack', new Uint8Array([1]));
    inner.files.set('/repo/.git/objects/pack/p.idx', new Uint8Array([1]));
    const promises = createCommandScopedReadCache(inner.fs);
    await promises.readFile('/repo/.git/objects/pack/p.pack');
    await promises.readFile('/repo/.git/objects/pack/p.pack');
    await promises.readFile('/repo/.git/objects/pack/p.idx');
    await promises.readFile('/repo/.git/objects/pack/p.idx');
    expect(countOf(inner.calls, 'readFile /repo/.git/objects/pack/p.pack')).toBe(2);
    expect(countOf(inner.calls, 'readFile /repo/.git/objects/pack/p.idx')).toBe(2);
  });

  it('serves but does not retain a file above the per-file budget', async () => {
    const inner = fakeFs();
    const big = new Uint8Array(1024 * 1024 + 1);
    inner.files.set('/repo/big.bin', big);
    const promises = createCommandScopedReadCache(inner.fs);
    const first = (await promises.readFile('/repo/big.bin')) as Uint8Array;
    const second = (await promises.readFile('/repo/big.bin')) as Uint8Array;
    expect(first.byteLength).toBe(big.byteLength);
    expect(second.byteLength).toBe(big.byteLength);
    expect(countOf(inner.calls, 'readFile /repo/big.bin')).toBe(2);
  });

  describe("invalidation by the command's own writes", () => {
    it('writeFile refreshes the file and its parent listing', async () => {
      const inner = fakeFs();
      inner.files.set('/repo/a.txt', 'one');
      inner.dirs.set('/repo', ['a.txt']);
      const promises = createCommandScopedReadCache(inner.fs);
      expect(await promises.readFile('/repo/a.txt', 'utf8')).toBe('one');
      await promises.lstat('/repo/a.txt');
      await promises.readdir('/repo');
      await promises.writeFile('/repo/a.txt', 'two');
      expect(await promises.readFile('/repo/a.txt', 'utf8')).toBe('two');
      await promises.lstat('/repo/a.txt');
      await promises.readdir('/repo');
      expect(countOf(inner.calls, 'readFile /repo/a.txt')).toBe(2);
      expect(countOf(inner.calls, 'lstat /repo/a.txt')).toBe(2);
      expect(countOf(inner.calls, 'readdir /repo')).toBe(2);
    });

    it('unlink forgets the path, its parent listing and everything below it', async () => {
      const inner = fakeFs();
      const promises = createCommandScopedReadCache(inner.fs);
      await promises.lstat('/repo/sub/deep.txt');
      await promises.readdir('/repo/sub');
      await promises.readdir('/repo');
      await promises.unlink('/repo/sub');
      await promises.lstat('/repo/sub/deep.txt');
      await promises.readdir('/repo/sub');
      await promises.readdir('/repo');
      expect(countOf(inner.calls, 'lstat /repo/sub/deep.txt')).toBe(2);
      expect(countOf(inner.calls, 'readdir /repo/sub')).toBe(2);
      expect(countOf(inner.calls, 'readdir /repo')).toBe(2);
    });

    it('mkdir, rmdir and symlink refresh the paths they touch', async () => {
      const inner = fakeFs();
      const promises = createCommandScopedReadCache(inner.fs);
      await promises.readdir('/repo');
      await promises.mkdir('/repo/new');
      await promises.readdir('/repo');
      await promises.stat('/repo/new');
      await promises.rmdir('/repo/new');
      await promises.stat('/repo/new');
      await promises.lstat('/repo/link');
      await promises.symlink('/target', '/repo/link');
      await promises.lstat('/repo/link');
      expect(countOf(inner.calls, 'readdir /repo')).toBe(2);
      expect(countOf(inner.calls, 'stat /repo/new')).toBe(2);
      expect(countOf(inner.calls, 'lstat /repo/link')).toBe(2);
    });

    it('invalidates even when the write fails half way', async () => {
      const inner = fakeFs();
      const failing: IsoGitFsPromises = {
        ...inner.fs,
        async writeFile(path) {
          inner.calls.push(`writeFile ${path}`);
          throw new FakeFsError('EIO');
        },
      };
      const promises = createCommandScopedReadCache(failing);
      await promises.lstat('/repo/a.txt');
      await expect(promises.writeFile('/repo/a.txt', 'x')).rejects.toThrow('EIO');
      await promises.lstat('/repo/a.txt');
      expect(countOf(inner.calls, 'lstat /repo/a.txt')).toBe(2);
    });
  });
});

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

describe('GitCommands read caching end to end (issue #2709)', () => {
  let vfs: VirtualFS;
  let counting: { fs: VirtualFS; counts: Map<string, number> };
  let commands: GitCommands;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-fs-cache-${testId}`, wipe: true });
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-cache-global-${testId}`,
    });
    await vfs.mkdir(`${CWD}/sub`, { recursive: true });
    await setup.execute(['init'], CWD);
    await vfs.writeFile(`${CWD}/.gitignore`, 'ignored-*\n');
    await vfs.writeFile(`${CWD}/sub/.gitignore`, 'nested-*\n');
    for (let i = 0; i < 6; i++) {
      await vfs.writeFile(`${CWD}/tracked-${i}.txt`, `file ${i}\n`);
      await vfs.writeFile(`${CWD}/sub/tracked-${i}.txt`, `sub file ${i}\n`);
    }
    expect((await setup.execute(['add', '.'], CWD)).exitCode).toBe(0);
    expect((await setup.execute(['commit', '-m', 'first'], CWD)).exitCode).toBe(0);
    // Untracked candidates: each one makes isomorphic-git re-run isIgnored.
    for (let i = 0; i < 6; i++) {
      await vfs.writeFile(`${CWD}/untracked-${i}.txt`, 'nope\n');
      await vfs.writeFile(`${CWD}/sub/untracked-${i}.txt`, 'nope\n');
    }

    counting = countingVfs(vfs);
    commands = new GitCommands({
      fs: counting.fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-fs-cache-global-${testId}`,
    });
    counting.counts.clear();
  });

  it('re-stats the index and re-reads every .gitignore without the cache (control)', async () => {
    // Guards the assertions below: a bare adapter is exactly what shipped
    // before this change, and it is what produced 16,336 requests on a real
    // repo. If these ever drop to 1 on their own, the tests below stop
    // proving anything.
    await git.statusMatrix({
      // `statCacheMax: 0` is the BARE adapter: no readdir-primed stat cache
      // either (#2716), which would otherwise answer some of these lstats
      // from the listing of `.git` and understate the baseline these numbers
      // exist to describe.
      fs: createIsomorphicGitFs(counting.fs, { statCacheMax: 0 }),
      dir: CWD,
      refresh: false,
    });
    expect(counting.counts.get(`lstat ${CWD}/.git/index`) ?? 0).toBeGreaterThan(10);
    expect(counting.counts.get(`readFile ${CWD}/.gitignore`) ?? 0).toBeGreaterThan(5);
    expect(counting.counts.get(`readFile ${CWD}/sub/.gitignore`) ?? 0).toBeGreaterThan(1);
  });

  it('ls-files stats the index once and reads each ignore file once', async () => {
    const result = await commands.execute(['ls-files'], CWD);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tracked-0.txt');
    expect(result.stdout).toContain('sub/tracked-0.txt');
    expect(counting.counts.get(`lstat ${CWD}/.git/index`)).toBe(1);
    expect(counting.counts.get(`readFile ${CWD}/.gitignore`)).toBe(1);
    expect(counting.counts.get(`readFile ${CWD}/sub/.gitignore`)).toBe(1);
    expect(counting.counts.get(`stat ${CWD}/.git/info/exclude`)).toBe(1);
  });

  it('status reports the same tree with one index stat', async () => {
    const result = await commands.execute(['status', '--short'], CWD);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('?? untracked-0.txt');
    expect(counting.counts.get(`lstat ${CWD}/.git/index`)).toBe(1);
    expect(counting.counts.get(`readFile ${CWD}/.gitignore`)).toBe(1);
  });

  it('does not carry the cache across two execute() calls', async () => {
    await commands.execute(['ls-files'], CWD);
    const afterFirst = counting.counts.get(`lstat ${CWD}/.git/index`);
    await commands.execute(['ls-files'], CWD);
    expect(afterFirst).toBe(1);
    expect(counting.counts.get(`lstat ${CWD}/.git/index`)).toBe(2);
  });

  it('sees a change made between two commands', async () => {
    expect((await commands.execute(['status', '--short'], CWD)).stdout).not.toContain('brand-new');
    await vfs.writeFile(`${CWD}/brand-new.txt`, 'hello\n');
    expect((await commands.execute(['status', '--short'], CWD)).stdout).toContain(
      '?? brand-new.txt'
    );
  });

  it('honors the repo .gitignore while cached', async () => {
    await vfs.writeFile(`${CWD}/ignored-thing.txt`, 'hidden\n');
    await vfs.writeFile(`${CWD}/sub/nested-thing.txt`, 'hidden\n');
    const result = await commands.execute(['status', '--short'], CWD);
    expect(result.stdout).not.toContain('ignored-thing.txt');
    expect(result.stdout).not.toContain('nested-thing.txt');
    expect(result.stdout).toContain('?? untracked-0.txt');
  });

  it('gives two overlapping execute() calls two separate memos', async () => {
    // Regression for the review of #2709: the memo used to be reference-counted
    // instance state, so a second command starting while the first was still
    // in flight joined the first one's memo. Each invocation now stats the
    // index exactly once — two commands, two stats, never one.
    await Promise.all([
      commands.execute(['ls-files'], CWD),
      commands.execute(['status', '--short'], CWD),
    ]);
    expect(counting.counts.get(`lstat ${CWD}/.git/index`)).toBe(2);
  });

  it('runs a command that writes outside the adapter uncached', async () => {
    // `clean` deletes through ctx.fs, which the memo cannot see, so it must
    // never be handed a cached adapter — it re-stats the index per file.
    const result = await commands.execute(['clean', '-n'], CWD);
    expect(result.exitCode).toBe(0);
    expect(counting.counts.get(`lstat ${CWD}/.git/index`) ?? 0).toBeGreaterThan(1);
  });

  it('cannot be poisoned by an uncached command running concurrently', async () => {
    // `mv` writes the destination and removes the source through ctx.fs —
    // invisible to any memo. Running it alongside a cached command must not
    // leave a stale entry behind for the NEXT command to read.
    await Promise.all([
      commands.execute(['status', '--short'], CWD),
      commands.execute(['mv', 'tracked-0.txt', 'renamed-0.txt'], CWD),
    ]);
    const after = await commands.execute(['status', '--short'], CWD);
    expect(after.stdout).toContain('A  renamed-0.txt');
    expect(after.stdout).toContain('D  tracked-0.txt');
  });

  it('a command that writes through the adapter still sees its own writes', async () => {
    await commands.execute(['add', 'untracked-0.txt'], CWD);
    const staged = await commands.execute(['status', '--short'], CWD);
    expect(staged.stdout).toContain('A  untracked-0.txt');
    const committed = await commands.execute(['commit', '-m', 'second'], CWD);
    expect(committed.exitCode).toBe(0);
    const after = await commands.execute(['status', '--short'], CWD);
    // Committed, so it no longer shows up staged or untracked at the root.
    // (`sub/untracked-0.txt` is a different, still-untracked file.)
    expect(after.stdout.split('\n')).not.toContain('A  untracked-0.txt');
    expect(after.stdout.split('\n')).not.toContain('?? untracked-0.txt');
    const logged = await commands.execute(['log', '--oneline'], CWD);
    expect(logged.stdout).toContain('second');
  });
});
