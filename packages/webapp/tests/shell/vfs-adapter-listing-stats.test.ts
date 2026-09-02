/**
 * `ls -l` over a mount costs one listing, not one round trip per entry —
 * issue #2716.
 *
 * just-bash's `DirentEntry` carries no size, so `ls -l` is a `readdir`
 * followed by a `stat` per name (and `du` an `lstat` per name). Over a hostfs
 * mount each of those was a bridge request for numbers the `list` response
 * already carried — a 91-entry directory cost 91 of them.
 *
 * The counting backend asserts REQUESTS; the values are asserted against what
 * an uncached stat returns, because a faster wrong answer is not a fix.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  RefreshReport,
} from '../../src/fs/mount/backend.js';
import { FsError } from '../../src/fs/types.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

let dbCounter = 0;

/** Stands in for the hostfs bridge, counting every list and stat. */
class CountingBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///counting';
  readonly mountId = 'counting-shell-backend';
  /** Its listing numbers are what its stat reports — see #2716. */
  readonly listingStatsMatchStat = true;
  lists = 0;
  stats = 0;

  constructor(protected readonly files: Map<string, { size: number; mtime: number }>) {}

  /** Subclass access to the fixture without widening `files` to public. */
  protected entries(): Iterable<[string, { size: number; mtime: number }]> {
    return this.files;
  }

  reset(): void {
    this.lists = 0;
    this.stats = 0;
  }

  async readDir(_path: string): Promise<MountDirEntry[]> {
    this.lists++;
    return [...this.files].map(([name, f]) => ({
      name,
      kind: 'file' as const,
      size: f.size,
      lastModified: f.mtime,
      ctime: f.mtime,
      ino: 700 + name.length,
      uid: 501,
      gid: 20,
      mode: 0o100644,
    }));
  }

  async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async writeFile(): Promise<void> {}

  async stat(path: string): Promise<MountStat> {
    this.stats++;
    const name = path.replace(/^\/+/, '');
    const file = this.files.get(name);
    if (!file) throw new FsError('ENOENT', 'no such file', path);
    return {
      kind: 'file',
      size: file.size,
      mtime: file.mtime,
      ctime: file.mtime,
      ino: 700 + name.length,
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

/**
 * Same counting contract, but path-aware: it holds a `d<N>/f<M>.txt` tree so
 * a walk can list many directories in a row.
 */
class TreeBackend extends CountingBackend {
  override async readDir(path: string): Promise<MountDirEntry[]> {
    this.lists++;
    const dir = path.replace(/^\/+|\/+$/g, '');
    const prefix = dir === '' ? '' : `${dir}/`;
    const out: MountDirEntry[] = [];
    for (const [rel, f] of this.entries()) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      if (rest === '' || rest.includes('/')) continue;
      out.push({
        name: rest,
        kind: 'file',
        size: f.size,
        lastModified: f.mtime,
        ctime: f.mtime,
        ino: 700 + rel.length,
        uid: 501,
        gid: 20,
        mode: 0o100644,
      });
    }
    return out;
  }
}

describe('VfsAdapter listing-primed stats (#2716)', () => {
  let vfs: VirtualFS;
  let adapter: VfsAdapter;
  let backend: CountingBackend;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `vfs-adapter-listing-${dbCounter++}`, wipe: true });
    adapter = new VfsAdapter(vfs);
    backend = new CountingBackend(
      new Map([
        ['a.txt', { size: 11, mtime: 1_700_000_000_000 }],
        ['b.txt', { size: 22, mtime: 1_700_000_100_000 }],
        ['c.txt', { size: 33, mtime: 1_700_000_200_000 }],
      ])
    );
    await vfs.mkdir('/mnt/host', { recursive: true });
    await vfs.mount('/mnt/host', backend);
  });

  /** What `ls -l` does: one readdir, then a stat per name. */
  async function lsLong(dir: string): Promise<{ name: string; size: number; mtime: number }[]> {
    const names = await adapter.readdir(dir);
    const rows = [];
    for (const name of names) {
      const stat = await adapter.stat(`${dir}/${name}`);
      rows.push({ name, size: stat.size, mtime: stat.mtime.getTime() });
    }
    return rows;
  }

  it('stats nothing over the bridge for an `ls -l`', async () => {
    backend.reset();
    const rows = await lsLong('/mnt/host');

    expect(rows).toEqual([
      { name: 'a.txt', size: 11, mtime: 1_700_000_000_000 },
      { name: 'b.txt', size: 22, mtime: 1_700_000_100_000 },
      { name: 'c.txt', size: 33, mtime: 1_700_000_200_000 },
    ]);
    expect(backend.lists).toBe(1);
    expect(backend.stats).toBe(0);
  });

  it('answers exactly what the stat it replaced would have', async () => {
    const uncached = await adapter.stat('/mnt/host/a.txt');
    await adapter.readdir('/mnt/host');
    backend.reset();
    const cached = await adapter.stat('/mnt/host/a.txt');

    expect(backend.stats).toBe(0);
    expect(cached).toEqual(uncached);
  });

  it('serves `du`’s lstat from the same listing', async () => {
    await adapter.readdirWithFileTypes('/mnt/host');
    backend.reset();
    const stat = await adapter.lstat('/mnt/host/b.txt');

    expect(backend.stats).toBe(0);
    expect(stat.size).toBe(22);
    expect(stat.isSymbolicLink).toBe(false);
  });

  it('goes back to the bridge once the listing is older than the TTL', async () => {
    vi.useFakeTimers();
    try {
      await adapter.readdir('/mnt/host');
      backend.reset();
      vi.advanceTimersByTime(1001);
      await adapter.stat('/mnt/host/a.txt');
      expect(backend.stats).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the listing as soon as the shell writes', async () => {
    await adapter.readdir('/mnt/host');
    await adapter.writeFile('/mnt/host/a.txt', 'rewritten');
    backend.reset();

    await adapter.stat('/mnt/host/b.txt');

    // Blunt on purpose: a write invalidates the whole table, not one path.
    expect(backend.stats).toBe(1);
  });

  it('still stats a path no listing reported', async () => {
    await adapter.readdir('/mnt/host');
    backend.reset();

    await expect(adapter.stat('/mnt/host/never-listed.txt')).rejects.toThrow();

    // Nothing is invented for a name the listing did not carry.
    expect(backend.stats).toBe(1);
  });

  it('keeps lstat and stat apart for a symlink', async () => {
    // The listing path never caches a symlink, so these two must still
    // disagree: lstat describes the link, stat follows it.
    await vfs.writeFile('/target.txt', 'target\n');
    await vfs.symlink('/target.txt', '/link.txt');

    await adapter.readdir('/');
    const link = await adapter.lstat('/link.txt');
    const target = await adapter.stat('/link.txt');

    expect(link.isSymbolicLink).toBe(true);
    expect(target.isFile).toBe(true);
    expect(target.size).toBe(7);
  });
});

