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
import * as git from 'isomorphic-git';
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

/** In-memory stand-in for a bridge-backed mount, with a per-file stat table. */
class FakeStatBackend implements MountBackend {
  readonly kind = 'hostfs' as const;
  readonly source = 'hostfs:///fake';
  readonly mountId = 'fake-stat-backend';

  constructor(private readonly files: Map<string, { body: string; stat: MountStat }>) {}

  async readDir(path: string): Promise<MountDirEntry[]> {
    const prefix = path.replace(/^\/+|\/+$/g, '');
    const entries: MountDirEntry[] = [];
    for (const [name, entry] of this.files) {
      if (prefix.length > 0 && !name.startsWith(`${prefix}/`)) continue;
      entries.push({ name: name.slice(prefix.length > 0 ? prefix.length + 1 : 0), ...entry.stat });
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

  it('lets isomorphic-git read packed objects through bounded ranges', async () => {
    const dir = '/packed-repo';
    const base = createIsomorphicGitFs(vfs);
    await git.init({ fs: base, dir, defaultBranch: 'main' });
    await vfs.writeFile(`${dir}/file.txt`, 'packed content\n');
    await git.add({ fs: base, dir, filepath: 'file.txt' });
    const oid = await git.commit({
      fs: base,
      dir,
      message: 'packed commit',
      author: { name: 'Range Test', email: 'range@example.com' },
    });
    const { filename } = await git.packObjects({ fs: base, dir, oids: [oid], write: true });
    const packPath = `${dir}/.git/objects/pack/${filename}`;
    await git.indexPack({ fs: base, dir, filepath: `.git/objects/pack/${filename}` });
    await vfs.rm(`${dir}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);

    let wholePackReads = 0;
    const ranges: Array<{ start: number; end: number }> = [];
    const ranged = {
      promises: {
        ...base.promises,
        readFile: async (path: string, options?: unknown) => {
          if (path === packPath) wholePackReads += 1;
          return base.promises.readFile(path, options);
        },
        readFileRange: async (path: string, range: { start: number; end: number }) => {
          if (path === packPath) ranges.push(range);
          return base.promises.readFileRange?.(path, range) as Promise<Uint8Array>;
        },
      },
    };

    const result = await git.readCommit({ fs: ranged, dir, oid, cache: {} });
    expect(result.commit.message).toBe('packed commit\n');
    expect(wholePackReads).toBe(0);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(({ start, end }) => start >= 0 && end > start)).toBe(true);
  });
});
