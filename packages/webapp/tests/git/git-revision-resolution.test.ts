/**
 * Revision resolution order (#2713).
 *
 * `resolveRevision` used to try `expandOid` before `resolveRef`, so every
 * `HEAD` / branch lookup scanned all `.git/objects/pack/*.idx` files — 34
 * requests and 3.8 MB over a `--mount`ed host repo. Refs must win over hex
 * prefixes (git's own precedence), and `expandOid` may only be attempted for
 * tokens that could be an abbreviated oid.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

describe('git revision resolution (#2713)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-revision-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-revision-global-${testId}`,
    });
  });

  /** Two commits on `main`; returns [firstOid, secondOid]. */
  async function seedHistory(): Promise<[string, string]> {
    await git.execute(['init'], '/project');
    const oids: string[] = [];
    for (const version of ['one', 'two']) {
      await vfs.writeFile('/project/file.txt', version);
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', version], '/project');
      oids.push((await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim());
    }
    return [oids[0], oids[1]];
  }

  /**
   * Record every VFS path the git command touches. The isomorphic-git adapter
   * calls these methods on the live instance, so spying after construction is
   * enough.
   */
  function recordPaths(): string[] {
    const paths: string[] = [];
    for (const method of ['readFile', 'readDir', 'stat', 'lstat'] as const) {
      const original = vfs[method].bind(vfs);
      vi.spyOn(vfs, method).mockImplementation((async (...args: unknown[]) => {
        // Config lookups pass a null path; only real reads are interesting.
        if (typeof args[0] === 'string') paths.push(args[0]);
        return await (original as (...args: unknown[]) => Promise<unknown>)(...args);
      }) as never);
    }
    return paths;
  }

  it('resolves HEAD, a branch, a full oid and an abbreviated oid to the same commit', async () => {
    const [, second] = await seedHistory();
    await git.execute(['branch', 'feature'], '/project');

    for (const revision of ['HEAD', 'main', 'feature', second, second.slice(0, 7)]) {
      expect(await git.execute(['rev-parse', revision], '/project')).toEqual({
        stdout: `${second}\n`,
        stderr: '',
        exitCode: 0,
      });
    }
  });

  it('never reads objects/pack when resolving a symbolic ref', async () => {
    await seedHistory();
    await git.execute(['branch', 'feature'], '/project');

    const paths = recordPaths();
    for (const revision of ['HEAD', 'main', 'feature']) {
      expect((await git.execute(['rev-parse', revision], '/project')).exitCode).toBe(0);
    }

    expect(paths.filter((p) => p.includes('objects/pack'))).toEqual([]);
    expect(paths.length).toBeGreaterThan(0);
  });

  it('never reads objects/pack when resolving a full oid', async () => {
    const [, second] = await seedHistory();

    const paths = recordPaths();
    expect((await git.execute(['rev-parse', second], '/project')).stdout.trim()).toBe(second);

    expect(paths.filter((p) => p.includes('objects/pack'))).toEqual([]);
  });

  it('still scans the pack indexes for an abbreviated oid', async () => {
    const [, second] = await seedHistory();

    const paths = recordPaths();
    expect((await git.execute(['rev-parse', second.slice(0, 7)], '/project')).stdout.trim()).toBe(
      second
    );

    expect(paths.some((p) => p.includes('objects/pack'))).toBe(true);
  });

  it('prefers a ref over a genuinely colliding oid prefix', async () => {
    const [first, second] = await seedHistory();
    // A real collision: the branch name IS the second commit's oid prefix, but
    // it points at the first commit. Git resolves the ref, so `first` wins;
    // expandOid-first would answer `second`.
    const collidingName = second.slice(0, 8);
    await git.execute(['checkout', '-b', collidingName, first], '/project');
    await git.execute(['checkout', 'main'], '/project');
    expect(second).not.toBe(first);

    const paths = recordPaths();
    expect((await git.execute(['rev-parse', collidingName], '/project')).stdout.trim()).toBe(first);
    expect(paths.filter((p) => p.includes('objects/pack'))).toEqual([]);
  });

  it('reports an unresolvable revision without scanning the pack indexes', async () => {
    await seedHistory();

    const paths = recordPaths();
    expect(await git.execute(['rev-parse', 'no-such-ref'], '/project')).toEqual({
      stdout: '',
      stderr: "fatal: ambiguous argument 'no-such-ref'\n",
      exitCode: 128,
    });

    expect(paths.filter((p) => p.includes('objects/pack'))).toEqual([]);
  });

  describe('callers share the revision resolver', () => {
    it('show accepts a relative revision', async () => {
      const [first] = await seedHistory();
      const result = await git.execute(['show', 'HEAD~1'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(first);
      expect(result.stdout).toContain('one');
    });

    it('show <rev>:<path> accepts a relative revision', async () => {
      await seedHistory();
      const result = await git.execute(['show', 'HEAD~1:file.txt'], '/project');
      expect(result).toEqual({ stdout: 'one', stderr: '', exitCode: 0 });
    });

    it('show reports a bad object for an unresolvable <rev>:<path>', async () => {
      await seedHistory();
      const result = await git.execute(['show', 'no-such-ref:file.txt'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('bad object no-such-ref');
    });

    it('ls-tree accepts a relative revision', async () => {
      await seedHistory();
      const result = await git.execute(['ls-tree', 'HEAD~1'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
    });

    it('ls-tree does not scan the pack indexes for a symbolic ref', async () => {
      await seedHistory();
      const paths = recordPaths();
      expect((await git.execute(['ls-tree', 'HEAD'], '/project')).exitCode).toBe(0);
      expect(paths.filter((p) => p.includes('objects/pack'))).toEqual([]);
    });

    it('revert accepts a relative revision', async () => {
      await seedHistory();
      const result = await git.execute(['revert', '--no-edit', 'HEAD~0'], '/project');
      expect(result.exitCode).toBe(0);
    });

    it('cherry-pick still reports a bad revision for an unknown token', async () => {
      await seedHistory();
      const result = await git.execute(['cherry-pick', 'does-not-exist'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('bad revision');
    });
  });
});
