/**
 * Regression tests for https://github.com/ai-ecoverse/slicc/issues/2719 —
 * `git diff` read every tracked blob out of the object store and re-read every
 * workdir file, so a clean tree cost two round trips per tracked file (over a
 * hostfs mount that was 172,970 requests and no result after ten minutes).
 *
 * These tests count filesystem work instead of only checking the rendered
 * diff: reads are attributed by path, and blob reads are identified by hashing
 * the known file contents, so tree/commit reads (which a tree walk legitimately
 * needs) don't mask a blob read that should never have happened.
 */

import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

/** Loose-object suffix (`objects/ab/cdef…`) for an OID. */
function oidPath(oid: string): string {
  return `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
}

/** Loose-object suffix for a blob with this content. */
async function blobPath(content: string): Promise<string> {
  const { oid } = await isoGit.hashBlob({ object: content });
  return oidPath(oid);
}

describe('git diff object reads (issue #2719)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-diff-io-test-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-diff-io-global-${testId}`,
    });
  });

  /** init + three committed files, so a clean `git diff` has work to skip. */
  async function seedRepo(): Promise<void> {
    await git.execute(['init'], '/project');
    await vfs.mkdir('/project/src', { recursive: true });
    await vfs.writeFile('/project/a.txt', 'alpha\n');
    await vfs.writeFile('/project/b.txt', 'bravo\n');
    await vfs.writeFile('/project/src/c.txt', 'charlie\n');
    await git.execute(['add', '.'], '/project');
    await git.execute(['commit', '-m', 'initial'], '/project');
  }

  /** Records every VFS read/readDir so a command's I/O can be attributed. */
  function trackIo(): {
    allReads: () => string[];
    objectReads: () => string[];
    blobReads: (contents: string[]) => Promise<string[]>;
    dirs: () => string[];
  } {
    const readSpy = vi.spyOn(vfs, 'readFile');
    const dirSpy = vi.spyOn(vfs, 'readDir');
    const allReads = () => readSpy.mock.calls.map((call) => String(call[0]));
    const objectReads = () => allReads().filter((p) => p.includes('/.git/objects/'));
    return {
      allReads,
      objectReads,
      blobReads: async (contents) => {
        const wanted = await Promise.all(contents.map(blobPath));
        return objectReads().filter((read) => wanted.some((suffix) => read.endsWith(suffix)));
      },
      dirs: () => dirSpy.mock.calls.map((call) => String(call[0])),
    };
  }

  it('reads no objects at all when nothing is modified', async () => {
    await seedRepo();

    const io = trackIo();
    const result = await git.execute(['diff'], '/project');

    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
    expect(io.objectReads()).toEqual([]);
  });

  it('reads exactly one blob when one file is modified', async () => {
    await seedRepo();
    await vfs.writeFile('/project/b.txt', 'bravo\ndelta\n');

    const io = trackIo();
    const result = await git.execute(['diff'], '/project');

    expect(result.stdout).toContain('diff --git a/b.txt b/b.txt');
    expect(result.stdout).toContain('+delta');
    expect(result.stdout).not.toContain('a/a.txt');
    // Only the modified file's staged blob comes out of the object store.
    expect(io.objectReads()).toHaveLength(1);
    expect(await io.blobReads(['bravo\n'])).toHaveLength(1);
  });

  /** An untracked tree deep enough to prove the walk stops at its root. */
  async function seedUntrackedTree(): Promise<void> {
    await vfs.mkdir('/project/node_modules/pkg/nested', { recursive: true });
    await vfs.writeFile('/project/node_modules/pkg/nested/index.js', 'module.exports = 1\n');
  }

  it('never descends into untracked directories', async () => {
    await seedRepo();
    await seedUntrackedTree();

    const io = trackIo();
    const result = await git.execute(['diff'], '/project');

    expect(result.stdout).toBe('');
    // The walk lists `node_modules` itself (isomorphic-git reads an entry
    // before the map can prune it) but never goes below it.
    expect(io.dirs().filter((p) => p.startsWith('/project/node_modules/'))).toEqual([]);
    expect(io.allReads().filter((p) => p.includes('node_modules'))).toEqual([]);
    expect(io.objectReads()).toEqual([]);
  });

  it('applies pathspecs before reading anything', async () => {
    await seedRepo();
    await vfs.writeFile('/project/a.txt', 'alpha\nadded\n');
    await vfs.writeFile('/project/b.txt', 'bravo\nadded\n');

    const io = trackIo();
    const result = await git.execute(['diff', '--', 'b.txt'], '/project');

    expect(result.stdout).toContain('a/b.txt');
    expect(result.stdout).not.toContain('a/a.txt');
    // The excluded file's blob is never fetched from the object store.
    expect(io.objectReads()).toHaveLength(1);
    expect(await io.blobReads(['alpha\n'])).toEqual([]);
  });

  it('diffs a tracked dotfile whose name starts with .git', async () => {
    await seedRepo();
    await vfs.writeFile('/project/.gitignore', 'dist\n');
    await git.execute(['add', '.gitignore'], '/project');
    await git.execute(['commit', '-m', 'ignore'], '/project');
    await vfs.writeFile('/project/.gitignore', 'dist\ncoverage\n');

    const unstaged = await git.execute(['diff'], '/project');

    expect(unstaged.stdout).toContain('diff --git a/.gitignore b/.gitignore');
    expect(unstaged.stdout).toContain('+coverage');

    await git.execute(['add', '.gitignore'], '/project');
    const staged = await git.execute(['diff', '--staged'], '/project');

    expect(staged.stdout).toContain('diff --git a/.gitignore b/.gitignore');
    expect(staged.stdout).toContain('+coverage');
  });

  it('still reports a file deleted from the workdir', async () => {
    await seedRepo();
    await vfs.rm('/project/a.txt');

    const result = await git.execute(['diff'], '/project');

    expect(result.stdout).toContain('diff --git a/a.txt b/a.txt');
    expect(result.stdout).toContain('-alpha');
  });

  it('lists modified files in path order', async () => {
    await seedRepo();
    await vfs.writeFile('/project/a.txt', 'alpha\nadded\n');
    await vfs.writeFile('/project/b.txt', 'bravo\nadded\n');
    await vfs.writeFile('/project/src/c.txt', 'charlie\nadded\n');

    const result = await git.execute(['diff', '--name-only'], '/project');

    expect(result.stdout).toBe('a.txt\nb.txt\nsrc/c.txt\n');
  });

  it('reads no blobs for --staged when the index matches HEAD', async () => {
    await seedRepo();

    const io = trackIo();
    const result = await git.execute(['diff', '--staged'], '/project');

    expect(result.stdout).toBe('');
    expect(await io.blobReads(['alpha\n', 'bravo\n', 'charlie\n'])).toEqual([]);
  });

  it('reads only the changed pair for --staged', async () => {
    await seedRepo();
    await vfs.writeFile('/project/b.txt', 'bravo\nstaged\n');
    await git.execute(['add', 'b.txt'], '/project');

    const io = trackIo();
    const result = await git.execute(['diff', '--staged'], '/project');

    expect(result.stdout).toContain('+staged');
    // The HEAD blob and the index blob for the one changed file, nothing else.
    expect(await io.blobReads(['bravo\n', 'bravo\nstaged\n'])).toHaveLength(2);
    expect(await io.blobReads(['alpha\n', 'charlie\n'])).toEqual([]);
  });

  it('reads no blobs for `diff HEAD` on a clean tree and skips .git', async () => {
    await seedRepo();
    await seedUntrackedTree();

    const io = trackIo();
    const result = await git.execute(['diff', 'HEAD'], '/project');

    expect(result.stdout).toBe('');
    expect(await io.blobReads(['alpha\n', 'bravo\n', 'charlie\n'])).toEqual([]);
    expect(io.dirs().filter((p) => p.startsWith('/project/node_modules/'))).toEqual([]);
    // The workdir walk stops at `.git` instead of crawling its contents; the
    // `objects/` listings below come from revision resolution (#2713).
    expect(
      io.dirs().filter((p) => p.startsWith('/project/.git/') && !p.includes('/objects'))
    ).toEqual([]);
  });

  it('still diffs HEAD against a modified workdir', async () => {
    await seedRepo();
    await vfs.writeFile('/project/src/c.txt', 'charlie\ndelta\n');

    const result = await git.execute(['diff', 'HEAD'], '/project');

    expect(result.stdout).toContain('diff --git a/src/c.txt b/src/c.txt');
    expect(result.stdout).toContain('+delta');
  });

  it('reports a staged file in a directory that is absent from HEAD', async () => {
    await seedRepo();
    await vfs.mkdir('/project/fresh', { recursive: true });
    await vfs.writeFile('/project/fresh/new.txt', 'fresh\n');
    await git.execute(['add', 'fresh/new.txt'], '/project');

    const result = await git.execute(['diff', 'HEAD', '--name-only'], '/project');

    expect(result.stdout).toContain('fresh/new.txt');
  });

  it('prunes identical subtrees when diffing two commits', async () => {
    await seedRepo();
    await vfs.mkdir('/project/src/deep', { recursive: true });
    await vfs.writeFile('/project/src/deep/d.txt', 'delta\n');
    await git.execute(['add', 'src/deep/d.txt'], '/project');
    await git.execute(['commit', '-m', 'deep'], '/project');
    await vfs.writeFile('/project/a.txt', 'alpha\nsecond\n');
    await git.execute(['add', 'a.txt'], '/project');
    await git.execute(['commit', '-m', 'second'], '/project');
    const isoFs = createIsomorphicGitFs(vfs);
    const head = await isoGit.resolveRef({ fs: isoFs, dir: '/project', ref: 'HEAD' });
    const deepTree = await isoGit.readTree({
      fs: isoFs,
      dir: '/project',
      oid: head,
      filepath: 'src/deep',
    });

    const io = trackIo();
    const result = await git.execute(['diff', 'HEAD~1', 'HEAD', '--name-only'], '/project');

    expect(result.stdout).toBe('a.txt\n');
    // `src/` is byte-identical between the two commits, so the walk stops
    // there: neither the tree below it nor any blob under it is read.
    expect(io.objectReads().filter((p) => p.endsWith(oidPath(deepTree.oid)))).toEqual([]);
    expect(await io.blobReads(['charlie\n', 'bravo\n', 'delta\n'])).toEqual([]);
  });
});
