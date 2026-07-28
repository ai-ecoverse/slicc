import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('isomorphic-git', async (importOriginal) => ({ ...(await importOriginal()) }));

import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

describe('git command safety and remote inspection', () => {
  let commands: GitCommands;
  let fs: VirtualFS;
  let testId = 0;

  beforeEach(async () => {
    const id = testId++;
    fs = await VirtualFS.create({ dbName: `git-issue-1728-${id}`, wipe: true });
    commands = new GitCommands({ fs, globalDbName: `git-issue-1728-global-${id}` });
  });

  it('uses 127 for an unknown subcommand so it cannot masquerade as boolean false', async () => {
    const result = await commands.execute(['definitely-not-implemented'], '/project');

    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('is not a git command');
  });

  it('computes a merge base and distinguishes true from false ancestry', async () => {
    await commands.execute(['init'], '/project');
    await fs.writeFile('/project/base.txt', 'base\n');
    await commands.execute(['add', 'base.txt'], '/project');
    await commands.execute(['commit', '-m', 'base'], '/project');
    const base = (await commands.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();
    await commands.execute(['branch', 'feature'], '/project');
    await commands.execute(['checkout', 'feature'], '/project');
    await fs.writeFile('/project/feature.txt', 'feature\n');
    await commands.execute(['add', 'feature.txt'], '/project');
    await commands.execute(['commit', '-m', 'feature'], '/project');

    const mergeBase = await commands.execute(['merge-base', 'main', 'feature'], '/project');
    const ancestor = await commands.execute(
      ['merge-base', '--is-ancestor', 'main', 'feature'],
      '/project'
    );
    const notAncestor = await commands.execute(
      ['merge-base', '--is-ancestor', 'feature', 'main'],
      '/project'
    );

    expect(mergeBase).toEqual({ stdout: `${base}\n`, stderr: '', exitCode: 0 });
    expect(ancestor).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(notAncestor).toEqual({ stdout: '', stderr: '', exitCode: 1 });
  });

  it('lists and filters remote heads without fetching objects', async () => {
    await commands.execute(['init'], '/project');
    await commands.execute(
      ['remote', 'add', 'origin', 'https://example.test/acme/repo.git'],
      '/project'
    );
    const listRefs = vi.spyOn(isoGit, 'listServerRefs').mockResolvedValue([
      { oid: '1'.repeat(40), ref: 'refs/heads/main' },
      { oid: '2'.repeat(40), ref: 'refs/heads/topic' },
    ]);

    try {
      const result = await commands.execute(['ls-remote', '--heads', 'origin', 'main'], '/project');

      expect(result).toEqual({
        stdout: `${'1'.repeat(40)}\trefs/heads/main\n`,
        stderr: '',
        exitCode: 0,
      });
      expect(listRefs).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.test/acme/repo.git',
          prefix: 'refs/heads/',
        })
      );
    } finally {
      listRefs.mockRestore();
    }
  });
});
