import { describe, expect, it, vi } from 'vitest';
import {
  detectLegacyMigration,
  type LegacyFsStats,
  type LegacyLfsReader,
  type MigrationManifest,
} from '../../../src/fs/migration/migration-detect.js';

interface MockEntry {
  type: 'file' | 'dir' | 'symlink';
  /** File size (files only). */
  size?: number;
  /** Symlink target (symlinks only). */
  target?: string;
}

function buildReader(tree: Record<string, MockEntry>): LegacyLfsReader & {
  readdirCalls: string[];
  lstatCalls: string[];
  readlinkCalls: string[];
  forbiddenWriteAccess: { invoked: boolean };
} {
  const readdirCalls: string[] = [];
  const lstatCalls: string[] = [];
  const readlinkCalls: string[] = [];
  const forbiddenWriteAccess = { invoked: false };

  function statOf(entry: MockEntry): LegacyFsStats {
    return {
      isFile: () => entry.type === 'file',
      isDirectory: () => entry.type === 'dir',
      isSymbolicLink: () => entry.type === 'symlink',
      size: entry.size ?? 0,
    };
  }

  const reader: LegacyLfsReader = {
    async readdir(path: string): Promise<string[]> {
      readdirCalls.push(path);
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
      lstatCalls.push(path);
      const entry = tree[path];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return statOf(entry);
    },
    async readlink(path: string): Promise<string> {
      readlinkCalls.push(path);
      const entry = tree[path];
      if (entry?.type !== 'symlink') throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return entry.target ?? '';
    },
  };

  // Trap any accidental mutating-API access in the manifest walker. The
  // walker structurally types against `LegacyLfsReader`, so we attach
  // observable getters for `writeFile`/`mkdir`/`unlink`/`rmdir` and assert
  // they were never consulted.
  const trapped = new Proxy(reader, {
    get(target, prop, receiver) {
      if (
        prop === 'writeFile' ||
        prop === 'mkdir' ||
        prop === 'unlink' ||
        prop === 'rmdir' ||
        prop === 'symlink' ||
        prop === 'rename'
      ) {
        forbiddenWriteAccess.invoked = true;
        return undefined;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as LegacyLfsReader;

  return Object.assign(trapped, {
    readdirCalls,
    lstatCalls,
    readlinkCalls,
    forbiddenWriteAccess,
  });
}

describe('detectLegacyMigration', () => {
  it('returns sentinel-present and never opens the legacy store when the sentinel exists', async () => {
    const reader = buildReader({});
    const lfsFactory = vi.fn(async () => reader as LegacyLfsReader);

    const result = await detectLegacyMigration({
      sentinelExists: async () => true,
      lfsFactory,
    });

    expect(result).toEqual({ kind: 'sentinel-present' });
    expect(lfsFactory).not.toHaveBeenCalled();
    expect(reader.readdirCalls).toEqual([]);
  });

  it('builds an exact manifest of files, nested dirs, and symlinks without mutating the store', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/workspace': { type: 'dir' },
      '/workspace/README.md': { type: 'file', size: 42 },
      '/workspace/src': { type: 'dir' },
      '/workspace/src/index.ts': { type: 'file', size: 1024 },
      '/workspace/src/util.ts': { type: 'file', size: 256 },
      '/workspace/link-to-readme': { type: 'symlink', target: '/workspace/README.md' },
      '/shared': { type: 'dir' },
      '/shared/CLAUDE.md': { type: 'file', size: 2048 },
    };
    const reader = buildReader(tree);

    const result = await detectLegacyMigration({
      sentinelExists: async () => false,
      lfsFactory: async () => reader as LegacyLfsReader,
    });

    expect(result.kind).toBe('needs-migration');
    const manifest = (result as { manifest: MigrationManifest }).manifest;
    // Root `/` is implicit and never added to the manifest — `C2` will not
    // re-create it, OPFS already has a root.
    expect(manifest.fileCount).toBe(4);
    expect(manifest.dirCount).toBe(3);
    expect(manifest.symlinkCount).toBe(1);
    expect(manifest.totalBytes).toBe(42 + 1024 + 256 + 2048);

    const symlink = manifest.entries.find((e) => e.type === 'symlink');
    expect(symlink).toEqual({
      type: 'symlink',
      path: '/workspace/link-to-readme',
      target: '/workspace/README.md',
    });

    const file = manifest.entries.find(
      (e) => e.type === 'file' && e.path === '/workspace/src/index.ts'
    );
    expect(file).toEqual({ type: 'file', path: '/workspace/src/index.ts', size: 1024 });

    // Read-only invariant: the walker only consulted read methods.
    expect(reader.forbiddenWriteAccess.invoked).toBe(false);
    expect(reader.readdirCalls).toEqual(
      expect.arrayContaining(['/', '/workspace', '/workspace/src', '/shared'])
    );
  });

  it('skips the walk and returns an empty manifest when probeLegacyDbExists returns false', async () => {
    const reader = buildReader({});
    const lfsFactory = vi.fn(async () => reader as LegacyLfsReader);

    const result = await detectLegacyMigration({
      sentinelExists: async () => false,
      lfsFactory,
      probeLegacyDbExists: async () => false,
    });

    expect(result.kind).toBe('legacy-absent');
    const manifest = (result as { manifest: MigrationManifest }).manifest;
    expect(manifest.fileCount).toBe(0);
    expect(manifest.dirCount).toBe(0);
    expect(manifest.symlinkCount).toBe(0);
    expect(manifest.totalBytes).toBe(0);
    expect(lfsFactory).not.toHaveBeenCalled();
  });

  it('logs counts only, never paths or content', async () => {
    const tree: Record<string, MockEntry> = {
      '/': { type: 'dir' },
      '/secret.txt': { type: 'file', size: 7 },
    };
    const reader = buildReader(tree);
    const infos: Array<{ msg: string; ctx?: unknown }> = [];

    await detectLegacyMigration({
      sentinelExists: async () => false,
      lfsFactory: async () => reader as LegacyLfsReader,
      logger: { info: (msg, ctx) => infos.push({ msg, ctx }) },
    });

    for (const { msg, ctx } of infos) {
      expect(msg).not.toContain('secret');
      const serialized = JSON.stringify(ctx ?? {});
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('.txt');
    }
    // The completion log includes count metadata.
    const completion = infos.find((entry) => entry.msg.includes('walk complete'));
    expect(completion?.ctx).toMatchObject({
      files: 1,
      dirs: 0,
      symlinks: 0,
      totalBytes: 7,
    });
  });
});
