import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';
import { createMutableDirectoryHandle } from '../fs/fsa-test-helpers.js';

function makeBinary(): Uint8Array {
  const header = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
  const allBytes = Array.from({ length: 256 }, (_, i) => i);
  const footer = [0xff, 0xd9];
  return new Uint8Array([...header, ...allBytes, 0xc3, 0x28, ...footer]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ScenarioResult {
  linkType: string;
  linkTarget: string | null;
  bytes: Uint8Array;
  expected: Uint8Array;
  dirtyRows: string[];
}

const DIR = '/project';
const EXPECTED = makeBinary();

async function seedAndCheckout(vfs: VirtualFS): Promise<void> {
  const gitfs = createIsomorphicGitFs(vfs);
  await isoGit.init({ fs: gitfs, dir: DIR, defaultBranch: 'main' });

  await vfs.writeFile(`${DIR}/data.bin`, EXPECTED);
  await vfs.symlink('data.bin', `${DIR}/link.bin`);

  await isoGit.add({ fs: gitfs, dir: DIR, filepath: 'data.bin' });
  await isoGit.add({ fs: gitfs, dir: DIR, filepath: 'link.bin' });
  await isoGit.commit({
    fs: gitfs,
    dir: DIR,
    message: 'seed binary + symlink',
    author: { name: 'Test User', email: 'test@example.com' },
  });

  await vfs.rm(`${DIR}/link.bin`);
  await vfs.rm(`${DIR}/data.bin`);

  await isoGit.checkout({ fs: gitfs, dir: DIR, ref: 'main', force: true });
}

async function readState(vfs: VirtualFS): Promise<ScenarioResult> {
  const gitfs = createIsomorphicGitFs(vfs);
  const lstat = await vfs.lstat(`${DIR}/link.bin`);
  const linkTarget = lstat.type === 'symlink' ? await vfs.readlink(`${DIR}/link.bin`) : null;
  const bytes = (await vfs.readFile(`${DIR}/data.bin`, { encoding: 'binary' })) as Uint8Array;

  const matrix = await isoGit.statusMatrix({ fs: gitfs, dir: DIR });
  const dirtyRows = matrix
    .filter((r) => !(r[1] === 1 && r[2] === 1 && r[3] === 1))
    .map((r) => `${r[0]} [${r[1]},${r[2]},${r[3]}]`);

  return { linkType: lstat.type, linkTarget, bytes, expected: EXPECTED, dirtyRows };
}

async function runCheckoutScenario(vfs: VirtualFS): Promise<ScenarioResult> {
  await seedAndCheckout(vfs);
  return readState(vfs);
}

function assertClean(r: ScenarioResult): void {
  expect(r.linkType).toBe('symlink');
  expect(r.linkTarget).toBe('data.bin');

  expect(bytesEqual(r.bytes, r.expected)).toBe(true);

  expect(r.dirtyRows).toEqual([]);
}

let counter = 0;

describe('git checkout preserves symlinks + binary — memory backend', () => {
  it('re-materializes a tracked symlink and binary blob byte-identically', async () => {
    const vfs = await VirtualFS.create({ dbName: `git-corruption-mem-${counter++}`, wipe: true });
    try {
      assertClean(await runCheckoutScenario(vfs));
    } finally {
      await vfs.dispose();
    }
  });
});

describe('git checkout preserves symlinks + binary — opfs (WebAccess) backend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOpfs(): void {
    const opfs = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => opfs.handle },
    });
  }

  function stubSharedSubdirOpfs(): void {
    const subdir = createMutableDirectoryHandle({}).handle;
    const root = {
      kind: 'directory',
      name: 'root',
      getDirectoryHandle: async (): Promise<FileSystemDirectoryHandle> => subdir,
      removeEntry: async (): Promise<void> => {},
    } as unknown as FileSystemDirectoryHandle;
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => root },
    });
  }

  it('re-materializes a tracked symlink and binary blob byte-identically', async () => {
    stubOpfs();
    const vfs = await VirtualFS.create({
      dbName: `git-corruption-opfs-${counter++}`,
      backend: 'opfs',
      wipe: true,
    });
    try {
      assertClean(await runCheckoutScenario(vfs));
    } finally {
      await vfs.dispose();
    }
  });

  it('preserves symlink + binary across an app reload (metadata sidecar round-trip)', async () => {
    stubOpfs();
    const dbName = `git-corruption-opfs-reload-${counter++}`;
    const first = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    await seedAndCheckout(first);

    await first.dispose();

    const second = await VirtualFS.create({ dbName, backend: 'opfs' });
    try {
      assertClean(await readState(second));
    } finally {
      await second.dispose();
    }
  });

  it('preserves the tracked symlink after an UNFLUSHED reload (no dispose)', async () => {
    stubSharedSubdirOpfs();
    const first = await VirtualFS.create({
      dbName: `git-corruption-noflush-a-${counter}`,
      backend: 'opfs',
      wipe: true,
    });
    await seedAndCheckout(first);

    const second = await VirtualFS.create({
      dbName: `git-corruption-noflush-b-${counter++}`,
      backend: 'opfs',
    });
    try {
      assertClean(await readState(second));
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });
});
