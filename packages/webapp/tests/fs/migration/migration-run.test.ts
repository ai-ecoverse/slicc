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

  it('Wave C4 — rejects calls from the chrome extension side panel before touching the legacy IDB', async () => {
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
    ).rejects.toThrow(/Wave C4/);
    // None of the legacy handles or the OPFS sentinel probe were touched.
    expect(reader).not.toHaveBeenCalled();
    expect(lfs).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('Wave C4 — allows calls from the offscreen document (extension VFS owner)', async () => {
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

  it('Wave C4 — allows calls from the standalone DedicatedWorker (no document)', async () => {
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
});
