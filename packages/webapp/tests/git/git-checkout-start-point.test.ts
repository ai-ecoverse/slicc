/**
 * #2928 — `git checkout -b <new> <start-point>` (and `git checkout <branch>`)
 * must reset the index and working tree to the start-point. isomorphic-git's
 * branch+checkout only moves HEAD, so files from the previous branch used to
 * stay staged and ride along on the next commit.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

describe('git checkout start-point tree (#2928)', () => {
  let git: GitCommands;
  let fs: VirtualFS;
  let id = 0;

  beforeEach(async () => {
    const suffix = id++;
    fs = await VirtualFS.create({ dbName: `git-checkout-sp-${suffix}`, wipe: true });
    git = new GitCommands({
      fs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-checkout-sp-global-${suffix}`,
    });
  });

  /** Issue repro: commit `base.txt` on main, `feature.txt` on feature. */
  async function seedFeatureOffMain(): Promise<void> {
    await git.execute(['init'], '/project');
    await fs.writeFile('/project/base.txt', 'base\n');
    await git.execute(['add', 'base.txt'], '/project');
    await git.execute(['commit', '-m', 'base'], '/project');
    await git.execute(['checkout', '-b', 'feature'], '/project');
    await fs.writeFile('/project/feature.txt', 'f\n');
    await git.execute(['add', 'feature.txt'], '/project');
    await git.execute(['commit', '-m', 'feat'], '/project');
  }

  async function expectCleanMainTree(): Promise<void> {
    const status = await git.execute(['status', '-s'], '/project');
    expect(status.exitCode).toBe(0);
    expect(status.stdout.trim()).toBe('');
    expect(await fs.exists('/project/feature.txt')).toBe(false);
    expect(await fs.readTextFile('/project/base.txt')).toBe('base\n');
    expect((await git.execute(['ls-files'], '/project')).stdout).toBe('base.txt\n');
  }

  /** A commit that stages only `base.txt` must not absorb `feature.txt`. */
  async function expectScopedBaseCommit(): Promise<void> {
    await fs.writeFile('/project/base.txt', 'base\nmore\n');
    await git.execute(['add', 'base.txt'], '/project');
    const commit = await git.execute(['commit', '-m', 'only base.txt'], '/project');
    expect(commit.exitCode).toBe(0);

    const names = (await git.execute(['ls-tree', '-r', '--name-only', 'HEAD'], '/project')).stdout;
    expect(names).toBe('base.txt\n');
    expect(names).not.toContain('feature.txt');

    const show = await git.execute(['show', '--stat', '--format=%s', 'HEAD'], '/project');
    expect(show.stdout).toContain('only base.txt');
    expect(show.stdout).not.toContain('feature.txt');
  }

  it('checkout -b fix main from feature leaves a clean start-point tree', async () => {
    await seedFeatureOffMain();

    const result = await git.execute(['checkout', '-b', 'fix', 'main'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to a new branch 'fix'");
    expect((await git.execute(['branch', '--show-current'], '/project')).stdout.trim()).toBe('fix');

    await expectCleanMainTree();
    await expectScopedBaseCommit();
  });

  it('checkout main from feature leaves a clean start-point tree', async () => {
    await seedFeatureOffMain();

    const result = await git.execute(['checkout', 'main'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to branch 'main'");
    expect((await git.execute(['branch', '--show-current'], '/project')).stdout.trim()).toBe(
      'main'
    );

    await expectCleanMainTree();
    await expectScopedBaseCommit();
  });

  it('checkout to another branch keeps tracked symlinks as links', async () => {
    await git.execute(['init'], '/project');
    await fs.writeFile('/project/data.bin', 'payload\n');
    await fs.symlink('data.bin', '/project/link.bin');
    await git.execute(['add', 'data.bin', 'link.bin'], '/project');
    await git.execute(['commit', '-m', 'main'], '/project');
    await git.execute(['checkout', '-b', 'feature'], '/project');
    await fs.writeFile('/project/extra.txt', 'x\n');
    await git.execute(['add', 'extra.txt'], '/project');
    await git.execute(['commit', '-m', 'feat'], '/project');

    const result = await git.execute(['checkout', 'main'], '/project');
    expect(result.exitCode).toBe(0);
    const st = await fs.lstat('/project/link.bin');
    expect(st.type).toBe('symlink');
    expect(await fs.readlink('/project/link.bin')).toBe('data.bin');
    expect(await fs.exists('/project/extra.txt')).toBe(false);
  });

  it('checkout -b without a start-point keeps uncommitted edits', async () => {
    await git.execute(['init'], '/project');
    await fs.writeFile('/project/base.txt', 'base\n');
    await git.execute(['add', 'base.txt'], '/project');
    await git.execute(['commit', '-m', 'base'], '/project');
    await fs.writeFile('/project/base.txt', 'dirty\n');

    const result = await git.execute(['checkout', '-b', 'topic'], '/project');
    expect(result.exitCode).toBe(0);
    expect(await fs.readTextFile('/project/base.txt')).toBe('dirty\n');
    expect((await git.execute(['status', '-s'], '/project')).stdout).toContain('base.txt');
  });
});
