import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { GitCommands } from '../../src/git/git-commands.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

const CWD = '/project';
const OID = 'e50bab9f4a88d23a42e1ffce02e9d890ae70d7ee';
const PACK_NAME = 'pack-febb9dd16f11567e4ff36b7386b7f0cb8de5ec08';
const PACK_BASE64 =
  'UEFDSwAAAAIAAAADlwl4nI2LQQrCMBBF9znF7AWZ6phOQIqH6AWSzBdFQ0sdweObI/Qt3uLB8w2gBJhJ' +
  '5CFrxtlsqFxwL3ZJY9GoJxGVWtIY8tcfy0YzPk5X777hl9v6xrEubaIkMaooMx24E3psT3fsP8Ka6wsW' +
  '/vSZLde5AXicy0jNyclXSCvKz1UoSEzOTk1RyE/KSk0u4QIAecsJEqUCeJwzNDAwMzFRyEjNycnXK6ko' +
  'YVg20zVvR/V6MWcGS1Prj1/vLf47IxAA7aUPFf67ndFvEVZ+T/Nrc4a38MuN5ewI';
const IDX_BASE64 =
  '/3RPYwAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAB' +
  'AAAAAQAAAAEAAAABAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAAC' +
  'AAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAAC' +
  'AAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAAC' +
  'AAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAgAAAAIAAAAC' +
  'AAAAAgAAAAIAAAACAAAAAgAAAAIAAAACAAAAAwAAAAMAAAADAAAAAwAAAAMAAAADAAAAAwAAAAMAAAAD' +
  'AAAAAwAAAAMAAAADAAAAAwAAAAMAAAADAAAAAwAAAAMAAAADAAAAAwAAAAMAAAADAAAAAwAAAAMAAAAD' +
  'AAAAAwAAAAMAAAADnu3UYBqK490cC++9WXuGgkSEy5emmUVuuHuvFkMAOTU78fXeo/2YUeULq59KiNI6' +
  'QuH/zgLp2JCucNfu3saGsy3RteJI876DAAAAoAAAAH0AAAAM/rud0W8RVn5P82tzhrfwy43l7AhdeTR5' +
  'NOLcref/yJd7EQOBATQAJQ==';

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

const PACK = decode(PACK_BASE64);
const INDEX = decode(IDX_BASE64);
const PACK_PATH = `${CWD}/.git/objects/pack/${PACK_NAME}.pack`;
const INDEX_PATH = `${CWD}/.git/objects/pack/${PACK_NAME}.idx`;

async function seedPackedRepository(vfs: VirtualFS, commands: GitCommands): Promise<void> {
  expect((await commands.execute(['init'], CWD)).exitCode).toBe(0);
  await vfs.mkdir(`${CWD}/.git/objects/pack`, { recursive: true });
  await vfs.mkdir(`${CWD}/.git/refs/heads`, { recursive: true });
  await vfs.writeFile(PACK_PATH, PACK);
  await vfs.writeFile(INDEX_PATH, INDEX);
  await vfs.writeFile(`${CWD}/.git/refs/heads/main`, `${OID}\n`);
  await vfs.writeFile(`${CWD}/.git/packed-refs`, '# pack-refs with: peeled\n');
}

describe('GitCommands object cache (issues #2710 and #2735)', () => {
  let vfs: VirtualFS;
  let commands: GitCommands;
  let id = 0;

  beforeEach(async () => {
    const suffix = id++;
    vfs = await VirtualFS.create({ dbName: `git-object-cache-${suffix}`, wipe: true });
    commands = new GitCommands({
      fs: vfs,
      globalDbName: `git-object-cache-global-${suffix}`,
    });
    await seedPackedRepository(vfs, commands);
  });

  it('reuses parsed indexes, pack bytes, and completed verification across commands', async () => {
    const read = vi.spyOn(vfs, 'readFile');

    const first = await commands.execute(['log', '--oneline'], CWD);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('packed');
    const packReads = read.mock.calls.filter(([path]) => path === PACK_PATH).length;
    const indexReads = read.mock.calls.filter(([path]) => path === INDEX_PATH).length;
    expect(packReads).toBe(1);
    expect(indexReads).toBe(1);

    const second = await commands.execute(['show', '--format=%s'], CWD);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('packed');
    expect(read.mock.calls.filter(([path]) => path === PACK_PATH)).toHaveLength(packReads);
    expect(read.mock.calls.filter(([path]) => path === INDEX_PATH)).toHaveLength(indexReads);
  });

  it('invalidates the cache and verifies changed pack data before reading it', async () => {
    expect((await commands.execute(['log', '--oneline'], CWD)).exitCode).toBe(0);

    const corrupted = PACK.slice();
    corrupted[100] ^= 0xff;
    await vfs.writeFile(PACK_PATH, corrupted);
    // A packed-refs metadata change is one of the cache invalidation signals.
    await vfs.writeFile(`${CWD}/.git/packed-refs`, '# pack-refs changed and enlarged\n');

    const result = await commands.execute(['log', '--oneline'], CWD);
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toContain('Packfile payload corrupted');
  });

  it('shares one in-flight SHA-1 verification across concurrent object readers', async () => {
    const fs = createIsomorphicGitFs(vfs);
    const cache = {};
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let payloadDigests = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      if (data.byteLength === PACK.byteLength - 20) {
        payloadDigests++;
        markStarted();
        return gate.then(() => originalDigest(algorithm, data));
      }
      return originalDigest(algorithm, data);
    });

    const reads = Array.from({ length: 8 }, () =>
      isoGit.readCommit({ fs, dir: CWD, oid: OID, cache })
    );
    await started;
    for (let i = 0; i < 12; i++) await Promise.resolve();
    try {
      expect(payloadDigests).toBe(1);
    } finally {
      release();
    }
    await Promise.all(reads);
    digest.mockRestore();
  });
});