/**
 * The TTL bounds how long an entry may be REUSED, not how long it is
 * RETAINED — expiry is only noticed when that exact path is looked up again.
 * Without a cap, an `ls -R` / `du -sh` over a big mount would pile every
 * directory it ever walked into a map that lives as long as the shell.
 */
describe('VfsAdapter listing cache stays bounded (#2716)', () => {
  let vfs: VirtualFS;
  let dbId = 0;

  /** A mount whose directories each hold `perDir` measurable files. */
  async function mountTree(dirs: number, perDir: number): Promise<CountingBackend> {
    const files = new Map<string, { size: number; mtime: number }>();
    for (let d = 0; d < dirs; d++) {
      for (let f = 0; f < perDir; f++) {
        files.set(`d${d}/f${f}.txt`, { size: f + 1, mtime: 1_700_000_000_000 + f });
      }
    }
    const backend = new TreeBackend(files);
    await vfs.mkdir('/mnt/tree', { recursive: true });
    await vfs.mount('/mnt/tree', backend);
    return backend;
  }

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `vfs-adapter-bounded-${dbId++}`, wipe: true });
  });

  it('never retains more than the cap while walking a big tree', async () => {
    const adapter = new VfsAdapter(vfs, { listingStatsMax: 10 });
    await mountTree(20, 4);

    for (let d = 0; d < 20; d++) {
      await adapter.readdir(`/mnt/tree/d${d}`);
      expect(adapter.listingStatsSize).toBeLessThanOrEqual(10);
    }

    // 80 entries walked, at most one cap's worth retained.
    expect(adapter.listingStatsSize).toBeLessThanOrEqual(10);
  });

  it('primes nothing for a single listing bigger than the cap', async () => {
    const adapter = new VfsAdapter(vfs, { listingStatsMax: 3 });
    const backend = await mountTree(1, 8);

    await adapter.readdir('/mnt/tree/d0');

    // Clearing to "make room" and then inserting anyway would leave 8
    // entries behind — i.e. no cap for exactly the directory that needs one.
    expect(adapter.listingStatsSize).toBe(0);
    backend.reset();
    await adapter.stat('/mnt/tree/d0/f0.txt');
    expect(backend.stats).toBe(1);
  });

  it('sweeps entries that expired while other directories were listed', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new VfsAdapter(vfs, { listingStatsMax: 1000, listingStatsTtlMs: 1000 });
      await mountTree(3, 4);

      await adapter.readdir('/mnt/tree/d0');
      expect(adapter.listingStatsSize).toBe(4);
      vi.advanceTimersByTime(1001);

      // Priming an unrelated directory evicts what expired, instead of
      // waiting for someone to look d0's entries up again.
      await adapter.readdir('/mnt/tree/d1');
      expect(adapter.listingStatsSize).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps live entries when it sweeps', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new VfsAdapter(vfs, { listingStatsMax: 1000, listingStatsTtlMs: 1000 });
      const backend = await mountTree(2, 2);

      await adapter.readdir('/mnt/tree/d0');
      vi.advanceTimersByTime(500);
      await adapter.readdir('/mnt/tree/d1');
      expect(adapter.listingStatsSize).toBe(4);
      backend.reset();

      // Both listings are still inside the TTL, so neither costs a stat.
      await adapter.stat('/mnt/tree/d0/f0.txt');
      await adapter.stat('/mnt/tree/d1/f0.txt');
      expect(backend.stats).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
