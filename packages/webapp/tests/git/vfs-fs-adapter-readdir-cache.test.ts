/**
 * The isomorphic-git adapter answers a stat from the listing it just read —
 * issue #2716.
 *
 * `FileSystem.readdirDeep` (what `git branch` walks `refs/` with) stats every
 * name it lists to decide whether to recurse, and `GitWalkerFs` lstats every
 * workdir entry. Over a hostfs mount that is one bridge round trip per entry
 * for metadata the `list` response already carried: `git branch` cost 125
 * requests for 29 refs, 100 of them stats.
 *
 * The counting backend below is the whole point of these tests — they assert
 * REQUESTS, not values. Value fidelity (#2708) is pinned by
 * `vfs-fs-adapter-stats.test.ts`; what must not regress here is that a cached
 * answer is byte-identical to the stat it replaced.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from '../../src/fs/mount/backend.js';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

/** One host entry as the bridge would report it. */
interface HostEntry {
  kind: 'file' | 'directory';
  size?: number;
  mtime?: number;
}

/**
 * Stands in for the hostfs bridge: every `list`/`stat` is a request, and the
 * listing carries exactly what `/api/hostfs/list` carries — full stats for a
 * file it could stat, name + kind for a directory.
 */
class CountingBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///counting';
  readonly mountId = 'counting-backend';
  /** Its listing numbers are what its stat reports — see #2716. */
  readonly listingStatsMatchStat = true;
  lists = 0;
  stats = 0;
  reads = 0;
  rangedReads = 0;

  constructor(private readonly tree: Map<string, HostEntry>) {}

  reset(): void {
    this.lists = 0;
    this.stats = 0;
    this.reads = 0;
    this.rangedReads = 0;
  }

  private entryStat(rel: string, entry: HostEntry): MountDirEntry {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (entry.kind === 'directory') return { name, kind: 'directory' };
    // A file the bridge could not stat comes back as a bare name + kind.
    if (entry.size === undefined || entry.mtime === undefined) return { name, kind: 'file' };
    return {
      name,
      kind: 'file',
      size: entry.size,
      lastModified: entry.mtime,
      ctime: entry.mtime,
      ino: 1000 + rel.length,
      uid: 501,
      gid: 20,
      mode: 0o100644,
    };
  }

  async readDir(path: string): Promise<MountDirEntry[]> {
    this.lists++;
    const dir = path.replace(/^\/+|\/+$/g, '');
    const prefix = dir === '' || dir === '/' ? '' : `${dir}/`;
    const entries: MountDirEntry[] = [];
    for (const [rel, entry] of this.tree) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      entries.push(this.entryStat(rel, entry));
    }
    return entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.reads++;
    const rel = path.replace(/^\/+/, '');
    const entry = this.tree.get(rel);
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return new Uint8Array(entry.size ?? 0).fill(7);
  }

  /** #2752: a window over the same bytes, without pulling the whole file. */
  async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    this.rangedReads++;
    return (await this.readFile(path)).subarray(start, end);
  }

  async writeFile(): Promise<void> {}

  async stat(path: string): Promise<MountStat> {
    this.stats++;
    const rel = path.replace(/^\/+/, '');
    const entry = this.tree.get(rel);
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    if (entry.kind === 'directory') return { kind: 'directory', size: 0, mtime: entry.mtime ?? 0 };
    return {
      kind: 'file',
      size: entry.size ?? 0,
      mtime: entry.mtime ?? 0,
      ctime: entry.mtime ?? 0,
      ino: 1000 + rel.length,
      uid: 501,
      gid: 20,
      mode: 0o100644,
    };
  }

  async mkdir(): Promise<void> {}

  async remove(): Promise<void> {}

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'counting' };
  }

  async close(): Promise<void> {}

  getHostPath(): string {
    return '/counting';
  }
}

