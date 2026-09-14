import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs, type IsoGitFsPromises } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

describe('git pack cache (issues #2710, #2735)', () => {
  let vfs: VirtualFS;
  let git: GitCommands;
  let lfs: IsoGitFsPromises;

  let packPayloadBytes = 0;
  const digestSizes: number[] = [];
  let restoreDigest: (() => void) | undefined;

  beforeEach(async () => {
    const testId = dbCounter++;
    vfs = await VirtualFS.create({ dbName: `git-pack-cache-${testId}`, wipe: true });
    git = new GitCommands({
      fs: vfs,
      authorName: 'Test User',
      authorEmail: 'test@example.com',
      globalDbName: `git-pack-cache-global-${testId}`,
    });
    lfs = createIsomorphicGitFs(vfs).promises;
    digestSizes.length = 0;
  });

  afterEach(() => {
    restoreDigest?.();
    restoreDigest = undefined;
    vi.restoreAllMocks();
  });

  async function seedRepo(dir = '/project'): Promise<void> {
    await git.execute(['init'], dir);
    for (const name of ['a', 'b', 'c']) {
      await vfs.writeFile(`${dir}/${name}.txt`, `${name}\n`);
      await git.execute(['add', `${name}.txt`], dir);
      await git.execute(['commit', '-m', `add ${name}`], dir);
    }
  }

  async function looseOids(dir: string): Promise<string[]> {
    const oids: string[] = [];
    for (const entry of await vfs.readDir(`${dir}/.git/objects`)) {
      if (entry.type !== 'directory' || entry.name.length !== 2) continue;
      for (const file of await vfs.readDir(`${dir}/.git/objects/${entry.name}`)) {
        oids.push(`${entry.name}${file.name}`);
      }
    }
    return oids;
  }

  async function packRepo(dir = '/project'): Promise<string> {
    const oids = await looseOids(dir);
    const { filename } = await isoGit.packObjects({ fs: lfs, dir, oids, write: true });
    await isoGit.indexPack({ fs: lfs, dir, filepath: `.git/objects/pack/${filename}` });
    for (const entry of await vfs.readDir(`${dir}/.git/objects`)) {
      if (entry.type !== 'directory' || entry.name.length !== 2) continue;
      await vfs.rm(`${dir}/.git/objects/${entry.name}`, { recursive: true });
    }
    const pack = (await vfs.readFile(`${dir}/.git/objects/pack/${filename}`, {
      encoding: 'binary',
    })) as Uint8Array;
    packPayloadBytes = pack.byteLength - 20;
    return filename.replace(/\.pack$/, '');
  }

  function trackReads(): { of: (suffix: string) => number; reset: () => void } {
    const readSpy = vi.spyOn(vfs, 'readFile');
    return {
      of: (suffix) => readSpy.mock.calls.filter((call) => String(call[0]).endsWith(suffix)).length,
      reset: () => readSpy.mockClear(),
    };
  }

  function trackDeepVerifications(): { count: () => number } {
    const subtle = globalThis.crypto.subtle;
    const original = subtle.digest.bind(subtle);
    subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
      digestSizes.push(ArrayBuffer.isView(data) ? data.byteLength : data.byteLength);
      return original(algorithm, data);
    }) as typeof subtle.digest;
    restoreDigest = () => {
      subtle.digest = original;
    };
    return { count: () => digestSizes.filter((size) => size === packPayloadBytes).length };
  }

  it('reuses the parsed pack index and the pack buffer across commands', async () => {
    await seedRepo();
    const pack = await packRepo();

    const reads = trackReads();
    const first = await git.execute(['log'], '/project');
    const idxAfterFirst = reads.of(`${pack}.idx`);
    const packAfterFirst = reads.of(`${pack}.pack`);
    const second = await git.execute(['log'], '/project');

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toContain('add c');
    expect(second.stdout).toBe(first.stdout);

    expect(idxAfterFirst).toBe(1);
    expect(packAfterFirst).toBe(1);
    expect(reads.of(`${pack}.idx`)).toBe(1);
    expect(reads.of(`${pack}.pack`)).toBe(1);
  });

  it('keeps the pack cache across commands while the per-command read memo does not', async () => {
    await seedRepo();
    const pack = await packRepo();

    const reads = trackReads();
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(reads.of(`${pack}.idx`)).toBe(1);
    expect(reads.of('/.git/HEAD')).toBeGreaterThan(0);

    reads.reset();
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);

    expect(reads.of(`${pack}.idx`)).toBe(0);
    expect(reads.of(`${pack}.pack`)).toBe(0);

    expect(reads.of('/.git/HEAD')).toBeGreaterThan(0);
    expect(reads.of('/.git/packed-refs')).toBeGreaterThan(0);
  });

  it('re-reads the pack index after the pack directory changes', async () => {
    await seedRepo();
    const pack = await packRepo();

    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);

    const dir = '/project/.git/objects/pack';
    const copy = `pack-${'f'.repeat(40)}`;
    const binary = { encoding: 'binary' } as const;
    await vfs.writeFile(`${dir}/${copy}.pack`, await vfs.readFile(`${dir}/${pack}.pack`, binary));
    await vfs.writeFile(`${dir}/${copy}.idx`, await vfs.readFile(`${dir}/${pack}.idx`, binary));

    const reads = trackReads();
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(reads.of(`${pack}.idx`)).toBe(1);

    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(reads.of(`${pack}.idx`)).toBe(1);
  });

  it('skips the deep pack verification by default and honors $SLICC_GIT_VERIFY_PACKS', async () => {
    await seedRepo();
    await packRepo();
    const digests = trackDeepVerifications();

    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(digests.count()).toBe(0);

    expect((await git.execute(['log'], '/project', { SLICC_GIT_VERIFY_PACKS: '1' })).exitCode).toBe(
      0
    );
    expect(digests.count()).toBe(1);

    expect((await git.execute(['log'], '/project', { SLICC_GIT_VERIFY_PACKS: '1' })).exitCode).toBe(
      0
    );
    expect(digests.count()).toBe(1);

    const verifying = new GitCommands({
      fs: vfs,
      globalDbName: `git-pack-cache-verify-${dbCounter}`,
      verifyPackfiles: true,
    });
    expect((await verifying.execute(['log'], '/project')).exitCode).toBe(0);
    expect(digests.count()).toBe(2);
  });

  it('verifies a packfile exactly once for N concurrent readers (#2735)', async () => {
    await seedRepo();
    await packRepo();
    const oids = (await git.execute(['log', '--format=%H'], '/project')).stdout
      .split('\n')
      .filter((line) => line.length === 40);
    expect(oids.length).toBeGreaterThan(1);

    const digests = trackDeepVerifications();

    const cache = {};
    const reads = await Promise.all(
      Array.from({ length: 8 }, () =>
        isoGit.readCommit({ fs: lfs, dir: '/project', cache, oid: oids[0] })
      )
    );

    expect(reads).toHaveLength(8);
    expect(digests.count()).toBe(1);
  });

  it('retries a pack index read that failed once, instead of caching the failure', async () => {
    await seedRepo();
    const pack = await packRepo();

    let failures = 0;
    const readFile = vfs.readFile.bind(vfs);
    vi.spyOn(vfs, 'readFile').mockImplementation(async (path, options) => {
      if (String(path).endsWith(`${pack}.idx`) && failures === 0) {
        failures++;
        throw new Error('EIO: transient bridge failure');
      }
      return await readFile(path, options);
    });

    const failed = await git.execute(['log'], '/project');
    expect(failures).toBe(1);
    expect(failed.exitCode).not.toBe(0);

    const retried = await git.execute(['log'], '/project');
    expect(retried.exitCode).toBe(0);
    expect(retried.stdout).toContain('add c');
  });

  it('unloads the least recently used pack buffers past the resident bound', async () => {
    await seedRepo('/one');
    const packOne = await packRepo('/one');
    await seedRepo('/two');
    const packTwo = await packRepo('/two');

    const bounded = new GitCommands({
      fs: vfs,
      globalDbName: `git-pack-cache-bound-${dbCounter}`,
      maxResidentPacks: 1,
    });

    await bounded.execute(['log'], '/one');
    await bounded.execute(['log'], '/two');
    await bounded.execute(['log'], '/one');

    const reads = trackReads();

    expect((await bounded.execute(['log'], '/one')).exitCode).toBe(0);
    expect(reads.of(`${packOne}.pack`)).toBe(0);

    expect((await bounded.execute(['log'], '/two')).exitCode).toBe(0);
    expect(reads.of(`${packTwo}.pack`)).toBe(1);
    expect(reads.of(`${packTwo}.idx`)).toBe(0);
  });
});
