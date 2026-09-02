/**
 * `VirtualFS.readDir` forwards `includeStats` so FSA mounts get #2716's
 * listing-stat promotion without re-arming #2733's `objects/pack` multiplier
 * (issue #2765).
 *
 * Op *count* is the assertion: a listing-carried stat costs one `getFile`
 * IPC; a follow-up `stat` costs `getFileHandle` + `getFile`. Requesting
 * where it helps halves the budget; requesting on pack undoes #2733.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  MountBackend,
  MountDescription,
  MountDirEntry,
  MountStat,
  ReadDirOptions,
  RefreshReport,
} from '../../src/fs/mount/backend.js';
import { LocalMountBackend } from '../../src/fs/mount/backend-local.js';
import { FsError } from '../../src/fs/types.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createIsomorphicGitFs } from '../../src/git/vfs-fs-adapter.js';
import {
  createCountingDirectoryHandle,
  createDirectoryHandle,
  type FsaCallCounts,
} from './fsa-test-helpers.js';

let dbCounter = 0;

/** A tree shaped like the one that hurt: pack dir + a small worktree. */
function repoTree(): Record<string, unknown> {
  const pack: Record<string, string> = {};
  for (let i = 0; i < 91; i++) pack[`pack-${i}.idx`] = `idx-${i}`;
  return {
    '.git': {
      objects: {
        pack,
        ab: { [`${'c'.repeat(38)}`]: 'loose' },
      },
    },
    src: { 'a.ts': 'export const a = 1\n', 'b.ts': 'export {}\n' },
  };
}

async function mountCountingLocal(
  vfs: VirtualFS,
  tree: Record<string, unknown>
): Promise<{ counts: FsaCallCounts; backend: LocalMountBackend }> {
  const { handle, counts } = createCountingDirectoryHandle(createDirectoryHandle(tree as never));
  const backend = LocalMountBackend.fromHandle(handle, { mountId: 'fsa-2765' });
  await vfs.mkdir('/mnt/repo', { recursive: true });
  await vfs.mount('/mnt/repo', backend);
  return { counts, backend };
}

describe('VirtualFS.readDir forwards includeStats (#2765)', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `include-stats-${dbCounter++}`, wipe: true });
  });

  it('lists objects/pack with zero getFile when stats are not requested', async () => {
    const { counts } = await mountCountingLocal(vfs, repoTree());
    counts.getFile = 0;
    counts.getFileHandle = 0;

    const entries = await vfs.readDir('/mnt/repo/.git/objects/pack');

    expect(entries).toHaveLength(91);
    expect(entries.every((e) => e.size === undefined)).toBe(true);
    expect(counts.getFile).toBe(0);
  });

  it('a worktree listing with includeStats costs one getFile per file, not two', async () => {
    const { counts } = await mountCountingLocal(vfs, repoTree());
    // Warm the directory-handle cache so the listing itself is the only cost.
    await vfs.readDir('/mnt/repo/src');
    counts.getFile = 0;
    counts.getFileHandle = 0;

    const entries = await vfs.readDir('/mnt/repo/src', { includeStats: true });

    expect(entries.map((e) => e.name).sort()).toEqual(['a.ts', 'b.ts']);
    expect(entries.every((e) => typeof e.size === 'number')).toBe(true);
    // Listing-carried stats: one getFile per file. A follow-up VirtualFS.stat
    // would add getFileHandle + getFile each — that is the 2N the flag avoids.
    expect(counts.getFile).toBe(2);
    expect(counts.getFileHandle).toBe(0);

    counts.getFile = 0;
    counts.getFileHandle = 0;
    await vfs.stat('/mnt/repo/src/a.ts');
    expect(counts.getFile).toBe(1);
    expect(counts.getFileHandle).toBe(1);
  });

  it('does not invent stats on an FSA listing without the flag', async () => {
    await mountCountingLocal(vfs, { 'a.txt': 'hello' });
    const [entry] = await vfs.readDir('/mnt/repo');
    expect(entry).toEqual({ name: 'a.txt', type: 'file' });
  });
});