/** `FileSystem.readdirDeep` — list a directory, then stat each name. */
async function readdirDeep(
  fs: {
    readdir(p: string): Promise<string[]>;
    stat(p: string): Promise<{ isDirectory(): boolean }>;
  },
  dir: string
): Promise<string[]> {
  const names = await fs.readdir(dir);
  const nested = await Promise.all(
    names.map(async (name) => {
      const child = `${dir}/${name}`;
      return (await fs.stat(child)).isDirectory() ? readdirDeep(fs, child) : [child];
    })
  );
  return nested.flat();
}

describe('isomorphic-git adapter readdir-primed stat cache (#2716)', () => {
  let vfs: VirtualFS;
  let backend: CountingBackend;

  /** A `refs/heads` shaped tree: two ref files plus a nested namespace. */
  async function mountRefs(): Promise<void> {
    backend = new CountingBackend(
      new Map<string, HostEntry>([
        ['main', { kind: 'file', size: 41, mtime: 1_700_000_000_000 }],
        ['next', { kind: 'file', size: 41, mtime: 1_700_000_100_000 }],
        ['feature', { kind: 'directory' }],
        ['feature/one', { kind: 'file', size: 41, mtime: 1_700_000_200_000 }],
        ['feature/two', { kind: 'file', size: 41, mtime: 1_700_000_300_000 }],
      ])
    );
    await vfs.mkdir('/mnt/refs', { recursive: true });
    await vfs.mount('/mnt/refs', backend);
  }

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `readdir-cache-${dbCounter++}`, wipe: true });
  });

  it('walks a listed tree with zero stat requests', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    backend.reset();

    const files = await readdirDeep(client.promises, '/mnt/refs');

    expect(files.sort()).toEqual([
      '/mnt/refs/feature/one',
      '/mnt/refs/feature/two',
      '/mnt/refs/main',
      '/mnt/refs/next',
    ]);
    // One list per directory — and not a single stat, where the walk used to
    // spend one round trip per entry.
    expect(backend.lists).toBe(2);
    expect(backend.stats).toBe(0);
  });

  it('answers exactly what the stat it replaced would have', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    const uncached = await client.promises.lstat('/mnt/refs/main');
    client.clearStatCache();
    backend.reset();

    await client.promises.readdir('/mnt/refs');
    const cached = await client.promises.lstat('/mnt/refs/main');

    expect(backend.stats).toBe(0);
    // Everything `compareStats` looks at (#2708) survives the shortcut.
    expect(cached.size).toBe(uncached.size);
    expect(cached.mtimeMs).toBe(uncached.mtimeMs);
    expect(cached.ctimeMs).toBe(uncached.ctimeMs);
    expect(cached.ino).toBe(uncached.ino);
    expect(cached.uid).toBe(uncached.uid);
    expect(cached.gid).toBe(uncached.gid);
    expect(cached.mode).toBe(uncached.mode);
    expect(cached.isFile()).toBe(true);
  });

  it('does not answer for an entry the listing only half described', async () => {
    // A raced entry: the bridge could not stat it, so it sent name + kind.
    backend = new CountingBackend(new Map([['racy', { kind: 'file' as const }]]));
    await vfs.mkdir('/mnt/racy', { recursive: true });
    await vfs.mount('/mnt/racy', backend);
    const client = createIsomorphicGitFs(vfs);
    backend.reset();

    await client.promises.readdir('/mnt/racy');
    await client.promises.stat('/mnt/racy/racy');

    // Zeroed placeholders are what make compareStats call a file stale
    // forever (#2708) — a half-known entry must cost a real stat.
    expect(backend.stats).toBe(1);
  });

  it('clears between git commands', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    await client.promises.readdir('/mnt/refs');
    client.clearStatCache();
    backend.reset();

    await client.promises.stat('/mnt/refs/main');

    expect(backend.stats).toBe(1);
  });

  it('drops a path it wrote through', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    await client.promises.readdir('/mnt/refs');
    backend.reset();

    await client.promises.writeFile('/mnt/refs/main', 'deadbeef\n');
    const afterWrite = backend.stats;
    await client.promises.stat('/mnt/refs/main');

    // The write dropped the primed entry, so the stat goes to the bridge.
    expect(backend.stats).toBe(afterWrite + 1);
  });

  it('normalizes cache keys, so a differently spelled path still hits', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    backend.reset();

    await client.promises.readdir('/mnt/refs/');
    await client.promises.stat('/mnt/refs//main');
    await client.promises.stat('/mnt/refs/feature/../main');

    expect(backend.stats).toBe(0);
  });

  it('never answers a local symlink from the listing', async () => {
    await vfs.writeFile('/target.txt', 'target\n');
    await vfs.symlink('/target.txt', '/link.txt');
    const client = createIsomorphicGitFs(vfs);

    await client.promises.readdir('/');
    const link = await client.promises.lstat('/link.txt');
    const target = await client.promises.stat('/link.txt');

    // lstat sees the link, stat follows it — a single cached answer could
    // not be both.
    expect(link.isSymbolicLink()).toBe(true);
    expect(target.isFile()).toBe(true);
    expect(target.size).toBe(7);
  });

  it('caps what it retains, dropping the oldest listing rather than growing', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs, { statCacheMax: 3 });

    await client.promises.readdir('/mnt/refs/feature'); // 2 files
    await client.promises.readdir('/mnt/refs'); // 2 files + 1 dir
    expect(client.statCacheSize()).toBeLessThanOrEqual(3);
  });

  it('primes nothing for a single listing bigger than the cap', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs, { statCacheMax: 2 });
    backend.reset();

    await client.promises.readdir('/mnt/refs'); // 3 entries > cap of 2

    // Clearing to "make room" and then inserting everything anyway would
    // leave 3 entries behind — no cap for exactly the directory needing one.
    expect(client.statCacheSize()).toBe(0);
    await client.promises.stat('/mnt/refs/main');
    expect(backend.stats).toBe(1);
  });

  // #2752 wired `readFile(path, {start, end})` through to the backend's
  // ranged read. A read is not a write: it must neither invalidate what a
  // listing primed nor leave anything behind for a path it never described.
  it('leaves the stat cache alone across a ranged read', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    await client.promises.readdir('/mnt/refs');
    const before = await client.promises.stat('/mnt/refs/main');
    backend.reset();

    const slice = await client.promises.readFile('/mnt/refs/main', { start: 4, end: 12 });

    expect(slice).toBeInstanceOf(Uint8Array);
    expect((slice as Uint8Array).byteLength).toBe(8);
    expect(backend.rangedReads).toBe(1);
    // Still primed, still the same answer — the read went around the cache,
    // not through it.
    const after = await client.promises.stat('/mnt/refs/main');
    expect(backend.stats).toBe(0);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it('does not let a ranged read stand in for a stat', async () => {
    await mountRefs();
    const client = createIsomorphicGitFs(vfs);
    backend.reset();

    // Nothing listed this path in this command, so reading part of it must
    // not conjure metadata for it.
    await client.promises.readFile('/mnt/refs/main', { start: 0, end: 4 });
    await client.promises.stat('/mnt/refs/main');

    expect(backend.stats).toBe(1);
  });

  it('caches local listings too, and keeps them honest', async () => {
    await vfs.mkdir('/local');
    await vfs.writeFile('/local/a.txt', 'abc');
    const client = createIsomorphicGitFs(vfs);

    const direct = await client.promises.lstat('/local/a.txt');
    client.clearStatCache();
    await client.promises.readdir('/local');
    const primed = await client.promises.lstat('/local/a.txt');

    expect(primed.size).toBe(direct.size);
    expect(primed.mtimeMs).toBe(direct.mtimeMs);
    expect(primed.ino).toBe(direct.ino);
    expect(primed.mode).toBe(direct.mode);
  });
});
