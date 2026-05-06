import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
// Wrap isomorphic-git in a mutable object so vi.spyOn can redefine exports.
// The ESM namespace is frozen by spec; spreading importOriginal creates a
// plain object whose properties are configurable.
vi.mock('isomorphic-git', async (importOriginal) => ({ ...(await importOriginal()) }));
import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GLOBAL_FS_DB_NAME } from '../../src/fs/global-db.js';
import { GitCommands } from '../../src/git/git-commands.js';

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

  it('git add . does NOT stage deletions (use -A for that)', async () => {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/file.txt', 'content');
    await git.execute(['add', 'file.txt'], '/project');
    await git.execute(['commit', '-m', 'Initial'], '/project');

    await vfs.rm('/project/file.txt');
    await git.execute(['add', '.'], '/project');

    const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
    const row = matrix.find((r) => r[0] === 'file.txt');
    expect(row).toBeTruthy();
    // git add . should NOT stage deletions — file remains as unstaged deletion
    expect(row?.slice(1)).toEqual([1, 0, 1]); // unstaged deletion
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

    const secondFs = await VirtualFS.create({
      dbName: `git-test-second-${dbCounter++}`,
      wipe: true,
    });
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

  it('picks up github token written by another writer after a git command has run', async () => {
    // Reproduces the bug where the OAuth login provider writes the token to
    // the global VFS but a GitCommands instance whose token-load already ran
    // (and saw no file) keeps a stale "no token" cache and ignores it.
    await git.execute(['init'], '/project');

    // OAuth provider would write here — bypassing setGithubToken on this
    // instance, exactly as github.ts:writeGitToken() does.
    const globalFs = await VirtualFS.create({ dbName: globalDbName });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_post_login_token');

    const getResult = await git.execute(['config', 'github.token'], '/project');
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim()).toBe('ghp_post_login_token');
  });

  it('reads token written via the shared GLOBAL_FS_DB_NAME (writer/reader contract)', async () => {
    // Asserts the wiring: the OAuth provider writes to GLOBAL_FS_DB_NAME, and
    // a GitCommands constructed with no explicit globalDbName must read from
    // the same database. Catches drift between the writer's hardcoded DB and
    // the reader's default.
    const isolatedFs = await VirtualFS.create({
      dbName: `git-test-isolated-${dbCounter++}`,
      wipe: true,
    });
    const defaultGit = new GitCommands({
      fs: isolatedFs,
      authorName: 'Test',
      authorEmail: 'test@example.com',
      // intentionally no globalDbName — exercises the default
    });
    await defaultGit.execute(['init'], '/project');

    const sharedGlobalFs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await sharedGlobalFs.writeFile('/workspace/.git/github-token', 'ghp_via_shared_const');

    const getResult = await defaultGit.execute(['config', 'github.token'], '/project');
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim()).toBe('ghp_via_shared_const');
  });

  it('supports --no-single-branch for clone', async () => {
    const cloneSpy = vi.spyOn(isoGit, 'clone').mockResolvedValue();
    const listFilesSpy = vi.spyOn(isoGit, 'listFiles').mockResolvedValue([]);
    try {
      const result = await git.execute(
        ['clone', 'https://github.com/example/repo.git', 'repo', '--no-single-branch'],
        '/workspace'
      );

      expect(result.exitCode).toBe(0);
      expect(cloneSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          singleBranch: false,
        })
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

  describe('status --short/-s/--porcelain', () => {
    it('shows untracked files with ?? prefix', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/newfile.txt', 'content');

      const result = await git.execute(['status', '--short'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('?? newfile.txt');
    });

    it('shows staged new file with A prefix', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/newfile.txt', 'content');
      await git.execute(['add', 'newfile.txt'], '/project');

      const result = await git.execute(['status', '-s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('A  newfile.txt');
    });

    it('shows unstaged deletion with D in workdir column', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Delete file without staging
      await vfs.rm('/project/file.txt');

      const result = await git.execute(['status', '--short'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(' D file.txt');
    });

    it('shows staged modification with M in index column', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await vfs.writeFile('/project/file.txt', 'modified');
      await git.execute(['add', 'file.txt'], '/project');

      const result = await git.execute(['status', '-s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('M  file.txt');
    });

    it('shows staged deletion with D in index column', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await vfs.rm('/project/file.txt');
      await git.execute(['add', '-A'], '/project');

      const result = await git.execute(['status', '--short'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('D  file.txt');
    });

    it('outputs nothing for clean working tree', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['status', '--porcelain'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('--porcelain output matches --short output', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');

      const shortResult = await git.execute(['status', '--short'], '/project');
      const porcelainResult = await git.execute(['status', '--porcelain'], '/project');
      expect(shortResult.stdout).toBe(porcelainResult.stdout);
    });

    it('shows multiple files with correct codes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/committed.txt', 'original');
      await git.execute(['add', 'committed.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create untracked file
      await vfs.writeFile('/project/untracked.txt', 'new');
      // Stage a new file
      await vfs.writeFile('/project/staged.txt', 'staged');
      await git.execute(['add', 'staged.txt'], '/project');
      // Delete committed file without staging
      await vfs.rm('/project/committed.txt');

      const result = await git.execute(['status', '-s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(' D committed.txt');
      expect(result.stdout).toContain('A  staged.txt');
      expect(result.stdout).toContain('?? untracked.txt');
    });
  });

  describe('diff', () => {
    it('shows unified diff for unstaged changes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'line1\nline2\nline3\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Modify the file
      await vfs.writeFile('/project/file.txt', 'line1\nmodified\nline3\n');

      const result = await git.execute(['diff'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('diff --git a/file.txt b/file.txt');
      expect(result.stdout).toContain('--- a/file.txt');
      expect(result.stdout).toContain('+++ b/file.txt');
      expect(result.stdout).toContain('-line2');
      expect(result.stdout).toContain('+modified');
      expect(result.stdout).toContain('@@');
    });

    it('shows diff for added lines', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'original\nnew line\n');

      const result = await git.execute(['diff'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('+new line');
    });

    it('returns empty output when no changes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['diff'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('shows diff for staged changes with --staged', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'line1\nline2\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'line1\nchanged\n');
      await git.execute(['add', 'file.txt'], '/project');

      const result = await git.execute(['diff', '--staged'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-line2');
      expect(result.stdout).toContain('+changed');
    });

    it('--cached is alias for --staged', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'old\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'new\n');
      await git.execute(['add', 'file.txt'], '/project');

      const result = await git.execute(['diff', '--cached'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-old');
      expect(result.stdout).toContain('+new');
    });

    it('shows only filenames with --name-only', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'a\n');
      await vfs.writeFile('/project/b.txt', 'b\n');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/a.txt', 'modified\n');
      await vfs.writeFile('/project/b.txt', 'modified\n');

      const result = await git.execute(['diff', '--name-only'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
      expect(result.stdout).not.toContain('@@');
      expect(result.stdout).not.toContain('---');
    });

    it('shows statistics with --stat', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'line1\nline2\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'line1\nchanged\nadded\n');

      const result = await git.execute(['diff', '--stat'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('file changed');
      expect(result.stdout).toMatch(/insertion/);
    });

    it('shows diff between two commits', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'version1\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');
      const log1 = await git.execute(['log', '--oneline', '-n', '1'], '/project');
      const sha1 = log1.stdout.split(' ')[0].replace(/\x1b\[[0-9;]*m/g, '');

      await vfs.writeFile('/project/file.txt', 'version2\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');
      const log2 = await git.execute(['log', '--oneline', '-n', '1'], '/project');
      const sha2 = log2.stdout.split(' ')[0].replace(/\x1b\[[0-9;]*m/g, '');

      const result = await git.execute(['diff', sha1, sha2], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-version1');
      expect(result.stdout).toContain('+version2');
    });

    it('uses color in diff output', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'old\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'new\n');

      const result = await git.execute(['diff'], '/project');
      expect(result.exitCode).toBe(0);
      // Should contain ANSI color codes
      expect(result.stdout).toContain('\x1b[31m'); // red for deletions
      expect(result.stdout).toContain('\x1b[32m'); // green for additions
      expect(result.stdout).toContain('\x1b[36m'); // cyan for @@ headers
    });

    it('handles multiple changed files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'a\n');
      await vfs.writeFile('/project/b.txt', 'b\n');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/a.txt', 'A\n');
      await vfs.writeFile('/project/b.txt', 'B\n');

      const result = await git.execute(['diff'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('diff --git a/a.txt b/a.txt');
      expect(result.stdout).toContain('diff --git a/b.txt b/b.txt');
    });
  });

  describe('push -u/--set-upstream', () => {
    it('sets upstream tracking config with -u flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Mock push to avoid real network call
      const pushSpy = vi.spyOn(isoGit, 'push').mockResolvedValue({
        ok: true,
        error: null,
        refs: {},
        headers: {},
      });
      const setConfigSpy = vi.spyOn(isoGit, 'setConfig').mockResolvedValue();

      try {
        const result = await git.execute(['push', '-u', 'origin', 'main'], '/project');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("set up to track remote branch 'main' from 'origin'");

        expect(setConfigSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            path: 'branch.main.remote',
            value: 'origin',
          })
        );
        expect(setConfigSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            path: 'branch.main.merge',
            value: 'refs/heads/main',
          })
        );
      } finally {
        pushSpy.mockRestore();
        setConfigSpy.mockRestore();
      }
    });

    it('sets upstream tracking config with --set-upstream flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const pushSpy = vi.spyOn(isoGit, 'push').mockResolvedValue({
        ok: true,
        error: null,
        refs: {},
        headers: {},
      });
      const setConfigSpy = vi.spyOn(isoGit, 'setConfig').mockResolvedValue();

      try {
        const result = await git.execute(['push', '--set-upstream', 'origin', 'main'], '/project');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('set up to track');

        expect(setConfigSpy).toHaveBeenCalledTimes(2);
      } finally {
        pushSpy.mockRestore();
        setConfigSpy.mockRestore();
      }
    });

    it('does not set upstream without -u flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const pushSpy = vi.spyOn(isoGit, 'push').mockResolvedValue({
        ok: true,
        error: null,
        refs: {},
        headers: {},
      });
      const setConfigSpy = vi.spyOn(isoGit, 'setConfig').mockResolvedValue();

      try {
        const result = await git.execute(['push', 'origin', 'main'], '/project');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).not.toContain('set up to track');
        expect(setConfigSpy).not.toHaveBeenCalled();
      } finally {
        pushSpy.mockRestore();
        setConfigSpy.mockRestore();
      }
    });
  });

  describe('show', () => {
    it('shows HEAD commit by default', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'hello world');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Initial commit'], '/project');

      const result = await git.execute(['show'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('commit ');
      expect(result.stdout).toContain('Author: Test User <test@example.com>');
      expect(result.stdout).toContain('Initial commit');
      expect(result.stdout).toContain('file.txt');
    });

    it('shows specific commit by SHA', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'first');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'First commit'], '/project');

      const logResult = await git.execute(['rev-parse', 'HEAD'], '/project');
      const firstSha = logResult.stdout.trim();

      await vfs.writeFile('/project/file.txt', 'second');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Second commit'], '/project');

      const result = await git.execute(['show', firstSha], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('First commit');
      expect(result.stdout).not.toContain('Second commit');
    });

    it('shows diff for second commit against parent', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'first');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'First'], '/project');

      await vfs.writeFile('/project/file.txt', 'second');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Second'], '/project');

      const result = await git.execute(['show'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Second');
      expect(result.stdout).toContain('diff --git');
      expect(result.stdout).toContain('file.txt');
    });

    it('shows file at commit with <sha>:<path> syntax', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Initial'], '/project');

      const logResult = await git.execute(['rev-parse', 'HEAD'], '/project');
      const sha = logResult.stdout.trim();

      await vfs.writeFile('/project/file.txt', 'modified content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Modified'], '/project');

      const result = await git.execute(['show', `${sha}:file.txt`], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('original content');
    });

    it('supports --stat flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'hello\nworld');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Initial'], '/project');

      const result = await git.execute(['show', '--stat'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('file changed');
      expect(result.stdout).toContain('insertion');
    });

    it('supports --format flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Test message'], '/project');

      const result = await git.execute(['show', '--format', '%h %s %an'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Test message');
      expect(result.stdout).toContain('Test User');
    });

    it('shows diff for initial commit (no parent)', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Initial'], '/project');

      const result = await git.execute(['show'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initial');
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('+');
    });

    it('returns error for invalid ref', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Initial'], '/project');

      const result = await git.execute(['show', 'nonexistent'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('fatal:');
    });
  });

  describe('log flags', () => {
    it('--format supports common placeholders', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'Test message'], '/project');

      const result = await git.execute(['log', '--format', '%h %s %an <%ae>'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Test message');
      expect(result.stdout).toContain('Test User');
      expect(result.stdout).toContain('<test@example.com>');
      // %h should be a 7-char short hash
      const line = result.stdout.trim();
      expect(line.split(' ')[0]).toHaveLength(7);
    });

    it('--format supports %H for full hash', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'msg'], '/project');

      const result = await git.execute(['log', '--format', '%H'], '/project');
      expect(result.exitCode).toBe(0);
      // Full SHA-1 is 40 hex chars
      expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    });

    it('--format supports %ar for relative date', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'msg'], '/project');

      const result = await git.execute(['log', '--format', '%ar'], '/project');
      expect(result.exitCode).toBe(0);
      // Should contain "ago"
      expect(result.stdout).toContain('ago');
    });

    it('--author filters commits by author name', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'by Test User'], '/project');

      const result = await git.execute(['log', '--author=Test User', '--format', '%s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('by Test User');
    });

    it('--author excludes non-matching commits', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'by Test User'], '/project');

      const result = await git.execute(
        ['log', '--author=Nonexistent Author', '--format', '%s'],
        '/project'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('--grep filters commits by message', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'fix: resolve bug'], '/project');

      await vfs.writeFile('/project/file.txt', 'v2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'feat: add feature'], '/project');

      const result = await git.execute(['log', '--grep=fix', '--format', '%s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('fix: resolve bug');
      expect(result.stdout).not.toContain('feat: add feature');
    });

    it('--reverse reverses commit order', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');

      await vfs.writeFile('/project/file.txt', 'v2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      const normal = await git.execute(['log', '--format', '%s'], '/project');
      const reversed = await git.execute(['log', '--reverse', '--format', '%s'], '/project');

      const normalLines = normal.stdout.trim().split('\n');
      const reversedLines = reversed.stdout.trim().split('\n');

      expect(normalLines[0]).toBe('second');
      expect(normalLines[1]).toBe('first');
      expect(reversedLines[0]).toBe('first');
      expect(reversedLines[1]).toBe('second');
    });

    it('--all shows commits from all branches', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'on main'], '/project');

      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/feature.txt', 'feature');
      await git.execute(['add', 'feature.txt'], '/project');
      await git.execute(['commit', '-m', 'on feature'], '/project');

      // Switch back to main
      await git.execute(['checkout', 'main'], '/project');

      // Without --all, should not see feature branch commit
      const normalResult = await git.execute(['log', '--format', '%s'], '/project');
      expect(normalResult.stdout).not.toContain('on feature');

      // With --all, should see both
      const allResult = await git.execute(['log', '--all', '--format', '%s'], '/project');
      expect(allResult.exitCode).toBe(0);
      expect(allResult.stdout).toContain('on main');
      expect(allResult.stdout).toContain('on feature');
    });

    it('--stat shows file change stats', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'line1\nline2\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'line1\nmodified\nadded\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'modify file'], '/project');

      const result = await git.execute(['log', '-n', '1', '--stat', '--format', '%s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('file changed');
    });

    it('--follow shows commits touching a specific file', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'a');
      await vfs.writeFile('/project/b.txt', 'b');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'add both'], '/project');

      await vfs.writeFile('/project/a.txt', 'a modified');
      await git.execute(['add', 'a.txt'], '/project');
      await git.execute(['commit', '-m', 'modify a'], '/project');

      await vfs.writeFile('/project/b.txt', 'b modified');
      await git.execute(['add', 'b.txt'], '/project');
      await git.execute(['commit', '-m', 'modify b'], '/project');

      const result = await git.execute(['log', '--follow', 'a.txt', '--format', '%s'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('modify a');
      // Should not include "modify b" since it only touches b.txt
      expect(result.stdout).not.toContain('modify b');
    });

    it('--format with --stat combines both outputs', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'update'], '/project');

      const result = await git.execute(
        ['log', '-n', '1', '--format', '%h %s', '--stat'],
        '/project'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('update');
      expect(result.stdout).toContain('file.txt');
      expect(result.stdout).toContain('file changed');
    });
  });

  describe('reset', () => {
    it('unstages a specific file', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file1.txt', 'content1');
      await vfs.writeFile('/project/file2.txt', 'content2');
      await git.execute(['add', 'file1.txt'], '/project');
      await git.execute(['add', 'file2.txt'], '/project');

      const result = await git.execute(['reset', 'file1.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const file1 = matrix.find((r) => r[0] === 'file1.txt');
      const file2 = matrix.find((r) => r[0] === 'file2.txt');
      expect(file1?.slice(1)).toEqual([0, 2, 0]);
      expect(file2?.slice(1)).toEqual([0, 2, 2]);
    });

    it('unstages via "git reset HEAD <file>"', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');

      const result = await git.execute(['reset', 'HEAD', 'file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([0, 2, 0]);
    });

    it('unstages all files with no args', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'a');
      await vfs.writeFile('/project/b.txt', 'b');
      await git.execute(['add', 'a.txt'], '/project');
      await git.execute(['add', 'b.txt'], '/project');

      const result = await git.execute(['reset'], '/project');
      expect(result.exitCode).toBe(0);

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      for (const [, , , stage] of matrix) {
        expect(stage).toBe(0);
      }
    });

    it('--soft moves HEAD but keeps changes staged', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');

      const firstCommit = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });

      await vfs.writeFile('/project/file.txt', 'v2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      const result = await git.execute(['reset', '--soft', firstCommit], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('HEAD is now at');

      const headOid = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });
      expect(headOid).toBe(firstCommit);

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('v2');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 2, 2]);
    });

    it('--mixed moves HEAD and unstages changes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');

      const firstCommit = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });

      await vfs.writeFile('/project/file.txt', 'v2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      const result = await git.execute(['reset', '--mixed', firstCommit], '/project');
      expect(result.exitCode).toBe(0);

      const headOid = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });
      expect(headOid).toBe(firstCommit);

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('v2');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 2, 1]);
    });

    it('--hard moves HEAD and restores workdir', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');

      const firstCommit = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });

      await vfs.writeFile('/project/file.txt', 'v2');
      await vfs.writeFile('/project/extra.txt', 'extra');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      const result = await git.execute(['reset', '--hard', firstCommit], '/project');
      expect(result.exitCode).toBe(0);

      const headOid = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });
      expect(headOid).toBe(firstCommit);

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('v1');

      const exists = await vfs.exists('/project/extra.txt');
      expect(exists).toBe(false);

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      for (const [, head, workdir, stage] of matrix) {
        expect(head).toBe(1);
        expect(workdir).toBe(stage);
      }
    });
  });

  describe('merge', () => {
    it('fast-forwards when possible', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create a feature branch and add a commit
      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/feature.txt', 'feature work');
      await git.execute(['add', 'feature.txt'], '/project');
      await git.execute(['commit', '-m', 'feature commit'], '/project');

      // Go back to main and merge feature
      await git.execute(['checkout', 'main'], '/project');
      const result = await git.execute(['merge', 'feature'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Fast-forward');

      // Verify the feature file is now in the working directory
      const content = await vfs.readTextFile('/project/feature.txt');
      expect(content).toBe('feature work');
    });

    it('creates merge commit with --no-ff', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create a feature branch and add a commit
      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/feature.txt', 'feature work');
      await git.execute(['add', 'feature.txt'], '/project');
      await git.execute(['commit', '-m', 'feature commit'], '/project');

      // Go back to main and merge with --no-ff
      await git.execute(['checkout', 'main'], '/project');
      const result = await git.execute(['merge', '--no-ff', 'feature'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Merge made');

      // Verify the feature file is present
      const content = await vfs.readTextFile('/project/feature.txt');
      expect(content).toBe('feature work');

      // Verify the merge commit has two parents
      const logs = await isoGit.log({ fs: vfs.getLightningFS(), dir: '/project', depth: 1 });
      expect(logs[0].commit.parent.length).toBe(2);
    });

    it('reports already up to date', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Merge main into itself
      const result = await git.execute(['merge', 'main'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Already up to date');
    });

    it('detects merge conflicts', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial content\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create feature branch with conflicting change
      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/file.txt', 'feature change\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'feature change'], '/project');

      // Go back to main and make a conflicting change
      await git.execute(['checkout', 'main'], '/project');
      await vfs.writeFile('/project/file.txt', 'main change\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'main change'], '/project');

      // Merge should detect conflict
      const result = await git.execute(['merge', 'feature'], '/project');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('conflict');
    });

    it('returns error when no branch specified', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['merge'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('No branch specified');
    });

    it('fails with --ff-only when fast-forward not possible', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'initial\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create diverging branches
      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/feature.txt', 'feature');
      await git.execute(['add', 'feature.txt'], '/project');
      await git.execute(['commit', '-m', 'feature'], '/project');

      await git.execute(['checkout', 'main'], '/project');
      await vfs.writeFile('/project/main.txt', 'main');
      await git.execute(['add', 'main.txt'], '/project');
      await git.execute(['commit', '-m', 'main diverge'], '/project');

      // --ff-only should fail since branches diverged
      const result = await git.execute(['merge', '--ff-only', 'feature'], '/project');
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('add -A/--all', () => {
    it('stages all changes including new and deleted files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/tracked.txt', 'original content here');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create new file, modify tracked (different length to avoid stat cache)
      await vfs.writeFile('/project/newfile.txt', 'new');
      await vfs.writeFile('/project/tracked.txt', 'modified');

      await git.execute(['add', '-A'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const newRow = matrix.find((r) => r[0] === 'newfile.txt');
      const trackedRow = matrix.find((r) => r[0] === 'tracked.txt');
      expect(newRow?.slice(1)).toEqual([0, 2, 2]); // new file staged
      expect(trackedRow?.slice(1)).toEqual([1, 2, 2]); // modified staged
    });

    it('stages deletions with -A flag', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.rm('/project/file.txt');
      await git.execute(['add', '--all'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 0, 0]); // staged deletion
    });
  });

  describe('add -u/--update', () => {
    it('stages modifications of tracked files but not new files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/tracked.txt', 'original content');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Modify tracked file and create new file (different length to trigger stat change)
      await vfs.writeFile('/project/tracked.txt', 'modified');
      await vfs.writeFile('/project/untracked.txt', 'new');

      await git.execute(['add', '-u'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const trackedRow = matrix.find((r) => r[0] === 'tracked.txt');
      const untrackedRow = matrix.find((r) => r[0] === 'untracked.txt');
      expect(trackedRow?.slice(1)).toEqual([1, 2, 2]); // modification staged
      expect(untrackedRow?.slice(1)).toEqual([0, 2, 0]); // still untracked
    });

    it('stages deletions of tracked files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.rm('/project/file.txt');
      await git.execute(['add', '--update'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 0, 0]); // staged deletion
    });
  });

  describe('commit -a/--all', () => {
    it('auto-stages tracked modified files before committing', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Modify without staging (different length to trigger stat change)
      await vfs.writeFile('/project/file.txt', 'modified');

      const result = await git.execute(['commit', '-a', '-m', 'auto-staged'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('auto-staged');

      // Verify file is committed
      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 1, 1]); // clean
    });

    it('handles combined -am "message" form', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified');

      const result = await git.execute(['commit', '-am', 'combined flag'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('combined flag');
    });

    it('does not stage untracked files with -a', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/tracked.txt', 'original content');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create new untracked file and modify tracked file (different length to trigger stat change)
      await vfs.writeFile('/project/untracked.txt', 'new');
      await vfs.writeFile('/project/tracked.txt', 'modified');

      const result = await git.execute(['commit', '-a', '-m', 'auto commit'], '/project');
      expect(result.exitCode).toBe(0);

      // Untracked file should still be untracked
      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const untrackedRow = matrix.find((r) => r[0] === 'untracked.txt');
      expect(untrackedRow?.slice(1)).toEqual([0, 2, 0]);
    });
  });

  describe('commit --allow-empty', () => {
    it('allows creating a commit with no changes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // No changes - should succeed with --allow-empty
      const result = await git.execute(
        ['commit', '--allow-empty', '-m', 'empty commit'],
        '/project'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('empty commit');
    });

    it('errors on empty commit without --allow-empty', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // No changes - should fail without --allow-empty
      const result = await git.execute(['commit', '-m', 'should fail'], '/project');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('nothing to commit');
    });
  });

  describe('checkout -- <file> (file restoration)', () => {
    it('restores a file from HEAD', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Modify the file
      await vfs.writeFile('/project/file.txt', 'modified');

      // Restore from HEAD
      const result = await git.execute(['checkout', '--', 'file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('original');
    });

    it('restores a file from a specific commit', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'version1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'v1'], '/project');

      const v1sha = (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();

      await vfs.writeFile('/project/file.txt', 'version2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'v2'], '/project');

      // Restore from v1
      const result = await git.execute(['checkout', v1sha, '--', 'file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('version1');
    });

    it('does not break regular branch checkout', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['branch', 'feature'], '/project');

      const result = await git.execute(['checkout', 'feature'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Switched to branch 'feature'");
    });

    it('restores multiple files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'original-a');
      await vfs.writeFile('/project/b.txt', 'original-b');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/a.txt', 'modified-a');
      await vfs.writeFile('/project/b.txt', 'modified-b');

      const result = await git.execute(['checkout', '--', 'a.txt', 'b.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const contentA = await vfs.readTextFile('/project/a.txt');
      const contentB = await vfs.readTextFile('/project/b.txt');
      expect(contentA).toBe('original-a');
      expect(contentB).toBe('original-b');
    });
  });

  describe('stash', () => {
    it('stashes dirty changes and cleans workdir', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified');

      const result = await git.execute(['stash'], '/project');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Saved working directory');
      expect(result.stdout).toContain('WIP on main');

      // Workdir should be clean
      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('original');
    });

    it('stash pop restores changes', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified');
      await git.execute(['stash'], '/project');

      const popResult = await git.execute(['stash', 'pop'], '/project');
      expect(popResult.exitCode).toBe(0);
      expect(popResult.stdout).toContain('Dropped refs/stash@{0}');

      const content = await vfs.readTextFile('/project/file.txt');
      expect(content).toBe('modified');
    });

    it('stash list shows stash entries', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'change1');
      await git.execute(['stash'], '/project');

      await vfs.writeFile('/project/file.txt', 'change2');
      await git.execute(['stash'], '/project');

      const listResult = await git.execute(['stash', 'list'], '/project');
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('stash@{0}');
      expect(listResult.stdout).toContain('stash@{1}');
    });

    it('stash drop removes top stash', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'change1');
      await git.execute(['stash'], '/project');

      const dropResult = await git.execute(['stash', 'drop'], '/project');
      expect(dropResult.exitCode).toBe(0);
      expect(dropResult.stdout).toContain('Dropped refs/stash@{0}');

      // Stash list should be empty
      const listResult = await git.execute(['stash', 'list'], '/project');
      expect(listResult.stdout).toBe('');
    });

    it('stash show shows changed files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified');
      await git.execute(['stash'], '/project');

      const showResult = await git.execute(['stash', 'show'], '/project');
      expect(showResult.exitCode).toBe(0);
      expect(showResult.stdout).toContain('file.txt');
    });

    it('returns error when no changes to stash', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['stash'], '/project');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No local changes');
    });

    it('stash pop with no stash returns error', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['stash', 'pop'], '/project');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No stash entries');
    });

    it('stashes new files and removes them from workdir', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create a new untracked file
      await vfs.writeFile('/project/newfile.txt', 'new content');
      await git.execute(['add', 'newfile.txt'], '/project');

      const result = await git.execute(['stash'], '/project');
      expect(result.exitCode).toBe(0);

      // New file should be gone from workdir
      const exists = await vfs.exists('/project/newfile.txt');
      expect(exists).toBe(false);

      // Pop should restore it
      await git.execute(['stash', 'pop'], '/project');
      const content = await vfs.readTextFile('/project/newfile.txt');
      expect(content).toBe('new content');
    });
  });

  describe('rm', () => {
    it('removes file from workdir and stages deletion', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['rm', 'file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      // File should be gone from workdir
      const exists = await vfs.exists('/project/file.txt');
      expect(exists).toBe(false);

      // Deletion should be staged
      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 0, 0]);
    });

    it('--cached removes from index only, keeps workdir copy', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['rm', '--cached', 'file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      // File should still exist in workdir
      const exists = await vfs.exists('/project/file.txt');
      expect(exists).toBe(true);

      // Should be removed from index (shows as untracked)
      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      // After removing from index: head=1, workdir=2, stage=0
      expect(row).toBeTruthy();
    });

    it('returns error without -r for directories', async () => {
      await git.execute(['init'], '/project');
      await vfs.mkdir('/project/subdir', { recursive: true });
      await vfs.writeFile('/project/subdir/file.txt', 'content');
      await git.execute(['add', 'subdir/file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['rm', 'subdir'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('not removing');
      expect(result.stderr).toContain('without -r');
    });

    it('-r removes directory contents recursively', async () => {
      await git.execute(['init'], '/project');
      await vfs.mkdir('/project/subdir', { recursive: true });
      await vfs.writeFile('/project/subdir/a.txt', 'a');
      await vfs.writeFile('/project/subdir/b.txt', 'b');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['rm', '-r', 'subdir'], '/project');
      expect(result.exitCode).toBe(0);

      // Files should be gone from workdir
      const existsA = await vfs.exists('/project/subdir/a.txt');
      const existsB = await vfs.exists('/project/subdir/b.txt');
      expect(existsA).toBe(false);
      expect(existsB).toBe(false);
    });

    it('returns error when no pathspec given', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['rm'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('No pathspec');
    });
  });

  describe('mv', () => {
    it('moves file and stages both operations', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/old.txt', 'content');
      await git.execute(['add', 'old.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['mv', 'old.txt', 'new.txt'], '/project');
      expect(result.exitCode).toBe(0);

      // Old file should be gone
      const existsOld = await vfs.exists('/project/old.txt');
      expect(existsOld).toBe(false);

      // New file should exist with same content
      const content = await vfs.readTextFile('/project/new.txt');
      expect(content).toBe('content');

      // Status should show rename as deletion + addition
      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const oldRow = matrix.find((r) => r[0] === 'old.txt');
      const newRow = matrix.find((r) => r[0] === 'new.txt');
      expect(oldRow?.slice(1)).toEqual([1, 0, 0]); // staged deletion
      expect(newRow?.slice(1)).toEqual([0, 2, 2]); // staged addition
    });

    it('returns error for missing source', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['mv', 'nonexistent.txt', 'dst.txt'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('bad source');
    });

    it('returns error with too few args', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['mv', 'only-one-arg.txt'], '/project');
      expect(result.exitCode).toBe(128);
      expect(result.stderr).toContain('usage');
    });

    it('moves file to a subdirectory', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.mkdir('/project/subdir', { recursive: true });
      const result = await git.execute(['mv', 'file.txt', 'subdir/file.txt'], '/project');
      expect(result.exitCode).toBe(0);

      const exists = await vfs.exists('/project/subdir/file.txt');
      expect(exists).toBe(true);
      const content = await vfs.readTextFile('/project/subdir/file.txt');
      expect(content).toBe('content');
    });
  });

  describe('tag', () => {
    it('lists tags (empty)', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['tag'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('creates a lightweight tag and lists it', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const createResult = await git.execute(['tag', 'v1.0'], '/project');
      expect(createResult.exitCode).toBe(0);

      const listResult = await git.execute(['tag'], '/project');
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('v1.0');
    });

    it('creates an annotated tag with -a -m', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['tag', '-a', 'v2.0', '-m', 'Release v2.0'], '/project');
      expect(result.exitCode).toBe(0);

      const listResult = await git.execute(['tag'], '/project');
      expect(listResult.stdout).toContain('v2.0');
    });

    it('creates a tag at a specific commit', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'v1');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');
      const firstSha = (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();

      await vfs.writeFile('/project/file.txt', 'v2');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      const result = await git.execute(['tag', 'old-tag', firstSha], '/project');
      expect(result.exitCode).toBe(0);

      // Tag should resolve to the first commit
      const tagOid = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'old-tag',
      });
      expect(tagOid).toBe(firstSha);
    });

    it('deletes a tag with -d', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['tag', 'temp'], '/project');

      const deleteResult = await git.execute(['tag', '-d', 'temp'], '/project');
      expect(deleteResult.exitCode).toBe(0);
      expect(deleteResult.stdout).toContain("Deleted tag 'temp'");

      const listResult = await git.execute(['tag'], '/project');
      expect(listResult.stdout).not.toContain('temp');
    });

    it('lists tags matching a pattern with -l', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await git.execute(['tag', 'v1.0'], '/project');
      await git.execute(['tag', 'v2.0'], '/project');
      await git.execute(['tag', 'release-1'], '/project');

      const result = await git.execute(['tag', '-l', 'v*'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('v1.0');
      expect(result.stdout).toContain('v2.0');
      expect(result.stdout).not.toContain('release-1');
    });
  });

  describe('ls-files', () => {
    it('lists tracked files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/a.txt', 'a');
      await vfs.writeFile('/project/b.txt', 'b');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const result = await git.execute(['ls-files'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('a.txt');
      expect(result.stdout).toContain('b.txt');
    });

    it('--cached lists tracked files (same as default)', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      const defaultResult = await git.execute(['ls-files'], '/project');
      const cachedResult = await git.execute(['ls-files', '--cached'], '/project');
      expect(defaultResult.stdout).toBe(cachedResult.stdout);
    });

    it('--others lists untracked files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/committed.txt', 'tracked');
      await git.execute(['add', 'committed.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/newfile.txt', 'untracked');

      const result = await git.execute(['ls-files', '--others'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('newfile.txt');
      expect(result.stdout).not.toContain('committed.txt');
    });

    it('--deleted lists deleted files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.rm('/project/file.txt');

      const result = await git.execute(['ls-files', '--deleted'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('file.txt');
    });

    it('does not list untracked files in default mode', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/tracked.txt', 'content');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/untracked.txt', 'new');

      const result = await git.execute(['ls-files'], '/project');
      expect(result.stdout).toContain('tracked.txt');
      expect(result.stdout).not.toContain('untracked.txt');
    });
  });

  describe('show-ref', () => {
    it('lists all refs (branches and tags)', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['tag', 'v1.0'], '/project');
      await git.execute(['branch', 'feature'], '/project');

      const result = await git.execute(['show-ref'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('refs/heads/main');
      expect(result.stdout).toContain('refs/heads/feature');
      expect(result.stdout).toContain('refs/tags/v1.0');
      // Each line should start with a 40-char OID
      const lines = result.stdout.trim().split('\n');
      for (const line of lines) {
        expect(line).toMatch(/^[0-9a-f]{40} refs\//);
      }
    });

    it('--heads shows only branches', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['tag', 'v1.0'], '/project');

      const result = await git.execute(['show-ref', '--heads'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('refs/heads/main');
      expect(result.stdout).not.toContain('refs/tags/');
    });

    it('--tags shows only tags', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['tag', 'v1.0'], '/project');

      const result = await git.execute(['show-ref', '--tags'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('refs/tags/v1.0');
      expect(result.stdout).not.toContain('refs/heads/');
    });

    it('filters refs by pattern', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      await git.execute(['tag', 'v1.0'], '/project');
      await git.execute(['branch', 'feature'], '/project');

      const result = await git.execute(['show-ref', 'tags'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('refs/tags/v1.0');
      expect(result.stdout).not.toContain('refs/heads/');
    });
  });

  describe('config enhancements', () => {
    it('--list shows all config entries', async () => {
      await git.execute(['init'], '/project');
      await git.execute(['config', 'user.name', 'Test User'], '/project');
      await git.execute(['config', 'user.email', 'test@example.com'], '/project');

      const result = await git.execute(['config', '--list'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('user.name=Test User');
      expect(result.stdout).toContain('user.email=test@example.com');
    });

    it('--unset removes a config entry', async () => {
      await git.execute(['init'], '/project');
      await git.execute(['config', 'user.name', 'Test User'], '/project');

      const unsetResult = await git.execute(['config', '--unset', 'user.name'], '/project');
      expect(unsetResult.exitCode).toBe(0);

      // Value should no longer be found in the config file
      const listResult = await git.execute(['config', '--list'], '/project');
      expect(listResult.stdout).not.toContain('user.name=Test User');
    });

    it('--global sets and gets config from global store', async () => {
      await git.execute(['init'], '/project');

      const setResult = await git.execute(
        ['config', '--global', 'user.name', 'Global User'],
        '/project'
      );
      expect(setResult.exitCode).toBe(0);

      const getResult = await git.execute(['config', '--global', 'user.name'], '/project');
      expect(getResult.exitCode).toBe(0);
      expect(getResult.stdout.trim()).toBe('Global User');
    });

    it('--global --list shows global config', async () => {
      await git.execute(['init'], '/project');
      await git.execute(['config', '--global', 'core.editor', 'vim'], '/project');

      const result = await git.execute(['config', '--global', '--list'], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('core.editor=vim');
    });

    it('--unset with github.token clears the token', async () => {
      await git.execute(['config', 'github.token', 'ghp_test'], '/project');
      const getResult1 = await git.execute(['config', 'github.token'], '/project');
      expect(getResult1.stdout.trim()).toBe('ghp_test');

      await git.execute(['config', '--unset', 'github.token'], '/project');
      const getResult2 = await git.execute(['config', 'github.token'], '/project');
      expect(getResult2.exitCode).toBe(1);
    });

    it('returns usage hint when no key provided', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['config'], '/project');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('usage');
    });

    it('--global get does not read repo config', async () => {
      await git.execute(['init'], '/project');
      // Set a value in repo config only
      await git.execute(['config', 'user.name', 'Repo User'], '/project');

      // --global get should NOT find repo-level config
      const result = await git.execute(['config', '--global', 'user.name'], '/project');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
    });
  });

  describe('PR review fixes', () => {
    it('#1: reset --hard preserves untracked files', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/tracked.txt', 'v1');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'first'], '/project');

      const firstCommit = await isoGit.resolveRef({
        fs: vfs.getLightningFS(),
        dir: '/project',
        ref: 'HEAD',
      });

      await vfs.writeFile('/project/tracked.txt', 'v2');
      await git.execute(['add', 'tracked.txt'], '/project');
      await git.execute(['commit', '-m', 'second'], '/project');

      // Create an untracked file
      await vfs.writeFile('/project/untracked.txt', 'should survive');

      await git.execute(['reset', '--hard', firstCommit], '/project');

      // Untracked file should still exist
      const exists = await vfs.exists('/project/untracked.txt');
      expect(exists).toBe(true);
      const content = await vfs.readTextFile('/project/untracked.txt');
      expect(content).toBe('should survive');

      // Tracked file should be reverted
      const trackedContent = await vfs.readTextFile('/project/tracked.txt');
      expect(trackedContent).toBe('v1');
    });

    it('#2: stash drop removes deep stash entries correctly', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Create 3 stash entries
      await vfs.writeFile('/project/file.txt', 'change1');
      await git.execute(['stash'], '/project');

      await vfs.writeFile('/project/file.txt', 'change2');
      await git.execute(['stash'], '/project');

      await vfs.writeFile('/project/file.txt', 'change3');
      await git.execute(['stash'], '/project');

      // Verify we have 3 stash entries
      const listBefore = await git.execute(['stash', 'list'], '/project');
      expect(listBefore.stdout).toContain('stash@{0}');
      expect(listBefore.stdout).toContain('stash@{1}');
      expect(listBefore.stdout).toContain('stash@{2}');

      // Drop the middle entry (stash@{1})
      const dropResult = await git.execute(['stash', 'drop', 'stash@{1}'], '/project');
      expect(dropResult.exitCode).toBe(0);

      // Should now have only 2 entries
      const listAfter = await git.execute(['stash', 'list'], '/project');
      const lines = listAfter.stdout.trim().split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
    });

    it('#3: default diff shows only unstaged changes (index vs workdir)', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'line1\nline2\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Stage a change
      await vfs.writeFile('/project/file.txt', 'line1\nstaged-change\n');
      await git.execute(['add', 'file.txt'], '/project');

      // Default diff should show nothing (workdir matches index)
      const result1 = await git.execute(['diff'], '/project');
      expect(result1.stdout).toBe('');

      // Make another change without staging
      await vfs.writeFile('/project/file.txt', 'line1\nstaged-change\nunstaged-line\n');

      // Default diff should show only the unstaged change
      const result2 = await git.execute(['diff'], '/project');
      expect(result2.stdout).toContain('+unstaged-line');
      expect(result2.stdout).not.toContain('+staged-change');

      // --staged should show the staged change
      const result3 = await git.execute(['diff', '--staged'], '/project');
      expect(result3.stdout).toContain('+staged-change');
      expect(result3.stdout).not.toContain('+unstaged-line');
    });

    it('#4: expandCombinedFlags preserves -m=msg style args', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'original content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.writeFile('/project/file.txt', 'modified');
      await git.execute(['add', 'file.txt'], '/project');

      // Use -m=message syntax
      const result = await git.execute(['commit', '-m=inline message'], '/project');
      // The parseArg method handles --flag=value for long flags.
      // For short flags, -m=inline message should be left as-is by expandCombinedFlags
      // and then handled by parseArg's = handling
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('inline message');
    });

    it('#7: git show resolves short OIDs', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'First commit'], '/project');

      const logResult = await git.execute(['rev-parse', 'HEAD'], '/project');
      const fullSha = logResult.stdout.trim();
      const shortSha = fullSha.slice(0, 7);

      const result = await git.execute(['show', shortSha], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('First commit');
      expect(result.stdout).toContain(`commit ${fullSha}`);
    });

    it('#8: git add . does not stage deletions', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/keep.txt', 'keep');
      await vfs.writeFile('/project/delete-me.txt', 'will be deleted');
      await git.execute(['add', '.'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      // Delete a file and create a new one
      await vfs.rm('/project/delete-me.txt');
      await vfs.writeFile('/project/new.txt', 'new file');

      // git add . should stage the new file but NOT the deletion
      await git.execute(['add', '.'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const deletedRow = matrix.find((r) => r[0] === 'delete-me.txt');
      const newRow = matrix.find((r) => r[0] === 'new.txt');

      // Deletion should NOT be staged (still shows as unstaged deletion)
      expect(deletedRow?.slice(1)).toEqual([1, 0, 1]);
      // New file should be staged
      expect(newRow?.slice(1)).toEqual([0, 2, 2]);
    });

    it('#8: git add -A DOES stage deletions', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'content');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');

      await vfs.rm('/project/file.txt');
      await git.execute(['add', '-A'], '/project');

      const matrix = await isoGit.statusMatrix({ fs: vfs.getLightningFS(), dir: '/project' });
      const row = matrix.find((r) => r[0] === 'file.txt');
      expect(row?.slice(1)).toEqual([1, 0, 0]); // staged deletion
    });
  });

  describe('author identity resolution', () => {
    /**
     * Reads the author from the most recent commit using isomorphic-git's
     * own log API. We assert against this rather than parsing `git log`
     * output to keep the test independent of formatting changes.
     */
    async function readLatestAuthor(
      cwd: string
    ): Promise<{ name: string; email: string } | undefined> {
      const log = await isoGit.log({ fs: vfs.getLightningFS(), dir: cwd, depth: 1 });
      const entry = log[0];
      return entry
        ? { name: entry.commit.author.name, email: entry.commit.author.email }
        : undefined;
    }

    it('uses constructor defaults when no config is set', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'hello');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      expect(await readLatestAuthor('/project')).toEqual({
        name: 'Test User',
        email: 'test@example.com',
      });
    });

    it('uses values written directly to /workspace/.gitconfig (OAuth provider path)', async () => {
      // Simulate what syncGitIdentityFromGitHub does: write directly to the
      // global config without going through `git config --global` on this
      // GitCommands instance. Without a per-command resolveAuthor read, the
      // commit would still be attributed to the constructor defaults.
      await git.execute(['init'], '/project');
      const globalFs = await VirtualFS.create({ dbName: globalDbName });
      await globalFs.writeFile(
        '/workspace/.gitconfig',
        '[user]\n\tname = Octocat\n\temail = 1+octocat@users.noreply.github.com\n'
      );
      await vfs.writeFile('/project/file.txt', 'hello');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      expect(await readLatestAuthor('/project')).toEqual({
        name: 'Octocat',
        email: '1+octocat@users.noreply.github.com',
      });
    });

    it('prefers local repo config over global config', async () => {
      await git.execute(['init'], '/project');
      const globalFs = await VirtualFS.create({ dbName: globalDbName });
      await globalFs.writeFile(
        '/workspace/.gitconfig',
        '[user]\n\tname = Global User\n\temail = global@example.com\n'
      );
      await git.execute(['config', 'user.name', 'Repo User'], '/project');
      await git.execute(['config', 'user.email', 'repo@example.com'], '/project');
      await vfs.writeFile('/project/file.txt', 'hello');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'initial'], '/project');
      expect(await readLatestAuthor('/project')).toEqual({
        name: 'Repo User',
        email: 'repo@example.com',
      });
    });
  });
});

