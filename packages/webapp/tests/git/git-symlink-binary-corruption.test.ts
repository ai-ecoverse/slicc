/**
 * Regression: tracked symlinks + binary blobs must survive a checkout that
 * re-materializes the working tree, on BOTH the `memory` and `opfs`
 * (ZenFS WebAccess) backends.
 *
 * Mirrors what `git clone ai-ecoverse/skills` does inside SLICC (init → add →
 * commit → materialize working tree via checkout) but with a hand-built repo so
 * the test is network-free and deterministic. The scenario is driven directly
 * through the isomorphic-git ↔ VirtualFS adapter (`createIsomorphicGitFs`), the
 * exact seam the production git commands use.
 *
 * The `opfs` variant exercises the real `@zenfs/dom` WebAccessFS code over a
 * mocked `FileSystemDirectoryHandle` (`createMutableDirectoryHandle` +
 * `navigator.storage` stub — same pattern as the OPFS multi-instance test), so
 * the symlink/metadata sidecar logic under test is the production code path,
 * not an in-memory stand-in.
 *
 * These tests are EXPECTED TO FAIL until the Wave 2 fix lands; they document
 * the bug. See the "Root cause: git symlink/binary corruption" note.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import * as isoGit from 'isomorphic-git';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';
import { createMutableDirectoryHandle } from '../fs/fsa-test-helpers.js';

// A JPEG-shaped blob containing every byte 0x00-0xFF plus an invalid UTF-8
// sequence (0xC3 0x28), so any UTF-8 string round-trip anywhere in the
// add/commit/checkout/status path mangles the bytes and the equality check trips.
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

/**
 * init → write binary + symlink → add → commit → wipe working tree → checkout.
 * Mirrors the clone/checkout step that re-materializes a working tree from the
 * object store.
 */
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

  // Wipe the working-tree copies (the .git object store keeps the truth).
  await vfs.rm(`${DIR}/link.bin`);
  await vfs.rm(`${DIR}/data.bin`);

  // Re-materialize the working tree from HEAD — the clone/checkout step.
  await isoGit.checkout({ fs: gitfs, dir: DIR, ref: 'main', force: true });
}

/** Read back what landed in the working tree plus the status matrix. */
async function readState(vfs: VirtualFS): Promise<ScenarioResult> {
  const gitfs = createIsomorphicGitFs(vfs);
  const lstat = await vfs.lstat(`${DIR}/link.bin`);
  const linkTarget = lstat.type === 'symlink' ? await vfs.readlink(`${DIR}/link.bin`) : null;
  const bytes = (await vfs.readFile(`${DIR}/data.bin`, { encoding: 'binary' })) as Uint8Array;

  // Clean tree ⇒ every row is [name, HEAD=1, workdir=1, stage=1].
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
  // (a) the symlink is still a symlink pointing at the correct target
  expect(r.linkType).toBe('symlink');
  expect(r.linkTarget).toBe('data.bin');
  // (b) the binary is byte-identical
  expect(bytesEqual(r.bytes, r.expected)).toBe(true);
  // (c) git status is clean
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

  // Model an app reload over the SAME on-disk OPFS directory: `getDirectoryHandle`
  // returns one shared subdir for ANY `dbName`, so a second `VirtualFS` (fresh
  // `dbName` ⇒ fresh in-realm backend cache ⇒ genuine sidecar re-read) sees the
  // exact bytes the first instance left on disk — the "fresh realm after reload"
  // condition without needing a real browser teardown.
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
    // `dispose()` serializes the WebAccessFS in-memory index to `.metadata.json`.
    await first.dispose();

    // Reload: a fresh instance over the SAME OPFS subdir reads the sidecar back
    // (`WebAccessFS._loadMetadata`). This is the "reload the app after clone,
    // then git status" path.
    const second = await VirtualFS.create({ dbName, backend: 'opfs' });
    try {
      assertClean(await readState(second));
    } finally {
      await second.dispose();
    }
  });

  // REGRESSION (Wave 2 fix). `git clone`/`checkout` never call
  // `flush()`/`dispose()`, so the WebAccessFS in-memory index (where
  // symlink-ness and filemode bits live) used to be serialized to
  // `.metadata.json` only on flush/dispose. On a realm reload the fresh
  // WebAccessFS would read the empty seeded sidecar and `WebAccessFS.stat`'s
  // ENOENT-recovery path re-added the on-disk handle as a REGULAR FILE — so the
  // tracked symlink came back as a plain file whose contents are the link
  // target text (a "broken symlink"), exactly the reported clone symptom.
  // The fix write-throughs the sidecar inside `vfs.symlink()` (and flushes at
  // the end of the clone/checkout wrappers), so the symlink now survives an
  // UNFLUSHED reload.
  it('preserves the tracked symlink after an UNFLUSHED reload (no dispose)', async () => {
    stubSharedSubdirOpfs();
    const first = await VirtualFS.create({
      dbName: `git-corruption-noflush-a-${counter}`,
      backend: 'opfs',
      wipe: true,
    });
    await seedAndCheckout(first);
    // Intentionally NO dispose()/flush() on `first` — mirrors the clone path,
    // which leaves the index un-persisted.
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
