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

    expect(stats.mode).toBe(0o100755);
  });

  it('keeps the historical placeholders for a backend that reports nothing', async () => {
    const files = new Map([
      [
        'plain.txt',
        {
          body: 'hi\n',

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

    expect(stats.ctimeMs).toBe(1_700_000_000_000);
  });

  it('keeps a sub-millisecond timestamp in its own second', async () => {
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
