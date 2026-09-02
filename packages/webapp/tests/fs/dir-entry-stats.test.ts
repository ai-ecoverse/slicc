/**
 * `readDir` carries the stat fields the backend already paid for — issue #2716.
 *
 * `/api/hostfs/list` stats every dirent server-side, so `size`/`lastModified`
 * (plus the #2708 identity fields) arrive with the listing. VirtualFS used to
 * drop everything but `{name, type}`, which is what forced every consumer to
 * re-stat each entry it had just listed: one bridge round trip per file.
 *
 * These tests pin the plumbing (mount slow path, local async path, local sync
 * path) and the one rule that decides whether a listing may stand in for a
 * stat at all — `statsFromDirEntry`.
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
import { FsError, statsFromDirEntry } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';

let dbCounter = 0;

/** A bridge-shaped mount: full stat fields for files, bare names for dirs. */
class ListingBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///listing';
  readonly mountId = 'listing-backend';
  readonly listingStatsMatchStat: boolean;

  constructor(
    private readonly entries: MountDirEntry[],
    listingStatsMatchStat = true
  ) {
    this.listingStatsMatchStat = listingStatsMatchStat;
  }

  async readDir(): Promise<MountDirEntry[]> {
    return this.entries;
  }

  async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async writeFile(): Promise<void> {}

  async stat(path: string): Promise<MountStat> {
    const name = path.replace(/^\/+/, '');
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return { kind: entry.kind, size: entry.size ?? 0, mtime: entry.lastModified ?? 0 };
  }

  async mkdir(): Promise<void> {}

  async remove(): Promise<void> {}

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'listing' };
  }

  async close(): Promise<void> {}

  getHostPath(): string {
    return '/listing';
  }
}

describe('statsFromDirEntry', () => {
  it('promotes a fully reported entry to the stats a stat() would return', () => {
    const stats = statsFromDirEntry({
      name: 'a.txt',
      type: 'file',
      size: 12,
      mtime: 1_700_000_000_000,
      ctime: 1_700_000_500_000,
      ino: 42,
      uid: 501,
      gid: 20,
      mode: 0o100755,
    });
    expect(stats).toEqual({
      type: 'file',
      size: 12,
      mtime: 1_700_000_000_000,
      ctime: 1_700_000_500_000,
      ino: 42,
      uid: 501,
      gid: 20,
      mode: 0o100755,
    });
  });

  it('falls ctime back to mtime, as VirtualFS.stat does for an inode-less backend', () => {
    expect(statsFromDirEntry({ name: 'a', type: 'file', size: 1, mtime: 7 })?.ctime).toBe(7);
  });

  it('refuses an entry the listing only half described', () => {
    // What the bridge sends for a raced entry it could not stat: name + kind.
    expect(statsFromDirEntry({ name: 'gone', type: 'file' })).toBeUndefined();
    expect(statsFromDirEntry({ name: 'partial', type: 'file', size: 3 })).toBeUndefined();
    expect(statsFromDirEntry({ name: 'partial', type: 'file', mtime: 3 })).toBeUndefined();
  });

  it('refuses a symlink — the listing describes the link, stat() the target', () => {
    expect(
      statsFromDirEntry({ name: 'link', type: 'symlink', size: 9, mtime: 1, ino: 3 })
    ).toBeUndefined();
  });
});

describe('VirtualFS.readDir carries listing stats (#2716)', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `dir-entry-stats-${dbCounter++}`, wipe: true });
  });

  it('passes a mount listing’s size, mtime and identity fields through', async () => {
    await vfs.mkdir('/mnt/host', { recursive: true });
    await vfs.mount(
      '/mnt/host',
      new ListingBackend([
        {
          name: 'script.sh',
          kind: 'file',
          size: 10,
          lastModified: 1_700_000_000_000,
          ctime: 1_700_000_500_000,
          ino: 987_654,
          uid: 501,
          gid: 20,
          mode: 0o100755,
        },
        // A directory: the bridge sends nothing but the name and kind.
        { name: 'sub', kind: 'directory' },
      ])
    );

    const entries = await vfs.readDir('/mnt/host');
    const script = entries.find((e) => e.name === 'script.sh');
    expect(script).toEqual({
      name: 'script.sh',
      type: 'file',
      size: 10,
      mtime: 1_700_000_000_000,
      ctime: 1_700_000_500_000,
      ino: 987_654,
      uid: 501,
      gid: 20,
      mode: 0o100755,
    });
    // Nothing is invented for what the backend did not report.
    expect(entries.find((e) => e.name === 'sub')).toEqual({ name: 'sub', type: 'directory' });
  });

  // #2716 / review: S3 answers `stat` from its body cache (`mtime` is
  // `cachedAt`, not the object's mtime) and AEM reports the DECODED size
  // there while its listing carries the stored one. A consumer using a
  // listing in place of a stat would silently get a different number, so
  // those backends do not opt in and their listings stay bare.
  it('drops the listing fields for a backend whose listing and stat disagree', async () => {
    await vfs.mkdir('/mnt/remote', { recursive: true });
    await vfs.mount(
      '/mnt/remote',
      new ListingBackend(
        [{ name: 'page.html', kind: 'file', size: 512, lastModified: 1_700_000_000_000 }],
        false
      )
    );

    const [entry] = await vfs.readDir('/mnt/remote');
    expect(entry).toEqual({ name: 'page.html', type: 'file' });
    // …and the consumer rule agrees: nothing to promote, so it stats.
    expect(statsFromDirEntry(entry!)).toBeUndefined();
  });

  it('reports the local filesystem’s own size, mtime and inode', async () => {
    await vfs.mkdir('/dir');
    await vfs.writeFile('/dir/hello.txt', 'hello\n');
    const [entry] = await vfs.readDir('/dir');
    expect(entry?.size).toBe(6);
    expect(entry?.mtime).toBeGreaterThan(0);
    expect(entry?.ctime).toBeGreaterThan(0);
    expect(entry?.ino).toBeGreaterThan(0);
    expect(entry?.mode).toBeGreaterThan(0);
    // The listing agrees with a stat of the same path — the invariant every
    // consumer of these fields depends on.
    const stats = await vfs.stat('/dir/hello.txt');
    expect(statsFromDirEntry(entry!)).toEqual(expect.objectContaining({ size: stats.size }));
    expect(entry?.mtime).toBe(stats.mtime);
    expect(entry?.ino).toBe(stats.ino);
  });

  it('leaves a local symlink entry bare', async () => {
    await vfs.writeFile('/target.txt', 'target\n');
    await vfs.symlink('/target.txt', '/link.txt');
    const link = (await vfs.readDir('/')).find((e) => e.name === 'link.txt');
    expect(link).toEqual({ name: 'link.txt', type: 'symlink' });
  });

  it('carries the same fields on the synchronous fast path', async () => {
    await vfs.mkdir('/sync');
    await vfs.writeFile('/sync/a.txt', 'abc');
    await vfs.symlink('/sync/a.txt', '/sync/link');
    const entries = vfs.readDirSync('/sync');
    // The memory backend supports sync ops; OPFS returns null and callers
    // fall back to the async path, which is covered above.
    expect(entries).not.toBeNull();
    const file = entries?.find((e) => e.name === 'a.txt');
    expect(file?.size).toBe(3);
    expect(file?.mtime).toBeGreaterThan(0);
    expect(entries?.find((e) => e.name === 'link')).toEqual({ name: 'link', type: 'symlink' });
  });
});
