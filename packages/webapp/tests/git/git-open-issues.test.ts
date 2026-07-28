import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';

describe('git open-issue compatibility', () => {
  let git: GitCommands;
  let fs: VirtualFS;
  let id = 0;

  beforeEach(async () => {
    const suffix = id++;
    fs = await VirtualFS.create({ dbName: `git-open-issues-${suffix}`, wipe: true });
    git = new GitCommands({ fs, globalDbName: `git-open-issues-global-${suffix}` });
  });

  async function commit(path: string, content: string, message: string): Promise<string> {
    await fs.writeFile(`/project/${path}`, content);
    await git.execute(['add', path], '/project');
    await git.execute(['commit', '-m', message], '/project');
    return (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();
  }

  async function seedHistory(): Promise<[string, string, string]> {
    await git.execute(['init'], '/project');
    await fs.writeFile('/project/dirA/a.txt', 'a1\n');
    await fs.writeFile('/project/dirB/b.txt', 'b1\n');
    await git.execute(['add', '.'], '/project');
    await git.execute(['commit', '-m', 'c1: both'], '/project');
    const c1 = (await git.execute(['rev-parse', 'HEAD'], '/project')).stdout.trim();
    const c2 = await commit('dirA/a.txt', 'a2\n', 'c2: dirA');
    const c3 = await commit('dirB/b.txt', 'b2\n', 'c3: dirB');
    return [c1, c2, c3];
  }

  it('honors pathspecs for diff, log, and status (#1724)', async () => {
    const [c1, , c3] = await seedHistory();
    const diff = await git.execute(['diff', '--name-only', c1, c3, '--', 'dirA'], '/project');
    const empty = await git.execute(
      ['diff', '--name-only', c1, c3, '--', 'does-not-exist'],
      '/project'
    );
    const log = await git.execute(['log', '--oneline', '--', 'dirA'], '/project');
    await fs.writeFile('/project/dirA/a.txt', 'dirty a\n');
    await fs.writeFile('/project/dirB/b.txt', 'dirty b\n');
    const status = await git.execute(['status', '--short', '--', 'dirA'], '/project');

    expect(diff.stdout).toBe('dirA/a.txt\n');
    expect(empty.stdout).toBe('');
    expect(log.stdout).toContain('c2: dirA');
    expect(log.stdout).toContain('c1: both');
    expect(log.stdout).not.toContain('c3: dirB');
    expect(status.stdout).toContain('dirA/a.txt');
    expect(status.stdout).not.toContain('dirB/b.txt');
  });

  it('supports log ranges and common diff commit forms (#1725)', async () => {
    const [c1, c2, c3] = await seedHistory();
    const rangeLog = await git.execute(['log', '--oneline', `${c2}..${c3}`], '/project');
    const rangeDiff = await git.execute(['diff', '--name-only', `${c1}..${c3}`], '/project');
    const singleDiff = await git.execute(['diff', '--name-only', c1], '/project');
    const bogus = await git.execute(['diff', '--stat', 'not-a-ref'], '/project');

    expect(rangeLog.stdout).toContain('c3: dirB');
    expect(rangeLog.stdout).not.toContain('c2: dirA');
    expect(rangeDiff.stdout.trim().split('\n').sort()).toEqual(['dirA/a.txt', 'dirB/b.txt']);
    expect(singleDiff.stdout.trim().split('\n').sort()).toEqual(['dirA/a.txt', 'dirB/b.txt']);
    expect(bogus.exitCode).toBe(128);
    expect(bogus.stderr).toContain("ambiguous argument 'not-a-ref'");
  });

  it.each(['/source', 'file:///source'])(
    'clones a local repository from %s (#1729)',
    async (url) => {
      await git.execute(['init'], '/source');
      await fs.writeFile('/source/readme.txt', 'local clone\n');
      await git.execute(['add', 'readme.txt'], '/source');
      await git.execute(['commit', '-m', 'local source'], '/source');

      const result = await git.execute(['clone', url, '/copy'], '/');

      expect(result.exitCode).toBe(0);
      expect(await fs.readTextFile('/copy/readme.txt')).toBe('local clone\n');
      expect((await git.execute(['log', '--oneline'], '/copy')).stdout).toContain('local source');
    }
  );
});
