/**
 * Ranged reads through the isomorphic-git fs adapter (issue #2711).
 *
 * isomorphic-git asks its `PromiseFsClient` for a packfile as ONE buffer
 * (`readObjectPacked` → `fs.read(packFile)`), so over a hostfs mount a repo
 * whose largest pack exceeded the bridge's whole-file body cap failed every
 * git command, and a pack under the cap still cost its full size in kernel-
 * worker memory per object lookup. `FileSystem.read(filepath, options)` hands
 * `options` straight to this adapter's `readFile`, so honoring `{start, end}`
 * here is all that stands between isomorphic-git and a windowed pack read.
 *
 * These tests pin the contract that makes that possible: a window must reach
 * the backend AS a window, never as "read everything, then slice".
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { VirtualFS } from '../../src/fs/index.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from '../../src/fs/mount/backend.js';
import { FsError } from '../../src/fs/types.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

/** Stand-in for a bridge-backed mount holding one "packfile". */
class FakePackBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///fake';
  readonly mountId: string;
  /** Every whole-file read this backend was asked for. */
  readonly wholeReads: string[] = [];
  /** Every window this backend was asked for, when it supports them. */
  readonly ranges: [string, number, number][] = [];

  constructor(
    private readonly files: Record<string, Uint8Array>,
    private readonly supportsRanges: boolean,
    mountId: string
  ) {
    this.mountId = mountId;
    if (supportsRanges) {
      this.readFileRange = async (path: string, start: number, end: number) => {
        this.ranges.push([path, start, end]);
        return this.bytes(path).slice(start, end);
      };
    }
  }

  readFileRange?: (path: string, start: number, end: number) => Promise<Uint8Array>;

  private bytes(path: string): Uint8Array {
    const body = this.files[path];
    if (!body) throw new FsError('ENOENT', 'no such file', path);
    return body;
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    if (path !== '') return [];
    return Object.entries(this.files).map(([name, body]) => ({
      name,
      kind: 'file' as const,
      size: body.byteLength,
    }));
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.wholeReads.push(path);
    return this.bytes(path);
  }

  async writeFile(): Promise<void> {
    throw new FsError('EACCES', 'read-only fake', '');
  }

  async stat(path: string): Promise<MountStat> {
    return { kind: 'file', size: this.bytes(path).byteLength, mtime: 0 };
  }

  async mkdir(): Promise<void> {}

  async remove(): Promise<void> {}

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'fake', source: this.source };
  }

  /** `VirtualFS.mount` records this for every `hostfs` backend. */
  getHostPath(): string {
    return '/fake';
  }

  async close(): Promise<void> {}
}

/** 0,1,2,…,63 — enough to tell a window apart from the whole file. */
const PACK = new Uint8Array(64).map((_, i) => i);

let dbCounter = 0;
let vfs: VirtualFS;

async function mountPack(supportsRanges: boolean): Promise<FakePackBackend> {
  const backend = new FakePackBackend({ 'big.pack': PACK }, supportsRanges, `range-${dbCounter}`);
  await vfs.mkdir('/mnt', { recursive: true });
  await vfs.mount('/mnt', backend);
  return backend;
}

beforeEach(async () => {
  vfs = await VirtualFS.create({ dbName: `test-adapter-range-${dbCounter++}`, wipe: true });
});

describe('isomorphic-git fs adapter — ranged reads', () => {
  it('turns readFile(path, {start,end}) into a window and never reads the whole body', async () => {
    const backend = await mountPack(true);
    const fs = createIsomorphicGitFs(vfs).promises;

    const window = await fs.readFile('/mnt/big.pack', { start: 16, end: 24 });

    expect(window).toEqual(PACK.slice(16, 24));
    expect(backend.ranges).toEqual([['big.pack', 16, 24]]);
    // The point of the whole change: the 92 MB pack never lands in memory.
    expect(backend.wholeReads).toEqual([]);
  });

  it('still reads the whole file when no window is given', async () => {
    const backend = await mountPack(true);
    const fs = createIsomorphicGitFs(vfs).promises;

    await expect(fs.readFile('/mnt/big.pack')).resolves.toEqual(PACK);
    expect(backend.ranges).toEqual([]);
    expect(backend.wholeReads).toEqual(['big.pack']);
  });

  it('ignores a half-specified window rather than guessing an end', async () => {
    const backend = await mountPack(true);
    const fs = createIsomorphicGitFs(vfs).promises;

    await expect(fs.readFile('/mnt/big.pack', { start: 8 })).resolves.toEqual(PACK);
    expect(backend.ranges).toEqual([]);
  });

  it('a window beats an encoding — a pack slice is bytes, not text', async () => {
    await mountPack(true);
    const fs = createIsomorphicGitFs(vfs).promises;

    const window = await fs.readFile('/mnt/big.pack', { encoding: 'utf8', start: 0, end: 4 });
    expect(window).toBeInstanceOf(Uint8Array);
    expect(window).toEqual(PACK.slice(0, 4));
  });
});

describe('VirtualFS.readFileRange', () => {
  it('falls back to read-and-slice for a backend with no native range', async () => {
    const backend = await mountPack(false);

    await expect(vfs.readFileRange('/mnt/big.pack', 4, 7)).resolves.toEqual(PACK.slice(4, 7));
    // Correct, just not cheap — the fallback exists so callers never branch.
    expect(backend.wholeReads).toEqual(['big.pack']);
  });

  it('reads a window of an unmounted VFS file', async () => {
    await vfs.writeFile('/local.bin', PACK);
    await expect(vfs.readFileRange('/local.bin', 60, 64)).resolves.toEqual(PACK.slice(60, 64));
  });

  it('clamps a window that runs past the end of the file', async () => {
    await vfs.writeFile('/local.bin', PACK);
    await expect(vfs.readFileRange('/local.bin', 62, 999)).resolves.toEqual(PACK.slice(62));
  });

  it('returns empty for a zero-length window without reading anything', async () => {
    const backend = await mountPack(true);
    await expect(vfs.readFileRange('/mnt/big.pack', 9, 9)).resolves.toEqual(new Uint8Array(0));
    expect(backend.ranges).toEqual([]);
    expect(backend.wholeReads).toEqual([]);
  });

  it('rejects a descending or fractional window with EINVAL', async () => {
    await mountPack(true);
    await expect(vfs.readFileRange('/mnt/big.pack', 8, 2)).rejects.toMatchObject({
      code: 'EINVAL',
    });
    await expect(vfs.readFileRange('/mnt/big.pack', -1, 4)).rejects.toMatchObject({
      code: 'EINVAL',
    });
    await expect(vfs.readFileRange('/mnt/big.pack', 0, 2.5)).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });

  it('rebrands a backend failure onto the full VFS path', async () => {
    await mountPack(true);
    await expect(vfs.readFileRange('/mnt/missing.pack', 0, 4)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
