/**
 * Regression tests for https://github.com/ai-ecoverse/slicc/issues/421 —
 * git commands fail on mounted directories because isomorphic-git was handed
 * raw LightningFS instead of a mount-aware adapter.
 *
 * Mounts an FSA-backed directory and runs a full init → add → commit → log
 * cycle, plus a status check that the pre-adapter code could not satisfy
 * (HEAD was invisible through LightningFS).
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createDirectoryHandle } from '../fs/fsa-test-helpers.js';

let dbCounter = 0;

describe('GitCommands on mounted directories (issue #421)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-mount-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-mount-global-${testId}`,
    });
  });

  async function mountEmpty(path: string): Promise<void> {
    await vfs.mkdir(path, { recursive: true });
    await vfs.mount(path, createDirectoryHandle({}));
  }

  it('git init creates .git/HEAD inside a mounted directory', async () => {
    await mountEmpty('/mnt/repo');

    const result = await git.execute(['init'], '/mnt/repo');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized empty Git repository');

    // The pre-adapter code wrote HEAD to LightningFS but read through VFS,
    // so verifying the file exists via VFS closes the whole loop.
    expect(await vfs.exists('/mnt/repo/.git/HEAD')).toBe(true);
    const head = await vfs.readTextFile('/mnt/repo/.git/HEAD');
    expect(head).toMatch(/^ref: refs\/heads\//);
  });

  it('status reports clean after a commit on a mounted repo', async () => {
    await mountEmpty('/mnt/repo');
    await git.execute(['init'], '/mnt/repo');

    await vfs.writeFile('/mnt/repo/readme.txt', 'mounted hello');
    const add = await git.execute(['add', 'readme.txt'], '/mnt/repo');
    expect(add.exitCode).toBe(0);

    const commit = await git.execute(['commit', '-m', 'first'], '/mnt/repo');
    expect(commit.exitCode).toBe(0);

    const status = await git.execute(['status'], '/mnt/repo');
    expect(status.exitCode).toBe(0);
    // The primary symptom of #421 was "HEAD not found" — surface any such
    // failure clearly before asserting the happy path.
    expect(status.stderr).not.toMatch(/HEAD not found/i);
    expect(status.stdout).toMatch(/nothing to commit|working tree clean/);
  });

  it('log --oneline shows the commit made inside the mount', async () => {
    await mountEmpty('/mnt/repo');
    await git.execute(['init'], '/mnt/repo');
    await vfs.writeFile('/mnt/repo/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/mnt/repo');
    await git.execute(['commit', '-m', 'mounted commit'], '/mnt/repo');

    const log = await git.execute(['log', '--oneline'], '/mnt/repo');
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('mounted commit');
  });

  it('still works on a non-mounted LightningFS-backed repo (no regression)', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/a.txt', 'a');
    await git.execute(['add', 'a.txt'], '/project');
    const commit = await git.execute(['commit', '-m', 'lfs repo'], '/project');
    expect(commit.exitCode).toBe(0);

    const log = await git.execute(['log', '--oneline'], '/project');
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('lfs repo');
  });
});
