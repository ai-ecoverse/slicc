/**
 * Stat fidelity of the isomorphic-git adapter — issue #2708.
 *
 * isomorphic-git's `compareStats` calls a working-tree file stale unless
 * mode, mtime, ctime, uid, gid, ino AND size all match what the index
 * recorded. The adapter used to synthesize `ino: 0`, `uid: 1`, `gid: 1`, a
 * constant mode `100644` and `ctime = mtime`, so the comparison could never
 * hit for a repo whose index system git had written — every read-only
 * command re-hashed the whole tree (and, before the `refresh: false` fix,
 * rewrote `.git/index` once per file).
 *
 * These tests pin the pass-through: real values when the filesystem reports
 * them, the historical placeholders when it does not.
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
import { createCommandScopedReadCache } from '../../src/git/fs-command-cache.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';

let dbCounter = 0;

/** In-memory stand-in for a bridge-backed mount, with a per-file stat table. */
class FakeStatBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///fake';
  readonly mountId = 'fake-stat-backend';
  statCalls = 0;

  constructor(
    private readonly files: Map<string, { body: string; stat: MountStat }>,
    private readonly includeListingMetadata = true
  ) {}

  async readDir(path: string): Promise<MountDirEntry[]> {
    const prefix = path.replace(/^\/+|\/+$/g, '');
    const entries: MountDirEntry[] = [];
    for (const [name, entry] of this.files) {
      if (prefix.length > 0 && !name.startsWith(`${prefix}/`)) continue;
      const entryName = name.slice(prefix.length > 0 ? prefix.length + 1 : 0);
      if (!this.includeListingMetadata) {
        entries.push({ name: entryName, kind: entry.stat.kind });
        continue;
      }
      const { kind, size, mtime, ctime, ino, uid, gid, mode } = entry.stat;
      entries.push({
        name: entryName,
        kind,
        size,
        lastModified: mtime,
        ...(ctime !== undefined ? { ctime } : {}),
        ...(ino !== undefined ? { ino } : {}),
        ...(uid !== undefined ? { uid } : {}),
        ...(gid !== undefined ? { gid } : {}),
        ...(mode !== undefined ? { mode } : {}),
      });
    }
    return entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.files.get(path.replace(/^\/+/, ''));
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return new TextEncoder().encode(entry.body);
  }

  async writeFile(): Promise<void> {
    throw new FsError('EACCES', 'read-only fake');
  }

  async stat(path: string): Promise<MountStat> {
    this.statCalls += 1;
    const entry = this.files.get(path.replace(/^\/+/, ''));
    if (!entry) throw new FsError('ENOENT', 'no such file', path);
    return entry.stat;
  }

  async mkdir(): Promise<void> {}

  async remove(): Promise<void> {}

  async refresh(): Promise<RefreshReport> {
    return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
  }

  describe(): MountDescription {
    return { displayName: 'fake' };
  }

  async close(): Promise<void> {}

  /** `VirtualFS.mount` builds a hostfs descriptor from this. */
  getHostPath(): string {
    return '/fake';
  }
}

