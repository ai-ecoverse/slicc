/**
 * #3120 — `git diff` two commits / `--name-status` must not return empty
 * success when the commits differ.
 * #3121 — `-q` must not steal positionals, global options before the
 * subcommand, FETCH_HEAD after fetch, merge state that abort/reset can clear.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

vi.mock('isomorphic-git', async (importOriginal) => ({ ...(await importOriginal()) }));

import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

describe('git issues #3120 and #3121', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let dbCounter = 0;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-3120-3121-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-3120-3121-global-${testId}`,
    });
  });

  async function seedTwoCommits(): Promise<{ a: string; b: string }> {
    await git.execute(['init'], '/project');
    await vfs.writeFile('/project/one.txt', 'one-a\n');
    await vfs.writeFile('/project/two.txt', 'two-a\n');
    await vfs.writeFile('/project/keep.txt', 'same\n');
    await git.execute(['add', '.'], '/project');
    await git.execute(['commit', '-m', 'first'], '/project');
    const a = (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();

    await vfs.writeFile('/project/one.txt', 'one-b\n');
    await vfs.writeFile('/project/two.txt', 'two-b\n');
    await vfs.writeFile('/project/three.txt', 'new\n');
    await git.execute(['add', 'one.txt', 'two.txt', 'three.txt'], '/project');
    await git.execute(['rm', 'keep.txt'], '/project');
    await git.execute(['commit', '-m', 'second'], '/project');
    const b = (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();
    return { a, b };
  }

  describe('#3120 git diff two commits', () => {
    it('reports --name-status between two full SHAs that differ', async () => {
      const { a, b } = await seedTwoCommits();
      expect(a).toHaveLength(40);
      expect(b).toHaveLength(40);

      const result = await git.execute(['diff', '--name-status', a, b], '/project');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).not.toBe('');
      expect(result.stdout).toMatch(/^M\tone\.txt$/m);
      expect(result.stdout).toMatch(/^M\ttwo\.txt$/m);
      expect(result.stdout).toMatch(/^A\tthree\.txt$/m);
      expect(result.stdout).toMatch(/^D\tkeep\.txt$/m);
    });

    it('diffs two full SHAs with --name-only, --stat, and a bare diff', async () => {
      const { a, b } = await seedTwoCommits();

      const nameOnly = await git.execute(['diff', '--name-only', a, b], '/project');
      expect(nameOnly.exitCode).toBe(0);
      expect(nameOnly.stdout).toContain('one.txt');
      expect(nameOnly.stdout).toContain('three.txt');

      const stat = await git.execute(['diff', '--stat', a, b], '/project');
      expect(stat.exitCode).toBe(0);
      expect(stat.stdout).toMatch(/files? changed/);

      const bare = await git.execute(['diff', a, b], '/project');
      expect(bare.exitCode).toBe(0);
      expect(bare.stdout).toContain('diff --git');
      expect(bare.stdout).toContain('-one-a');
      expect(bare.stdout).toContain('+one-b');
    });

    it('accepts HEAD~1 HEAD and A...B', async () => {
      await seedTwoCommits();

      const parents = await git.execute(['diff', '--name-status', 'HEAD~1', 'HEAD'], '/project');
      expect(parents.exitCode).toBe(0);
      expect(parents.stdout.trim()).not.toBe('');
      expect(parents.stdout).toContain('one.txt');

      const threeDot = await git.execute(['diff', '--name-only', 'HEAD~1...HEAD'], '/project');
      expect(threeDot.exitCode).toBe(0);
      expect(threeDot.stdout).toContain('one.txt');
    });

    it('fails loudly when a commit argument cannot be resolved', async () => {
      await seedTwoCommits();
      const missing = await git.execute(
        ['diff', '--name-status', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'HEAD'],
        '/project'
      );
      expect(missing.exitCode).toBe(128);
      expect(missing.stderr).toMatch(/ambiguous argument|Not a valid object|does not exist/i);
      expect(missing.stdout).toBe('');
    });
  });

  describe('#3121 -q, globals, FETCH_HEAD, merge state', () => {
    it('accepts -q on a local clone without stealing the destination', async () => {
      await git.execute(['init'], '/source');
      await vfs.writeFile('/source/readme.txt', 'hello\n');
      await git.execute(['add', 'readme.txt'], '/source');
      await git.execute(['commit', '-m', 'src'], '/source');

      const result = await git.execute(['clone', '-q', '/source', '/copy'], '/');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(await vfs.readTextFile('/copy/readme.txt')).toBe('hello\n');
    });

    it('names an unknown clone flag instead of eating the URL', async () => {
      const result = await git.execute(
        ['clone', '-z', 'https://example.com/repo.git', '/tmp/gt'],
        '/'
      );
      expect(result.exitCode).toBe(129);
      expect(result.stderr).toMatch(/unknown switch `z`/);
    });

    it('keeps fetch -q origin main as remote=origin ref=main and writes FETCH_HEAD', async () => {
      await git.execute(['init'], '/project');
      await git.execute(['remote', 'add', 'origin', 'https://example.com/x.git'], '/project');
      const oid = '5791ce61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
      const fetchSpy = vi.spyOn(isoGit, 'fetch').mockResolvedValue({
        defaultBranch: 'main',
        fetchHead: oid,
        fetchHeadDescription: "branch 'main' of https://example.com/x.git",
        headers: undefined,
        pruned: undefined,
      } as Awaited<ReturnType<typeof isoGit.fetch>>);
      try {
        const result = await git.execute(['fetch', '-q', 'origin', 'main'], '/project');
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('');
        const call = fetchSpy.mock.calls[0]?.[0] as { remote?: string; ref?: string };
        expect(call?.remote).toBe('origin');
        expect(call?.ref).toBe('main');
        expect(await vfs.readTextFile('/project/.git/FETCH_HEAD')).toContain(oid);
        const parsed = await git.execute(['rev-parse', 'FETCH_HEAD'], '/project');
        expect(parsed.exitCode).toBe(0);
        expect(parsed.stdout.trim()).toBe(oid);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('names an unknown fetch flag instead of dropping the remote', async () => {
      await git.execute(['init'], '/project');
      const result = await git.execute(['fetch', '--bogus', 'origin', 'main'], '/project');
      expect(result.exitCode).toBe(129);
      expect(result.stderr).toMatch(/unknown option `bogus`/);
    });

    it('parses git --no-color log as log, not as a missing command', async () => {
      await seedTwoCommits();
      const result = await git.execute(
        ['--no-color', 'log', '-n', '1', '--format', '%h'],
        '/project'
      );
      expect(result.stderr).not.toContain('is not a git command');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it('lets status, merge --abort, and reset --hard agree on merge state', async () => {
      await git.execute(['init'], '/project');
      await vfs.writeFile('/project/file.txt', 'base line\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'base'], '/project');

      await git.execute(['checkout', '-b', 'feature'], '/project');
      await vfs.writeFile('/project/file.txt', 'theirs line\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'feature'], '/project');

      await git.execute(['checkout', 'main'], '/project');
      await vfs.writeFile('/project/file.txt', 'ours line\n');
      await git.execute(['add', 'file.txt'], '/project');
      await git.execute(['commit', '-m', 'main'], '/project');

      const conflicted = await git.execute(['merge', '--no-edit', 'feature'], '/project');
      expect(conflicted.exitCode).toBe(1);
      expect(await vfs.exists('/project/.git/MERGE_HEAD')).toBe(true);

      const status = await git.execute(['status'], '/project');
      expect(status.stdout).toContain('unmerged paths');
      expect(status.stdout).not.toContain('nothing to commit, working tree clean');

      const blocked = await git.execute(['merge', 'feature'], '/project');
      expect(blocked.exitCode).toBe(128);
      expect(blocked.stderr).toContain('MERGE_HEAD exists');

      const abort = await git.execute(['merge', '--abort'], '/project');
      expect(abort.exitCode).toBe(0);
      expect(abort.stderr).not.toContain('No branch specified');
      expect(await vfs.exists('/project/.git/MERGE_HEAD')).toBe(false);
      expect(await vfs.readTextFile('/project/file.txt')).toBe('ours line\n');

      const afterAbort = await git.execute(['status'], '/project');
      expect(afterAbort.stdout).toContain('nothing to commit, working tree clean');
      expect(afterAbort.stdout).not.toContain('unmerged paths');

      const again = await git.execute(['merge', '--no-edit', 'feature'], '/project');
      expect(again.exitCode).toBe(1);
      expect(await vfs.exists('/project/.git/MERGE_HEAD')).toBe(true);

      const reset = await git.execute(['reset', '--hard', 'HEAD'], '/project');
      expect(reset.exitCode).toBe(0);
      expect(await vfs.exists('/project/.git/MERGE_HEAD')).toBe(false);
      const afterReset = await git.execute(['merge', '--no-edit', 'feature'], '/project');
      expect(afterReset.exitCode).toBe(1);
      expect(afterReset.stdout).toContain('CONFLICT');
      expect(afterReset.stderr).not.toContain('unmerged files');
      expect(afterReset.stderr).not.toContain('MERGE_HEAD exists');
    });
  });
});
