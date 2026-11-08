/**
 * VirtualFS mounts ZenFS with `no_atime` so a read does not bump ctime.
 *
 * ZenFS stamps `atime` on every read and, when that dirty inode is flushed,
 * `Inode.update` also sets `ctimeMs = Date.now()`. isomorphic-git 1.44.9's
 * `compareStats` started comparing ctime/mtime nanoseconds, so a same-second
 * ctime drift after hashing a file (or reading a tracked `.gitignore` for
 * ignore rules) made every worktree entry look stale — `status` / `ls-files`
 * re-hashed the tree and the #2709 read-cache test saw two `.gitignore`
 * reads (utf-8 + binary) instead of one. See `disableZenFsAtime` in
 * `virtual-fs.ts`.
 */
import 'fake-indexeddb/auto';
import * as git from 'isomorphic-git';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createCommandScopedReadCache } from '../../src/git/fs-command-cache.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

describe('ZenFS no_atime on VirtualFS mounts', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `zenfs-no-atime-${dbCounter++}`, wipe: true });
  });

  it('does not bump ctime when a file is read', async () => {
    await vfs.mkdir('/r', { recursive: true });
    await vfs.writeFile('/r/a.txt', 'hello\n');
    const before = await vfs.stat('/r/a.txt');
    await vfs.readFile('/r/a.txt');
    await vfs.readFile('/r/a.txt', { encoding: 'utf-8' });
    const after = await vfs.stat('/r/a.txt');
    expect(after.ctime).toBe(before.ctime);
    expect(after.mtime).toBe(before.mtime);
  });

  it('does not re-hash a clean tracked file during statusMatrix', async () => {
    // Guards the isomorphic-git 1.44.9 nanosecond compareStats path: with
    // atime-driven ctime drift, every tracked file paid an extra binary
    // readFile even when content and whole-second mtime were unchanged.
    const cwd = '/repo';
    const setup = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `zenfs-no-atime-global-${dbCounter++}`,
    });
    await vfs.mkdir(cwd, { recursive: true });
    await setup.execute(['init'], cwd);
    await vfs.writeFile(`${cwd}/tracked.txt`, 'body\n');
    await vfs.writeFile(`${cwd}/.gitignore`, 'ignored-*\n');
    expect((await setup.execute(['add', '.'], cwd)).exitCode).toBe(0);
    expect((await setup.execute(['commit', '-m', 'first'], cwd)).exitCode).toBe(0);
    await vfs.writeFile(`${cwd}/untracked.txt`, 'new\n');

    const reads: string[] = [];
    const base = createIsomorphicGitFs(vfs).promises;
    const wrapped = createCommandScopedReadCache({
      ...base,
      async readFile(path, options) {
        const enc =
          typeof options === 'string'
            ? options
            : ((options as { encoding?: string } | undefined)?.encoding ?? 'bin');
        reads.push(`${path}\t${enc}`);
        return base.readFile(path, options);
      },
    });

    await git.statusMatrix({ fs: { promises: wrapped }, dir: cwd, refresh: false });

    expect(reads.filter((r) => r === `${cwd}/.gitignore\tutf8`)).toHaveLength(1);
    expect(reads.filter((r) => r.startsWith(`${cwd}/.gitignore\tbin`))).toHaveLength(0);
    expect(reads.filter((r) => r.startsWith(`${cwd}/tracked.txt\t`))).toHaveLength(0);
  });
});