describe('isomorphic-git adapter stats (issue #2708)', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `adapter-stats-${dbCounter++}`, wipe: true });
  });

  it('carries mount listing metadata through DirEntry and primes command-scoped stats', async () => {
    const files = new Map([
      [
        'script.sh',
        {
          body: '#!/bin/sh\n',
          stat: {
            kind: 'file' as const,
            size: 10,
            mtime: 1_700_000_000_000,
            ctime: 1_700_000_500_000,
            ino: 987_654,
            uid: 501,
            gid: 20,
            mode: 0o100755,
          },
        },
      ],
    ]);
    const backend = new FakeStatBackend(files);
    await vfs.mkdir('/mnt/host', { recursive: true });
    await vfs.mount('/mnt/host', backend);

    await expect(vfs.readDir('/mnt/host')).resolves.toEqual([
      {
        name: 'script.sh',
        type: 'file',
        size: 10,
        mtime: 1_700_000_000_000,
        ctime: 1_700_000_500_000,
        ino: 987_654,
        uid: 501,
        gid: 20,
        mode: 0o100755,
      },
    ]);

    const fs = createCommandScopedReadCache(createIsomorphicGitFs(vfs).promises);
    await fs.readdir('/mnt/host');
    const stats = await fs.lstat('/mnt/host/script.sh');
    expect(stats).toMatchObject({ size: 10, mtimeMs: 1_700_000_000_000, ino: 987_654 });
    expect(backend.statCalls).toBe(0);
  });

  it('falls back to lstat when a directory listing omits metadata', async () => {
    const files = new Map([
      [
        'plain.txt',
        {
          body: 'hi\n',
          stat: { kind: 'file' as const, size: 3, mtime: 1_700_000_000_000 },
        },
      ],
    ]);
    const backend = new FakeStatBackend(files, false);
    await vfs.mkdir('/mnt/legacy', { recursive: true });
    await vfs.mount('/mnt/legacy', backend);

    const fs = createCommandScopedReadCache(createIsomorphicGitFs(vfs).promises);
    await fs.readdir('/mnt/legacy');
    const stats = await fs.lstat('/mnt/legacy/plain.txt');
    expect(stats).toMatchObject({ size: 3, mtimeMs: 1_700_000_000_000 });
    expect(backend.statCalls).toBe(1);
  });

  it('passes a mount backend’s ctime, ino, uid, gid and mode straight through', async () => {
    const files = new Map([
      [
        'script.sh',
        {
          body: '#!/bin/sh\n',
          stat: {
            kind: 'file' as const,
            size: 10,
            mtime: 1_700_000_000_000,
            ctime: 1_700_000_500_000,
            ino: 987_654,
            uid: 501,
            gid: 20,
            mode: 0o100755,
          },
        },
      ],
    ]);
    await vfs.mkdir('/mnt/host', { recursive: true });
    await vfs.mount('/mnt/host', new FakeStatBackend(files));

    const fs = createIsomorphicGitFs(vfs).promises;
    const stats = await fs.lstat('/mnt/host/script.sh');
    expect(stats.ctimeMs).toBe(1_700_000_500_000);
    expect(stats.mtimeMs).toBe(1_700_000_000_000);
    expect(stats.ino).toBe(987_654);
    expect(stats.uid).toBe(501);
    expect(stats.gid).toBe(20);
    // The executable bit survives instead of being flattened to 100644.
    expect(stats.mode).toBe(0o100755);
  });

  it('keeps the historical placeholders for a backend that reports nothing', async () => {
    const files = new Map([
      [
        'plain.txt',
        {
          body: 'hi\n',
          // What S3/DA/AEM report: kind, size, mtime and nothing else.
          stat: { kind: 'file' as const, size: 3, mtime: 1_700_000_000_000 },
        },
      ],
    ]);
    await vfs.mkdir('/mnt/remote', { recursive: true });
    await vfs.mount('/mnt/remote', new FakeStatBackend(files));

    const fs = createIsomorphicGitFs(vfs).promises;
    const stats = await fs.lstat('/mnt/remote/plain.txt');
    expect(stats.mode).toBe(0o100644);
    expect(stats.ino).toBe(0);
    expect(stats.uid).toBe(1);
    expect(stats.gid).toBe(1);
    // ctime falls back to mtime — there is no inode behind the entry.
    expect(stats.ctimeMs).toBe(1_700_000_000_000);
  });

  it('keeps a sub-millisecond timestamp in its own second', async () => {
    // isomorphic-git's normalizeStats derives the seconds compareStats
    // compares with Math.floor(ms / 1000). A bridge (or adapter) that ROUNDS
    // a stat 0.9996 s past the second pushes it into the next second, which
    // disagrees with the seconds native git wrote — that file is then stale
    // on every walk, forever.
    const racyMs = 1_700_000_000_999.6;
    const files = new Map([
      [
        'racy.txt',
        {
          body: 'racy\n',
          stat: {
            kind: 'file' as const,
            size: 5,
            mtime: racyMs,
            ctime: racyMs,
            ino: 7,
            uid: 501,
            gid: 20,
            mode: 0o100644,
          },
        },
      ],
    ]);
    await vfs.mkdir('/mnt/racy', { recursive: true });
    await vfs.mount('/mnt/racy', new FakeStatBackend(files));

    const fs = createIsomorphicGitFs(vfs).promises;
    const stats = await fs.lstat('/mnt/racy/racy.txt');
    expect(stats.mtimeMs).toBe(racyMs);
    expect(stats.ctimeMs).toBe(racyMs);
    // What compareStats actually compares.
    expect(Math.floor(stats.mtimeMs / 1000)).toBe(1_700_000_000);
    expect(Math.floor(stats.ctimeMs / 1000)).toBe(Math.floor(racyMs / 1000));
  });

  it('reports the local filesystem’s own inode and mode for an unmounted path', async () => {
    await vfs.writeFile('/local.txt', 'local\n');
    const fs = createIsomorphicGitFs(vfs).promises;
    const stats = await fs.lstat('/local.txt');
    expect(stats.ino).toBeGreaterThan(0);
    expect(stats.mode).toBe(0o100644);
    expect(stats.ctimeMs).toBeGreaterThan(0);
  });

  it('lets the resolved entry type win over the reported permission bits', async () => {
    // isomorphic-git decides whether to readlink an entry from mode >> 12,
    // so the type bits must come from what VirtualFS resolved, never from
    // the backend's permission bits.
    await vfs.writeFile('/target.txt', 'target\n');
    await vfs.symlink('/target.txt', '/link.txt');
    const fs = createIsomorphicGitFs(vfs).promises;
    const link = await fs.lstat('/link.txt');
    expect(link.isSymbolicLink()).toBe(true);
    expect(link.mode >> 12).toBe(0o12);
    const dir = await fs.lstat('/');
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode >> 12).toBe(0o4);
  });
});
