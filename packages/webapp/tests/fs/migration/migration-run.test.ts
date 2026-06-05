import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LegacyFileReader,
  MigrationCopyResult,
} from '../../../src/fs/migration/migration-copy.js';
import {
  type LegacyFsStats,
  type LegacyLfsReader,
  OPFS_MIGRATION_SENTINEL,
} from '../../../src/fs/migration/migration-detect.js';
import { runLegacyMigrationFromVfs } from '../../../src/fs/migration/migration-run.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';

interface MockEntry {
  type: 'file' | 'dir' | 'symlink';
  size?: number;
  target?: string;
  /** Bytes (file only). */
  bytes?: Uint8Array;
}

function buildLfsReader(tree: Record<string, MockEntry>): LegacyLfsReader {
  function statOf(entry: MockEntry): LegacyFsStats {
    return {
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'dir',
      isSymbolicLink: () => entry.type === 'symlink',
      size: entry.size ?? 0,
    };
  }
  return {
    async readdir(path: string): Promise<string[]> {
      const entry = tree[path];
      if (entry?.type !== 'dir') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const prefix = path === '/' ? '/' : `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(tree)) {
        if (key === path) continue;
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.includes('/')) continue;
        names.add(rest);
      }
      return [...names].sort();
    },
    async lstat(path: string): Promise<LegacyFsStats> {
      const entry = tree[path];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return statOf(entry);
    },
    async readlink(path: string): Promise<string> {
      const entry = tree[path];
      if (entry?.type !== 'symlink') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return entry.target ?? '';
    },
  };
}

function buildFileReader(tree: Record<string, MockEntry>): LegacyFileReader {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const entry = tree[path];
      if (entry?.type !== 'file' || !entry.bytes) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return entry.bytes;
    },
  };
}

describe('runLegacyMigrationFromVfs', () => {
  let vfs: VirtualFS;
  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-migration-run', wipe: true });
  });
  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 600));
  });

  it('copies files + dirs + symlinks into the VFS and writes the sentinel last on parity', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/a.txt': { type: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) },
      '/workspace/src': { type: 'dir' },
      '/workspace/src/b.txt': { type: 'file', size: 4, bytes: new Uint8Array([9, 9, 9, 9]) },
      '/workspace/link': { type: 'symlink', target: '/workspace/a.txt' },
    };
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const copy = (result as { result: MigrationCopyResult }).result;
    expect(copy.kind).toBe('success');
    // Sentinel landed at exactly the expected path.
    const sentinelStat = await vfs.stat(OPFS_MIGRATION_SENTINEL);
    expect(sentinelStat.type).toBe('file');
    // Files copied with correct bytes.
    const a = (await vfs.readFile('/workspace/a.txt', { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(a)).toEqual([1, 2, 3]);
    const b = (await vfs.readFile('/workspace/src/b.txt', { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(b)).toEqual([9, 9, 9, 9]);
  });

  it('is idempotent — second run is a sentinel-present fast no-op', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/a.txt': { type: 'file', size: 1, bytes: new Uint8Array([7]) },
    };
    const firstReader = vi.fn(async () => buildFileReader(tree));
    const firstLfs = vi.fn(async () => buildLfsReader(tree));
    const r1 = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: firstLfs,
      legacyReaderFactory: firstReader,
      probeLegacyDbExists: async () => true,
    });
    expect(r1.kind).toBe('copied');
    expect(firstReader).toHaveBeenCalledTimes(1);

    const secondReader = vi.fn(async () => buildFileReader(tree));
    const secondLfs = vi.fn(async () => buildLfsReader(tree));
    const r2 = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: secondLfs,
      legacyReaderFactory: secondReader,
      probeLegacyDbExists: async () => true,
    });
    expect(r2).toEqual({ kind: 'sentinel-present' });
    // Neither legacy handle was constructed on the fast path.
    expect(secondReader).not.toHaveBeenCalled();
    expect(secondLfs).not.toHaveBeenCalled();
  });

  it('returns legacy-absent when probe says the legacy IDB does not exist', async () => {
    const reader = vi.fn(async () => buildFileReader({}));
    const lfs = vi.fn(async () => buildLfsReader({ '/': { type: 'dir' } }));
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: lfs,
      legacyReaderFactory: reader,
      probeLegacyDbExists: async () => false,
    });
    expect(result).toEqual({ kind: 'legacy-absent' });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects calls from the chrome extension side panel before touching the legacy IDB', async () => {
    const reader = vi.fn(async () => buildFileReader({}));
    const lfs = vi.fn(async () => buildLfsReader({ '/': { type: 'dir' } }));
    const probe = vi.fn(async () => true);
    await expect(
      runLegacyMigrationFromVfs(vfs, {
        legacyLfsFactory: lfs,
        legacyReaderFactory: reader,
        probeLegacyDbExists: probe,
        callerEnv: {
          hasExtensionRuntime: true,
          hasDocument: true,
          pathname: '/index.html',
        },
      })
    ).rejects.toThrow(/runLegacyMigrationFromVfs invoked from the chrome extension side panel/);
    // None of the legacy handles or the OPFS sentinel probe were touched.
    expect(reader).not.toHaveBeenCalled();
    expect(lfs).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('allows calls from the offscreen document (extension VFS owner)', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/a.txt': { type: 'file', size: 1, bytes: new Uint8Array([7]) },
    };
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
      callerEnv: {
        hasExtensionRuntime: true,
        hasDocument: true,
        pathname: '/offscreen.html',
      },
    });
    expect(result.kind).toBe('copied');
  });

  it('allows calls from the standalone DedicatedWorker (no document)', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/a.txt': { type: 'file', size: 1, bytes: new Uint8Array([7]) },
    };
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
      callerEnv: {
        hasExtensionRuntime: false,
        hasDocument: false,
        pathname: '',
      },
    });
    expect(result.kind).toBe('copied');
  });

  it('writes the sentinel even when unrelated files exist on OPFS (concurrent boot writes)', async () => {
    // Simulate the orchestrator's `ensureRootStructure` / default
    // `/shared/CLAUDE.md` writes happening before the migration runs.
    // Manifest-bounded parity must ignore these extra files instead of
    // walking the whole subtree (the original sentinel-never-written bug).
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.writeFile('/shared/CLAUDE.md', 'default content from orchestrator boot');
    await vfs.writeFile('/workspace/.cone-memory-migrated', 'sentinel from another migration');
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/a.txt': { type: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) },
    };
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const copy = (result as { result: MigrationCopyResult }).result;
    expect(copy.kind).toBe('success');
    // Sentinel landed despite the unrelated files already on OPFS.
    const sentinelStat = await vfs.stat(OPFS_MIGRATION_SENTINEL);
    expect(sentinelStat.type).toBe('file');
  });

  it('re-running after a partial aborted copy (leftover symlinks on OPFS) still reaches the sentinel', async () => {
    // Simulate the early-PR hotfix scenario end-to-end against the real
    // VFS: the first attempt's symlinks are already on OPFS when the
    // re-run starts. The VFS-bound writer must treat an identical
    // existing link as success rather than aborting with EEXIST.
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/a.txt': { type: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) },
      '/workspace/link': { type: 'symlink', target: '/workspace/a.txt' },
    };
    // Pre-create the symlink on OPFS the way an aborted prior run would
    // have left it.
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.symlink('/workspace/a.txt', '/workspace/link');
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const copy = (result as { result: MigrationCopyResult }).result;
    expect(copy.kind).toBe('success');
    const sentinelStat = await vfs.stat(OPFS_MIGRATION_SENTINEL);
    expect(sentinelStat.type).toBe('file');
    // The pre-existing link still points at the same target.
    const linkStat = await vfs.lstat('/workspace/link');
    expect(linkStat.type).toBe('symlink');
    expect(linkStat.symlinkTarget).toBe('/workspace/a.txt');
  });

  it('replaces a leftover symlink whose target diverges from the manifest', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/a.txt': { type: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) },
      '/workspace/link': { type: 'symlink', target: '/workspace/a.txt' },
    };
    await vfs.mkdir('/workspace', { recursive: true });
    // Pre-existing link points at a different target (stale prior run).
    await vfs.symlink('/workspace/stale-target', '/workspace/link');
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const linkStat = await vfs.lstat('/workspace/link');
    expect(linkStat.symlinkTarget).toBe('/workspace/a.txt');
  });

  it('writes the sentinel when post-copy OPFS bytes exceed the manifest snapshot (boot drift)', async () => {
    // Regression: a manifest file ends up larger on
    // OPFS than the manifest claims (a concurrent boot rewrite landed
    // between detection and parity, or the reader returned more bytes
    // than the recorded size). Presence parity still matches → the
    // sentinel MUST land so the next boot is a fast no-op.
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/shared': { type: 'dir' },
      // Manifest says size=4 even though the bytes are longer — this
      // simulates the live drift cleanly without timing tricks: the
      // migration writes the bigger bytes (so OPFS lstat returns the
      // bigger size) while the manifest snapshot still claims 4.
      '/shared/CLAUDE.md': {
        type: 'file',
        size: 4,
        bytes: new TextEncoder().encode('larger-than-the-manifest-size'),
      },
    };
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const copy = (result as { result: MigrationCopyResult }).result;
    expect(copy.kind).toBe('success');
    const sentinelStat = await vfs.stat(OPFS_MIGRATION_SENTINEL);
    expect(sentinelStat.type).toBe('file');
  });

  it('does NOT write the sentinel when a manifest file is missing on OPFS', async () => {
    // Genuinely incomplete copy: the target silently drops one of the
    // manifest files. Presence parity drops → sentinel MUST NOT land.
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/a.txt': { type: 'file', size: 3, bytes: new Uint8Array([1, 2, 3]) },
      '/workspace/b.txt': { type: 'file', size: 1, bytes: new Uint8Array([9]) },
    };
    // Wrap writeFile so the second file is silently dropped.
    const realWriteFile = vfs.writeFile.bind(vfs);
    (vfs as unknown as { writeFile: typeof vfs.writeFile }).writeFile = ((
      path: string,
      ...rest: unknown[]
    ) => {
      if (path === '/workspace/b.txt') return Promise.resolve();
      return (realWriteFile as (p: string, ...r: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof vfs.writeFile;
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
    });
    expect(result.kind).toBe('copied');
    const copy = (result as { result: MigrationCopyResult }).result;
    expect(copy.kind).toBe('parity-mismatch');
    await expect(vfs.stat(OPFS_MIGRATION_SENTINEL)).rejects.toBeTruthy();
  });

  it('forwards per-file copy progress to onProgress', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/a.txt': { type: 'file', size: 1, bytes: new Uint8Array([1]) },
      '/b.txt': { type: 'file', size: 1, bytes: new Uint8Array([2]) },
      '/c.txt': { type: 'file', size: 1, bytes: new Uint8Array([3]) },
    };
    const progressLog: Array<{ copied: number; total: number }> = [];
    const result = await runLegacyMigrationFromVfs(vfs, {
      legacyLfsFactory: async () => buildLfsReader(tree),
      legacyReaderFactory: async () => buildFileReader(tree),
      probeLegacyDbExists: async () => true,
      onProgress: (p) => progressLog.push(p),
    });
    expect(result.kind).toBe('copied');
    // Initial tick (0/3) plus one per copied file.
    expect(progressLog[0]).toEqual({ copied: 0, total: 3 });
    expect(progressLog[progressLog.length - 1]).toEqual({ copied: 3, total: 3 });
  });
});
