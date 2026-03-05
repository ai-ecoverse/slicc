import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../fs/virtual-fs.js';
import { GitCommands } from './git-commands.js';

describe('GitCommands', () => {
  let vfs: VirtualFS;
  let git: GitCommands;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ backend: 'indexeddb', dbName: `git-test-${Date.now()}` });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
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
