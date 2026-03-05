import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../fs/virtual-fs.js';
import { GitCommands } from './git-commands.js';

describe('GitCommands', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let globalDbName: string;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    globalDbName = `git-global-test-${testId}`;
    vfs = await VirtualFS.create({ dbName: `git-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName,
    });
  });

  it('shows help', async () => {
    const result = await git.execute(['help'], '/');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Available commands');
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('commit');
  });

  it('returns error for unknown command', async () => {
    const result = await git.execute(['unknown'], '/');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is not a git command');
  });

  it('initializes a repository', async () => {
    const result = await git.execute(['init'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Initialized empty Git repository');

    // Check that .git directory was created
    const exists = await vfs.exists('/project/.git');
    expect(exists).toBe(true);
  });

  it('shows status after init', async () => {
    await git.execute(['init'], '/project');
    const result = await git.execute(['status'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('On branch main');
  });

  it('adds and commits a file', async () => {
    await git.execute(['init'], '/project');

    // Create a file
    await vfs.writeFile('/project/readme.txt', 'Hello World');

    // Add the file
    const addResult = await git.execute(['add', 'readme.txt'], '/project');
    expect(addResult.exitCode).toBe(0);

    // Commit
    const commitResult = await git.execute(['commit', '-m', 'Initial commit'], '/project');
    expect(commitResult.exitCode).toBe(0);
    expect(commitResult.stdout).toContain('Initial commit');
  });

  it('stages deleted files with git add .', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'Initial'], '/project');

    await vfs.rm('/project/file.txt');
    await git.execute(['add', '.'], '/project');

    const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
    const row = matrix.find((r) => r[0] === 'file.txt');
    expect(row).toBeTruthy();
    expect(row?.slice(1)).toEqual([1, 0, 0]); // staged deletion
  });

  it('shows commit log', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'Test commit'], '/project');

    const result = await git.execute(['log', '--oneline'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Test commit');
  });

  it('creates and lists branches', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'Initial'], '/project');

    // Create a branch
    const createResult = await git.execute(['branch', 'feature'], '/project');
    expect(createResult.exitCode).toBe(0);

    // List branches
    const listResult = await git.execute(['branch'], '/project');
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('main');
    expect(listResult.stdout).toContain('feature');
  });

  it('checks out a branch', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'Initial'], '/project');
    await git.execute(['branch', 'feature'], '/project');

    const result = await git.execute(['checkout', 'feature'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to branch 'feature'");
  });

  it('sets and gets config', async () => {
    await git.execute(['init'], '/project');

    // Set config
    const setResult = await git.execute(['config', 'user.name', 'New User'], '/project');
    expect(setResult.exitCode).toBe(0);

    // Get config
    const getResult = await git.execute(['config', 'user.name'], '/project');
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain('New User');
  });

  it('persists github token in global virtual filesystem', async () => {
    const setResult = await git.execute(['config', 'github.token', 'ghp_test_token'], '/project');
    expect(setResult.exitCode).toBe(0);

    const getResult = await git.execute(['config', 'github.token'], '/project');
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim()).toBe('ghp_test_token');
  });

  it('shares github token across git command instances', async () => {
    await git.execute(['config', 'github.token', 'ghp_shared_token'], '/project');

    const secondFs = await VirtualFS.create({ dbName: `git-test-second-${dbCounter++}`, wipe: true });
    const second = new GitCommands({
      fs: secondFs,
      authorName: 'Another User',
      authorEmail: 'another@example.com',
      globalDbName,
    });

    const getResult = await second.execute(['config', 'github.token'], '/another');
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim()).toBe('ghp_shared_token');
  });

  it('supports --no-single-branch for clone', async () => {
    const cloneSpy = vi.spyOn(isoGit, 'clone').mockResolvedValue();
    const listFilesSpy = vi.spyOn(isoGit, 'listFiles').mockResolvedValue([]);
    try {
      const result = await git.execute(
        ['clone', 'https://github.com/example/repo.git', 'repo', '--no-single-branch'],
        '/workspace',
      );

      expect(result.exitCode).toBe(0);
      expect(cloneSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          singleBranch: false,
        }),
      );
    } finally {
      cloneSpy.mockRestore();
      listFilesSpy.mockRestore();
    }
  });

  it('handles rev-parse', async () => {
    await git.execute(['init'], '/project');

    // Check if inside work tree
    const result = await git.execute(['rev-parse', '--is-inside-work-tree'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('true');
  });

  it('handles rev-parse --show-toplevel', async () => {
    await git.execute(['init'], '/project');

    const result = await git.execute(['rev-parse', '--show-toplevel'], '/project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/project');
  });
});
