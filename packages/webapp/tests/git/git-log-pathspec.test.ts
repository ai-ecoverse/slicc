/**
 * `git log -- <pathspec>` regression tests (#2714).
 *
 * The old implementation materialized every commit on the branch, then ran a
 * two-tree `git.walk` per commit through `Promise.all`, and only sliced to
 * `-n` at the end — on a 9.5k-commit branch that crashed the tab. These tests
 * pin both the selection semantics and the fact that the walk stops early.
 */

import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

describe('git log pathspec', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-log-pathspec-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-pathspec-global-${testId}`,
    });
  });

  /** Write `path`, stage everything, and commit with `message`. */
  async function commit(path: string, content: string, message: string): Promise<string> {
    await vfs.writeFile(`/project/${path}`, content);
    // Stage by explicit path: `add .` skips a re-write whose mtime lands in the
    // same millisecond as the indexed one.
    await git.execute(['add', path], '/project');
    await git.execute(['commit', '-m', message], '/project');
    return (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();
  }

  function subjects(stdout: string): string[] {
    return stdout.trim() === '' ? [] : stdout.trim().split('\n');
  }

  async function seed(): Promise<void> {
    await git.execute(['init'], '/project');
    await commit('src/target.ts', 'v1\n', 'c1: add target');
    await commit('docs/readme.md', 'r1\n', 'c2: docs only');
    await commit('src/target.ts', 'v2\n', 'c3: touch target');
    await commit('docs/readme.md', 'r2\n', 'c4: docs only again');
    await commit('src/other.ts', 'o1\n', 'c5: sibling in src');
  }

  it('returns only the commits that touched an exact-file pathspec', async () => {
    await seed();
    const result = await git.execute(
      ['log', '-n', '5', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(subjects(result.stdout)).toEqual(['c3: touch target', 'c1: add target']);
  });

  it('applies -n to matching commits, newest first', async () => {
    await seed();
    const result = await git.execute(
      ['log', '-n', '1', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    expect(subjects(result.stdout)).toEqual(['c3: touch target']);
  });

  it('treats a directory pathspec as a subtree (with or without a trailing slash)', async () => {
    await seed();
    const plain = await git.execute(['log', '--format', '%s', '--', 'src'], '/project');
    const slashed = await git.execute(['log', '--format', '%s', '--', 'src/'], '/project');
    const dotted = await git.execute(['log', '--format', '%s', '--', './src'], '/project');
    expect(subjects(plain.stdout)).toEqual([
      'c5: sibling in src',
      'c3: touch target',
      'c1: add target',
    ]);
    expect(subjects(slashed.stdout)).toEqual(subjects(plain.stdout));
    expect(subjects(dotted.stdout)).toEqual(subjects(plain.stdout));
  });

  it('unions multiple pathspecs', async () => {
    await seed();
    const result = await git.execute(
      ['log', '--format', '%s', '--', 'src/other.ts', 'docs'],
      '/project'
    );
    expect(subjects(result.stdout)).toEqual([
      'c5: sibling in src',
      'c4: docs only again',
      'c2: docs only',
    ]);
  });

  it('returns nothing for a pathspec that never existed', async () => {
    await seed();
    const result = await git.execute(['log', '--format', '%s', '--', 'nope/gone.txt'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('reports the commit that deleted a path', async () => {
    await seed();
    await vfs.rm('/project/src/target.ts');
    await git.execute(['add', '-A', 'src'], '/project');
    await git.execute(['commit', '-m', 'c6: delete target'], '/project');

    const result = await git.execute(['log', '--format', '%s', '--', 'src/target.ts'], '/project');
    expect(subjects(result.stdout)[0]).toBe('c6: delete target');
  });

  it('honors "." as a pathspec that matches every commit', async () => {
    await seed();
    const result = await git.execute(['log', '-n', '2', '--format', '%s', '--', '.'], '/project');
    expect(subjects(result.stdout)).toEqual(['c5: sibling in src', 'c4: docs only again']);
  });

  it('keeps --reverse, --author and --grep working with a pathspec', async () => {
    await seed();
    const reversed = await git.execute(
      ['log', '--reverse', '--format', '%s', '--', 'src'],
      '/project'
    );
    const authored = await git.execute(
      ['log', '--author=Test User', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    const missing = await git.execute(
      ['log', '--author=Nobody', '--format', '%s', '--', 'src'],
      '/project'
    );
    const grepped = await git.execute(
      ['log', '--grep=touch', '--format', '%s', '--', 'src'],
      '/project'
    );
    expect(subjects(reversed.stdout)).toEqual([
      'c1: add target',
      'c3: touch target',
      'c5: sibling in src',
    ]);
    expect(subjects(authored.stdout)).toEqual(['c3: touch target', 'c1: add target']);
    expect(subjects(missing.stdout)).toEqual([]);
    expect(subjects(grepped.stdout)).toEqual(['c3: touch target']);
  });

  it('keeps --stat working with a pathspec', async () => {
    await seed();
    const result = await git.execute(
      ['log', '-n', '1', '--stat', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('c3: touch target');
    expect(result.stdout).toContain('src/target.ts');
    expect(result.stdout).toContain('file changed');
  });

  it('keeps a commit range working with a pathspec', async () => {
    await git.execute(['init'], '/project');
    await commit('src/target.ts', 'v1\n', 'c1: add target');
    const base = await commit('docs/readme.md', 'r1\n', 'c2: docs only');
    await commit('src/target.ts', 'v2\n', 'c3: touch target');
    const head = await commit('docs/readme.md', 'r2\n', 'c4: docs only again');

    const result = await git.execute(
      ['log', '--format', '%s', `${base}..${head}`, '--', 'src'],
      '/project'
    );
    expect(subjects(result.stdout)).toEqual(['c3: touch target']);
  });

  it('keeps --all working with a pathspec', async () => {
    await git.execute(['init'], '/project');
    await commit('src/target.ts', 'v1\n', 'c1: add target');
    await git.execute(['checkout', '-b', 'feature'], '/project');
    await commit('src/target.ts', 'v2\n', 'c2: feature touches target');
    await commit('docs/readme.md', 'r1\n', 'c3: feature docs');
    await git.execute(['checkout', 'main'], '/project');

    const scoped = await git.execute(['log', '--all', '--format', '%s', '--', 'src'], '/project');
    expect(subjects(scoped.stdout)).toEqual(['c2: feature touches target', 'c1: add target']);
  });

  it('keeps --follow working (it does not go through the pathspec path)', async () => {
    await git.execute(['init'], '/project');
    await commit('a.txt', 'a1\n', 'c1: add a');
    await commit('b.txt', 'b1\n', 'c2: add b');
    await commit('a.txt', 'a2\n', 'c3: modify a');

    const result = await git.execute(['log', '--follow', 'a.txt', '--format', '%s'], '/project');
    expect(result.stdout).toContain('c3: modify a');
    expect(result.stdout).not.toContain('c2: add b');
  });

  // Seeding the history is the slow part here (one real commit per iteration),
  // so give it room: CI machines construct these objects several times slower.
  it('orders multiple pathspecs by history, independent of argument order', async () => {
    // Two commits one second APART in history order but written with the SAME
    // author timestamp: unioning per-spec walks and re-sorting by timestamp
    // would fall back to pathspec-argument order here and invert them.
    const lfs = createIsomorphicGitFs(vfs);
    const stamped = async (path: string, content: string, message: string): Promise<void> => {
      await vfs.writeFile(`/project/${path}`, content);
      await git.execute(['add', path], '/project');
      await isoGit.commit({
        fs: lfs,
        dir: '/project',
        message,
        author: { name: 'Test User', email: 'test@example.com', timestamp: 1_700_000_000 },
      });
    };

    await git.execute(['init'], '/project');
    await stamped('base.txt', 'base\n', 'c0: base');
    await stamped('a.txt', 'a\n', 'c1: touches a');
    await stamped('b.txt', 'b\n', 'c2: touches b');

    const ab = await git.execute(['log', '--format', '%s', '--', 'a.txt', 'b.txt'], '/project');
    const ba = await git.execute(['log', '--format', '%s', '--', 'b.txt', 'a.txt'], '/project');
    const cappedAb = await git.execute(
      ['log', '-n', '1', '--format', '%s', '--', 'a.txt', 'b.txt'],
      '/project'
    );
    const cappedBa = await git.execute(
      ['log', '-n', '1', '--format', '%s', '--', 'b.txt', 'a.txt'],
      '/project'
    );

    // Newest first, by history — not by the order the specs were typed.
    expect(subjects(ab.stdout)).toEqual(['c2: touches b', 'c1: touches a']);
    expect(subjects(ba.stdout)).toEqual(subjects(ab.stdout));
    expect(subjects(cappedAb.stdout)).toEqual(['c2: touches b']);
    expect(subjects(cappedBa.stdout)).toEqual(['c2: touches b']);
  });

  it('grows the history window until -n multi-pathspec matches are found', async () => {
    await git.execute(['init'], '/project');
    await commit('a.txt', 'a0\n', 'a 0');
    await commit('b.txt', 'b0\n', 'b 0');
    // Push the matches well past the first (32-commit) window.
    for (let i = 0; i < 40; i++) await commit('noise.txt', `n${i}\n`, `noise ${i}`);

    const result = await git.execute(['log', '--format', '%s', '--', 'a.txt', 'b.txt'], '/project');
    expect(subjects(result.stdout)).toEqual(['b 0', 'a 0']);
  }, 60_000);

  it('stops walking once -n matches are found on a long history (#2714)', {
    timeout: 60_000,
  }, async () => {
    await git.execute(['init'], '/project');
    // 20 commits that never touch the pathspec, then 3 that do at the tip.
    await commit('src/target.ts', 'v0\n', 'seed target');
    for (let i = 0; i < 20; i++) await commit('noise.txt', `n${i}\n`, `noise ${i}`);
    await commit('src/target.ts', 'v1\n', 'target 1');
    await commit('noise.txt', 'between\n', 'noise between');
    await commit('src/target.ts', 'v2\n', 'target 2');

    const count = async (args: string[]): Promise<number> => {
      const spy = vi.spyOn(vfs, 'readFile');
      const result = await git.execute(args, '/project');
      const reads = spy.mock.calls.length;
      spy.mockRestore();
      expect(result.exitCode).toBe(0);
      return reads;
    };

    const boundedReads = await count(['log', '-n', '2', '--format', '%s', '--', 'src/target.ts']);
    const fullReads = await count(['log', '-n', '99', '--format', '%s', '--', 'src/target.ts']);

    // The bounded query must not pay for the 20 commits below the tip.
    expect(boundedReads * 2).toBeLessThan(fullReads);

    const bounded = await git.execute(
      ['log', '-n', '2', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    expect(subjects(bounded.stdout)).toEqual(['target 2', 'target 1']);
  });
});