// Regression for issue #507: git ops in a scoop sandbox failed because
// `RestrictedFS` (which scoops pass to `WasmShell`/`GitCommands`) was
// missing `isPathUnderMount`. Exercising every basic git op through a
// `RestrictedFS` confirms the adapter no longer crashes on the missing
// method.
describe('GitCommands with RestrictedFS (scoop sandbox, issue #507)', () => {
  // Generate unique DB names per run to avoid leaking the cached
  // `globalFsByDbName` entry across tests / watch-mode reruns. Mirrors
  // the `dbCounter` pattern used by the main `GitCommands` suite above.
  let dbCounter = 0;

  it('runs init/status/add/commit through a RestrictedFS without "isPathUnderMount is not a function"', async () => {
    const { RestrictedFS } = await import('../../src/fs/restricted-fs.js');
    const testId = dbCounter++;
    const vfs = await VirtualFS.create({ dbName: `git-restricted-fs-507-${testId}`, wipe: true });
    await vfs.mkdir('/scoops/regression-507', { recursive: true });
    const restricted = new RestrictedFS(vfs, ['/scoops/regression-507/', '/shared/']);
    // The cone's WasmShell does the same cast — we mirror it here so
    // the test reproduces the exact runtime configuration that crashed.
    const git = new GitCommands({
      fs: restricted as unknown as VirtualFS,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-restricted-fs-global-507-${testId}`,
    });

    const initResult = await git.execute(['init'], '/scoops/regression-507');
    expect(initResult.exitCode).toBe(0);
    expect(initResult.stdout).toContain('Initialized empty Git repository');

    // `status` exercises a different isomorphic-git code path than
    // `init` — it walks the working tree via the fs adapter, which is
    // exactly where `isPathUnderMount` is invoked per file. Run it
    // explicitly so the regression covers that path too.
    const statusResult = await git.execute(['status'], '/scoops/regression-507');
    expect(statusResult.exitCode).toBe(0);
    expect(statusResult.stdout).toContain('On branch');

    await restricted.writeFile('/scoops/regression-507/readme.txt', 'hello scoop');
    const addResult = await git.execute(['add', 'readme.txt'], '/scoops/regression-507');
    expect(addResult.exitCode).toBe(0);

    const commitResult = await git.execute(['commit', '-m', 'initial'], '/scoops/regression-507');
    expect(commitResult.exitCode).toBe(0);
    expect(commitResult.stdout).toContain('initial');
  });
});