describe('git adapter path-shaped includeStats (#2765)', () => {
  let vfs: VirtualFS;
  let counts: FsaCallCounts;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `git-include-stats-${dbCounter++}`, wipe: true });
    ({ counts } = await mountCountingLocal(vfs, repoTree()));
  });

  it('keeps objects/pack listings stat-free through isomorphic-git readdir', async () => {
    const fs = createIsomorphicGitFs(vfs).promises;
    // Warm path resolution so the listing cost is isolated.
    await fs.readdir('/mnt/repo/.git/objects/pack');
    counts.getFile = 0;

    await fs.readdir('/mnt/repo/.git/objects/pack');

    expect(counts.getFile).toBe(0);
  });

  it('keeps loose fan-out listings stat-free', async () => {
    const fs = createIsomorphicGitFs(vfs).promises;
    await fs.readdir('/mnt/repo/.git/objects/ab');
    counts.getFile = 0;

    await fs.readdir('/mnt/repo/.git/objects/ab');

    expect(counts.getFile).toBe(0);
  });

  it('asks for stats on a worktree walk so a follow-up stat hits the cache', async () => {
    const fs = createIsomorphicGitFs(vfs).promises;
    await fs.readdir('/mnt/repo/src');
    counts.getFile = 0;
    counts.getFileHandle = 0;

    // Second listing (cache warm) pays one getFile per file via includeStats.
    await fs.readdir('/mnt/repo/src');
    expect(counts.getFile).toBe(2);
    expect(counts.getFileHandle).toBe(0);

    counts.getFile = 0;
    counts.getFileHandle = 0;
    const stat = await fs.stat('/mnt/repo/src/a.ts');
    expect(stat.size).toBeGreaterThan(0);
    // Primed from the listing — no FSA round trip.
    expect(counts.getFile).toBe(0);
    expect(counts.getFileHandle).toBe(0);
  });
});

/**
 * HTTP backends ignore `includeStats` and always report the fields they
 * already have — the flag must not change their contract.
 */
describe('HTTP backends ignore includeStats (#2765)', () => {
  let vfs: VirtualFS;
  let lastOpts: ReadDirOptions | undefined;

  class RecordingHttpBackend implements MountBackend {
    readonly kind = 'hostfs' as const;
    readonly source = 'hostfs:///http';
    readonly mountId = 'http-2765';
    readonly listingStatsMatchStat = true;

    async readDir(_path: string, opts?: ReadDirOptions): Promise<MountDirEntry[]> {
      lastOpts = opts;
      return [
        {
          name: 'page.html',
          kind: 'file',
          size: 42,
          lastModified: 1_700_000_000_000,
        },
      ];
    }

    async readFile(): Promise<Uint8Array> {
      return new Uint8Array();
    }
    async writeFile(): Promise<void> {}
    async stat(path: string): Promise<MountStat> {
      throw new FsError('ENOENT', 'no such file', path);
    }
    async mkdir(): Promise<void> {}
    async remove(): Promise<void> {}
    async refresh(): Promise<RefreshReport> {
      return { added: [], removed: [], changed: [], unchanged: 0, errors: [] };
    }
    describe(): MountDescription {
      return { displayName: 'http' };
    }
    async close(): Promise<void> {}
    getHostPath(): string {
      return '/http';
    }
  }

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `http-include-stats-${dbCounter++}`, wipe: true });
    lastOpts = undefined;
    await vfs.mkdir('/mnt/http', { recursive: true });
    await vfs.mount('/mnt/http', new RecordingHttpBackend());
  });

  it('still promotes listing stats without the flag', async () => {
    const [entry] = await vfs.readDir('/mnt/http');
    expect(lastOpts).toBeUndefined();
    expect(entry).toEqual({
      name: 'page.html',
      type: 'file',
      size: 42,
      mtime: 1_700_000_000_000,
    });
  });

  it('forwards the flag when asked but still returns the free listing fields', async () => {
    const [entry] = await vfs.readDir('/mnt/http', { includeStats: true });
    expect(lastOpts).toEqual({ includeStats: true });
    expect(entry?.size).toBe(42);
  });
});
