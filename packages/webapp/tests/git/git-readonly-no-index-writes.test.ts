import 'fake-indexeddb/auto';
import * as git from 'isomorphic-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { clean } from '../../src/git/commands/clean.js';
import { diff } from '../../src/git/commands/diff.js';
import { lsFiles } from '../../src/git/commands/ls-files.js';
import { status } from '../../src/git/commands/status.js';
import type { GitCommandContext } from '../../src/git/commands/types.js';
import { GitCommands } from '../../src/git/git-commands.js';
import {
  createIsomorphicGitFs,
  type IsoGitFsPromises,
  type NodeLikeStats,
} from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;
const CWD = '/repo';

function drift(s: NodeLikeStats): NodeLikeStats {
  return { ...s, ino: 0, ctimeMs: s.ctimeMs + 60_000 };
}

function countingFs(inner: IsoGitFsPromises): { fs: IsoGitFsPromises; writes: string[] } {
  const writes: string[] = [];
  const fs: IsoGitFsPromises = {
    ...inner,
    async stat(path) {
      return drift(await inner.stat(path));
    },
    async lstat(path) {
      return drift(await inner.lstat(path));
    },
    async writeFile(path, data, options) {
      writes.push(path);
      return inner.writeFile(path, data, options);
    },
  };
  return { fs, writes };
}

function makeCtx(vfs: VirtualFS, lfs: IsoGitFsPromises): GitCommandContext {
  return {
    lfs,
    fs: vfs,
    cache: {},
    getOnAuth: () => undefined,
    getOnAuthFailure: () => undefined,
    resolveAuthor: async () => ({ name: 'Test User', email: 'test@example.com' }),
    getGlobalFs: async () => vfs,
    setGithubToken: async () => {},
    getGithubToken: () => undefined,
    setDefaultAuthorName: () => {},
    setDefaultAuthorEmail: () => {},
    getConfigOverrides: () => undefined,
    stdin: '',
    useColor: false,
  };
}

describe('read-only git commands never write (issue #2708)', () => {
  let vfs: VirtualFS;
  let ctx: GitCommandContext;
  let writes: string[];

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-readonly-${testId}`, wipe: true });
    const commands = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-readonly-global-${testId}`,
    });

    await vfs.mkdir(`${CWD}/sub`, { recursive: true });
    await commands.execute(['init'], CWD);
    await vfs.writeFile(`${CWD}/a.txt`, 'alpha\n');
    await vfs.writeFile(`${CWD}/b.txt`, 'bravo\n');
    await vfs.writeFile(`${CWD}/sub/c.txt`, 'charlie\n');
    expect((await commands.execute(['add', '.'], CWD)).exitCode).toBe(0);
    expect((await commands.execute(['commit', '-m', 'first'], CWD)).exitCode).toBe(0);

    await vfs.writeFile(`${CWD}/untracked.txt`, 'nope\n');

    const counting = countingFs(createIsomorphicGitFs(vfs).promises);
    writes = counting.writes;
    ctx = makeCtx(vfs, counting.fs);
  });

  it('the fake filesystem really does force an index refresh (control)', async () => {
    await git.statusMatrix({ fs: ctx.lfs, dir: CWD, refresh: true });
    expect(writes.filter((p) => p.endsWith('.git/index')).length).toBeGreaterThan(1);
  });

  it('ls-files lists tracked files without writing', async () => {
    const result = await lsFiles(ctx, CWD, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['a.txt', 'b.txt', 'sub/c.txt']);
    expect(writes).toEqual([]);
  });

  it('ls-files --others lists untracked files without writing', async () => {
    const result = await lsFiles(ctx, CWD, ['--others']);
    expect(result.stdout).toContain('untracked.txt');
    expect(writes).toEqual([]);
  });

  it('status (long form) reports the untracked file without writing', async () => {
    const result = await status(ctx, CWD, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('untracked.txt');
    expect(writes).toEqual([]);
  });

  it('status --short reports without writing', async () => {
    const result = await status(ctx, CWD, ['--short']);
    expect(result.stdout).toContain('?? untracked.txt');
    expect(writes).toEqual([]);
  });

  it('diff against a commit walks the workdir without writing', async () => {
    await vfs.writeFile(`${CWD}/a.txt`, 'alpha changed\n');
    const result = await diff(ctx, CWD, ['HEAD']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a.txt');
    expect(writes).toEqual([]);
  });

  it('diff of unstaged workdir changes does not write', async () => {
    await vfs.writeFile(`${CWD}/b.txt`, 'bravo changed\n');
    const result = await diff(ctx, CWD, []);
    expect(result.stdout).toContain('b.txt');
    expect(writes).toEqual([]);
  });

  it('clean --dry-run does not write', async () => {
    const result = await clean(ctx, CWD, ['-n']);
    expect(result.stdout).toContain('untracked.txt');
    expect(writes).toEqual([]);
  });
});
