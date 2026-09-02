/**
 * Cross-command object/pack cache (issue #2710) and the once-per-pack
 * verification (issue #2735).
 *
 * Every `git` command used to hand isomorphic-git a FRESH cache, so each one
 * re-read the whole `.pack`, re-parsed every `.idx`, and re-ran the deep SHA-1
 * integrity check over the pack payload — on the slicc checkout, 5.2 s of
 * hashing per warm command. These tests count filesystem reads and SHA-1
 * digests rather than asserting on rendered output, because that cost is
 * invisible in the command's stdout.
 *
 * The repo fixtures pack their objects for real (`packObjects` + `indexPack`,
 * loose copies deleted) so the reads under test go through
 * `readObjectPacked`, the code path the issues are about.
 */

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
  /** Byte length of the packed payload, i.e. what a deep verification hashes. */
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

  /** Three commits, so a `log` has objects to read. */
  async function seedRepo(dir = '/project'): Promise<void> {
    await git.execute(['init'], dir);
    for (const name of ['a', 'b', 'c']) {
      await vfs.writeFile(`${dir}/${name}.txt`, `${name}\n`);
      await git.execute(['add', `${name}.txt`], dir);
      await git.execute(['commit', '-m', `add ${name}`], dir);
    }
  }

  /** Every loose object OID under `.git/objects`, as `<dir><rest>`. */
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

  /**
   * Pack every loose object and delete the loose copies, so object reads have
   * to go through the packfile. Returns the pack's base name.
   */
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

  /** Count the reads of each `.git` path a command performs. */
  function trackReads(): { of: (suffix: string) => number } {
    const readSpy = vi.spyOn(vfs, 'readFile');
    return {
      of: (suffix) => readSpy.mock.calls.filter((call) => String(call[0]).endsWith(suffix)).length,
    };
  }

  /**
   * Count SHA-1 digests over the packfile payload — i.e. how many times the
   * deep integrity check ran. Digests of any other size (objects, trees) are
   * ignored.
   */
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
    // The first command had to read both; the second reads neither again.
    expect(idxAfterFirst).toBe(1);
    expect(packAfterFirst).toBe(1);
    expect(reads.of(`${pack}.idx`)).toBe(1);
    expect(reads.of(`${pack}.pack`)).toBe(1);
  });

  it('re-reads the pack index after the pack directory changes', async () => {
    await seedRepo();
    const pack = await packRepo();

    // First command populates the cache with this repository's pack index.
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);

    // A second pack lands (a fetch, or an outside repack): the cached indexes
    // are no longer known to describe the repository. Named to sort AFTER the
    // real one so object reads still resolve out of the original pack.
    const dir = '/project/.git/objects/pack';
    const copy = `pack-${'f'.repeat(40)}`;
    const binary = { encoding: 'binary' } as const;
    await vfs.writeFile(`${dir}/${copy}.pack`, await vfs.readFile(`${dir}/${pack}.pack`, binary));
    await vfs.writeFile(`${dir}/${copy}.idx`, await vfs.readFile(`${dir}/${pack}.idx`, binary));

    const reads = trackReads();
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(reads.of(`${pack}.idx`)).toBe(1);

    // …and the refreshed cache holds again: an unchanged pack directory costs
    // no further index read.
    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(reads.of(`${pack}.idx`)).toBe(1);
  });

  it('skips the deep pack verification by default and honors $SLICC_GIT_VERIFY_PACKS', async () => {
    await seedRepo();
    await packRepo();
    const digests = trackDeepVerifications();

    expect((await git.execute(['log'], '/project')).exitCode).toBe(0);
    expect(digests.count()).toBe(0);

    // Opting back in mid-shell must re-verify: the skipped run memoized a
    // verification that never hashed the payload, and reusing it would make
    // the documented opt-in silently do nothing.
    expect((await git.execute(['log'], '/project', { SLICC_GIT_VERIFY_PACKS: '1' })).exitCode).toBe(
      0
    );
    expect(digests.count()).toBe(1);

    // …and it is not re-hashed on every subsequent verified command.
    expect((await git.execute(['log'], '/project', { SLICC_GIT_VERIFY_PACKS: '1' })).exitCode).toBe(
      0
    );
    expect(digests.count()).toBe(1);

    // The constructor option is the same switch, from the first read on.
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
    // A fresh cache with verification ON: every reader arrives while the first
    // one's SHA-1 is still in flight, which is what used to hash the pack once
    // per reader.
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

    // One transient VFS error on the .idx — the EIO class the hostfs bridge
    // raises (#2720). isomorphic-git caches the in-flight PROMISE, so without
    // eviction every later command awaits this same rejection.
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
    // /one is used FIRST and LAST, so eviction order has to be by use and not
    // by the order the packs entered the cache.
    await bounded.execute(['log'], '/one');
    await bounded.execute(['log'], '/two');
    await bounded.execute(['log'], '/one');

    const reads = trackReads();
    // /one was used last, so its buffer stayed resident.
    expect((await bounded.execute(['log'], '/one')).exitCode).toBe(0);
    expect(reads.of(`${packOne}.pack`)).toBe(0);
    // /two's was unloaded and has to be re-read — but its parsed index, the
    // expensive half, is still cached.
    expect((await bounded.execute(['log'], '/two')).exitCode).toBe(0);
    expect(reads.of(`${packTwo}.pack`)).toBe(1);
    expect(reads.of(`${packTwo}.idx`)).toBe(0);
  });
});
