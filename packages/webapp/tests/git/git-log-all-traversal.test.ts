import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

function oidPath(oid: string): string {
  return `objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
}

describe('git log --all traversal (issue #2712)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let lfs: ReturnType<typeof createIsomorphicGitFs>;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-log-all-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-log-all-global-${testId}`,
    });
    lfs = createIsomorphicGitFs(vfs);
  });

  async function commitAt(
    path: string,
    content: string,
    message: string,
    timestamp: number
  ): Promise<string> {
    await vfs.writeFile(`/project/${path}`, content);
    await git.execute(['add', path], '/project');
    return await isoGit.commit({
      fs: lfs,
      dir: '/project',
      message,
      author: { name: 'Test User', email: 'test@example.com', timestamp },
    });
  }

  function subjects(stdout: string): string[] {
    return stdout.trim() === '' ? [] : stdout.trim().split('\n');
  }

  async function seedInterleaved(): Promise<Record<string, string>> {
    await git.execute(['init'], '/project');
    const c1 = await commitAt('base.txt', 'base\n', 'c1', 1_700_000_100);
    await git.execute(['checkout', '-b', 'feature'], '/project');
    const f1 = await commitAt('feature.txt', 'f1\n', 'f1', 1_700_000_200);
    const f2 = await commitAt('feature.txt', 'f2\n', 'f2', 1_700_000_400);
    await git.execute(['checkout', 'main'], '/project');
    const c2 = await commitAt('main.txt', 'c2\n', 'c2', 1_700_000_300);
    return { c1, c2, f1, f2 };
  }

  function trackIo(): { reads: () => string[]; dirs: () => string[] } {
    const readSpy = vi.spyOn(vfs, 'readFile');
    const dirSpy = vi.spyOn(vfs, 'readDir');
    return {
      reads: () => readSpy.mock.calls.map((call) => String(call[0])),
      dirs: () => dirSpy.mock.calls.map((call) => String(call[0])),
    };
  }

  it('returns every branch newest-first by date, not branch by branch', async () => {
    await seedInterleaved();

    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(result.exitCode).toBe(0);
    expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);
  });

  it('dedupes commits reachable from more than one branch', async () => {
    await seedInterleaved();

    await git.execute(['branch', 'copy'], '/project');

    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);
  });

  it('applies -n across all branches and stops the walk there', async () => {
    const oids = await seedInterleaved();

    const io = trackIo();
    const result = await git.execute(['log', '--all', '-n', '2', '--format', '%s'], '/project');

    expect(subjects(result.stdout)).toEqual(['f2', 'c2']);

    expect(io.reads().filter((p) => p.endsWith(oidPath(oids.c1)))).toEqual([]);
  });

  it('reads each commit object exactly once, even when branches share history', async () => {
    const oids = await seedInterleaved();

    const io = trackIo();
    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);
    for (const [name, oid] of Object.entries(oids)) {
      const reads = io.reads().filter((p) => p.endsWith(oidPath(oid)));
      expect(`${name}: ${reads.length}`).toBe(`${name}: 1`);
    }
  });

  it('honors --all with -n on a repo with many branches without walking each one', async () => {
    await git.execute(['init'], '/project');
    await commitAt('base.txt', 'base\n', 'base', 1_700_000_000);
    for (let i = 0; i < 8; i++) {
      await git.execute(['checkout', '-b', `topic-${i}`], '/project');
      await commitAt(`t${i}.txt`, `${i}\n`, `topic ${i}`, 1_700_001_000 + i);
      await git.execute(['checkout', 'main'], '/project');
    }

    const io = trackIo();
    const result = await git.execute(['log', '--all', '-n', '3', '--format', '%s'], '/project');

    expect(subjects(result.stdout)).toEqual(['topic 7', 'topic 6', 'topic 5']);

    const commitReads = io.reads().filter((p) => p.includes('/.git/objects/'));
    expect(commitReads.length).toBeLessThanOrEqual(10);
  });

  async function noiseCommits(count: number, firstTimestamp: number): Promise<void> {
    const head = await isoGit.resolveRef({ fs: lfs, dir: '/project', ref: 'HEAD' });
    const { commit } = await isoGit.readCommit({ fs: lfs, dir: '/project', oid: head });
    for (let i = 0; i < count; i++) {
      await isoGit.commit({
        fs: lfs,
        dir: '/project',
        message: `noise ${i}`,
        tree: commit.tree,
        author: { name: 'Test User', email: 'test@example.com', timestamp: firstTimestamp + i },
      });
    }
  }

  it('finds a pathspec match behind hundreds of newer commits on another branch', async () => {
    await git.execute(['init'], '/project');
    await commitAt('README.md', 'r\n', 'root', 1_700_000_000);
    await git.execute(['checkout', '-b', 'feature'], '/project');
    await commitAt('src/target.ts', 'v1\n', 'feature touches target', 1_700_000_010);
    await git.execute(['checkout', 'main'], '/project');

    await noiseCommits(520, 1_700_100_000);

    const capped = await git.execute(
      ['log', '--all', '-n', '1', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );
    const uncapped = await git.execute(
      ['log', '--all', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );

    expect(subjects(capped.stdout)).toEqual(['feature touches target']);
    expect(subjects(uncapped.stdout)).toEqual(['feature touches target']);
  }, 120_000);

  it('stops the pathspec walk as soon as -n matches are found', async () => {
    await git.execute(['init'], '/project');
    await commitAt('src/target.ts', 'v1\n', 'old target', 1_700_000_000);
    await noiseCommits(120, 1_700_001_000);
    await commitAt('src/target.ts', 'v2\n', 'new target', 1_700_100_000);

    const io = trackIo();
    const result = await git.execute(
      ['log', '--all', '-n', '1', '--format', '%s', '--', 'src/target.ts'],
      '/project'
    );

    expect(subjects(result.stdout)).toEqual(['new target']);

    expect(io.reads().filter((p) => p.includes('/.git/objects/')).length).toBeLessThan(100);
  }, 120_000);

  it('terminates when no commit anywhere matches the pathspec', async () => {
    await seedInterleaved();
    await noiseCommits(60, 1_700_002_000);

    const result = await git.execute(
      ['log', '--all', '--format', '%s', '--', 'does/not/exist.ts'],
      '/project'
    );

    expect(result.exitCode).toBe(0);
    expect(subjects(result.stdout)).toEqual([]);
  }, 60_000);

  it('orders same-second merge parents first-parent first', async () => {
    await git.execute(['init'], '/project');
    await commitAt('base.txt', 'base\n', 'c1', 1_700_000_000);
    await git.execute(['checkout', '-b', 'side'], '/project');
    const side = await commitAt('side.txt', 's\n', 's1', 1_700_000_100);
    await git.execute(['checkout', 'main'], '/project');
    const main = await commitAt('main.txt', 'm\n', 'm1', 1_700_000_100);
    const { commit } = await isoGit.readCommit({ fs: lfs, dir: '/project', oid: main });
    await isoGit.commit({
      fs: lfs,
      dir: '/project',
      message: 'merge',
      tree: commit.tree,
      parent: [main, side],
      author: { name: 'Test User', email: 'test@example.com', timestamp: 1_700_000_200 },
    });

    await git.execute(['branch', '-D', 'side'], '/project');

    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(subjects(result.stdout)).toEqual(['merge', 'm1', 's1', 'c1']);
  });

  it('skips an unresolvable branch instead of failing the whole log', async () => {
    await seedInterleaved();
    await vfs.writeFile('/project/.git/refs/heads/broken', 'not-an-object-id\n');

    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(result.exitCode).toBe(0);
    expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);
  });

  it('skips a branch whose tip commit is missing from the object store', async () => {
    await seedInterleaved();
    await vfs.writeFile('/project/.git/refs/heads/dangling', `${'0'.repeat(39)}1\n`);

    const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

    expect(result.exitCode).toBe(0);
    expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);
  });

  describe('packed repository', () => {
    async function packEverything(): Promise<void> {
      const oids: string[] = [];
      for (const dir of await vfs.readDir('/project/.git/objects')) {
        if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
        for (const file of await vfs.readDir(`/project/.git/objects/${dir.name}`)) {
          oids.push(dir.name + file.name);
        }
      }
      const { filename } = await isoGit.packObjects({
        fs: lfs,
        dir: '/project',
        oids,
        write: true,
      });
      await isoGit.indexPack({
        fs: lfs,
        dir: '/project',
        filepath: `.git/objects/pack/${filename}`,
      });
      for (const dir of await vfs.readDir('/project/.git/objects')) {
        if (!/^[0-9a-f]{2}$/.test(dir.name)) continue;
        await vfs.rm(`/project/.git/objects/${dir.name}`, { recursive: true });
      }
    }

    it('lists objects/pack once per command and skips the loose-object probe', async () => {
      await seedInterleaved();
      await packEverything();

      const io = trackIo();
      const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

      expect(subjects(result.stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);

      expect(io.dirs().filter((p) => p.endsWith('/objects/pack'))).toEqual([
        '/project/.git/objects/pack',
        '/project/.git/objects/pack',
      ]);

      expect(io.reads().filter((p) => /\/objects\/[0-9a-f]{2}\//.test(p))).toEqual([]);
    });

    it('does not share the object memo between two commands running at once', async () => {
      await seedInterleaved();
      await packEverything();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let announce!: () => void;
      const parked = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const realReadDir = vfs.readDir.bind(vfs);
      const packLists: string[] = [];
      vi.spyOn(vfs, 'readDir').mockImplementation(async (path) => {
        if (path.endsWith('/objects/pack')) {
          packLists.push(path);
          if (packLists.length === 1) {
            announce();
            await gate;
          }
        }
        return await realReadDir(path);
      });

      const first = git.execute(['log', '--all', '--format', '%s'], '/project');
      await parked;
      const second = git.execute(['log', '-n', '1', '--format', '%s'], '/project');
      for (let i = 0; i < 50 && packLists.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      release();

      expect(subjects((await second).stdout)).toEqual(['c2']);
      expect(subjects((await first).stdout)).toEqual(['f2', 'c2', 'f1', 'c1']);

      expect(packLists).toHaveLength(3);
    });

    it('still finds a loose object written next to the pack', async () => {
      await seedInterleaved();
      await packEverything();

      const loose = await commitAt('late.txt', 'late\n', 'late', 1_700_000_500);

      const result = await git.execute(['log', '--all', '--format', '%s'], '/project');

      expect(subjects(result.stdout)).toEqual(['late', 'f2', 'c2', 'f1', 'c1']);
      expect(await vfs.exists(`/project/.git/${oidPath(loose)}`)).toBe(true);
    });
  });
});
