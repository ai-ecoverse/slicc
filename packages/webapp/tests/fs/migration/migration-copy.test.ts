import { describe, expect, it, vi } from 'vitest';
import {
  type LegacyFileReader,
  type OpfsTargetWriter,
  runLegacyMigrationCopy,
} from '../../../src/fs/migration/migration-copy.js';
import type { MigrationManifest } from '../../../src/fs/migration/migration-detect.js';

interface FakeWriter extends OpfsTargetWriter {
  mkdirCalls: string[];
  writeCalls: Array<{ path: string; size: number }>;
  symlinkCalls: Array<{ target: string; link: string }>;
  files: Map<string, Uint8Array>;
}

function buildFakeWriter(
  opts: { failOn?: { stage: string; path?: string; code?: string } } = {}
): FakeWriter {
  const mkdirCalls: string[] = [];
  const writeCalls: Array<{ path: string; size: number }> = [];
  const symlinkCalls: Array<{ target: string; link: string }> = [];
  const files = new Map<string, Uint8Array>();
  const writer: OpfsTargetWriter = {
    async mkdir(path) {
      mkdirCalls.push(path);
      if (opts.failOn?.stage === 'mkdir' && (!opts.failOn.path || opts.failOn.path === path)) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
    },
    async writeFile(path, content) {
      if (opts.failOn?.stage === 'writeFile' && (!opts.failOn.path || opts.failOn.path === path)) {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
      writeCalls.push({ path, size: content.length });
      files.set(path, content);
    },
    async symlink(target, link) {
      if (opts.failOn?.stage === 'symlink' && (!opts.failOn.path || opts.failOn.path === link)) {
        const code = opts.failOn.code ?? 'EEXIST';
        throw Object.assign(new Error(code), { code });
      }
      symlinkCalls.push({ target, link });
    },
  };
  return Object.assign(writer, { mkdirCalls, writeCalls, symlinkCalls, files });
}

function buildSource(bytesByPath: Record<string, Uint8Array>): LegacyFileReader {
  return {
    async readFile(path) {
      const out = bytesByPath[path];
      if (!out) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return out;
    },
  };
}

function manifestOf(
  entries: MigrationManifest['entries'],
  fileCount = 0,
  totalBytes = 0
): MigrationManifest {
  const dirCount = entries.filter((e) => e.type === 'dir').length;
  const symlinkCount = entries.filter((e) => e.type === 'symlink').length;
  return { entries, fileCount, dirCount, symlinkCount, totalBytes };
}

describe('runLegacyMigrationCopy', () => {
  it('copies dirs, files, and symlinks in the correct order and writes the sentinel last', async () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([9, 9, 9, 9]);
    const manifest = manifestOf(
      [
        { type: 'dir', path: '/workspace' },
        { type: 'dir', path: '/workspace/src' },
        { type: 'file', path: '/workspace/a.txt', size: 3 },
        { type: 'file', path: '/workspace/src/b.txt', size: 4 },
        { type: 'symlink', path: '/workspace/link', target: '/workspace/a.txt' },
      ],
      2,
      7
    );
    const writer = buildFakeWriter();
    const source = buildSource({ '/workspace/a.txt': a, '/workspace/src/b.txt': b });
    const operations: string[] = [];
    const flushBeforeSentinel = vi.fn(async () => {
      operations.push('flush');
    });
    const writeSentinel = vi.fn(async () => {
      operations.push('sentinel');
    });
    const countOpfsFiles = vi.fn(async () => {
      operations.push('count');
      return { fileCount: 2, totalBytes: 7 };
    });

    const result = await runLegacyMigrationCopy({
      manifest,
      source,
      target: writer,
      countOpfsFiles,
      flushBeforeSentinel,
      writeSentinel,
    });

    expect(result).toEqual({ kind: 'success', fileCount: 2, totalBytes: 7 });
    // Dirs first, parents before children
    expect(writer.mkdirCalls).toEqual(['/workspace', '/workspace/src']);
    // Files next (both written)
    expect(writer.writeCalls.map((c) => c.path)).toEqual([
      '/workspace/a.txt',
      '/workspace/src/b.txt',
    ]);
    // Symlinks last (after dirs/files)
    expect(writer.symlinkCalls).toEqual([{ target: '/workspace/a.txt', link: '/workspace/link' }]);
    // Strict ordering: flush → parity count → sentinel
    expect(operations).toEqual(['flush', 'count', 'sentinel']);
    expect(flushBeforeSentinel).toHaveBeenCalledTimes(1);
    expect(writeSentinel).toHaveBeenCalledTimes(1);
  });

  it('orders mkdir parents before children even when manifest order is shuffled', async () => {
    const manifest = manifestOf(
      [
        { type: 'dir', path: '/a/b/c' },
        { type: 'dir', path: '/a' },
        { type: 'dir', path: '/a/b' },
      ],
      0,
      0
    );
    const writer = buildFakeWriter();
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({}),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 0, totalBytes: 0 }),
      writeSentinel: async () => {},
    });
    expect(result.kind).toBe('success');
    expect(writer.mkdirCalls).toEqual(['/a', '/a/b', '/a/b/c']);
  });
});

describe('runLegacyMigrationCopy parity gate + error handling', () => {
  it('does NOT write the sentinel when file-count parity fails', async () => {
    const manifest = manifestOf([{ type: 'file', path: '/a.txt', size: 3 }], 1, 3);
    const writer = buildFakeWriter();
    const sentinel = vi.fn(async () => {});
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/a.txt': new Uint8Array([1, 2, 3]) }),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 0, totalBytes: 3 }),
      writeSentinel: sentinel,
    });
    expect(result.kind).toBe('parity-mismatch');
    expect(sentinel).not.toHaveBeenCalled();
  });

  it('writes the sentinel when count parity matches but bytes drift higher (boot rewrite)', async () => {
    // Regression: a concurrent boot writer (orchestrator
    // `ensureRootStructure`, default `/shared/CLAUDE.md`, sidecar
    // metadata) bumps a manifest file's size on OPFS after the copy
    // wrote it. Count parity still matches → sentinel MUST land. The
    // byte delta is logged as a diagnostic but does NOT gate.
    const manifest = manifestOf([{ type: 'file', path: '/a.txt', size: 3 }], 1, 3);
    const sentinel = vi.fn(async () => {});
    const infos: Array<{ msg: string; ctx?: unknown }> = [];
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/a.txt': new Uint8Array([1, 2, 3]) }),
      target: buildFakeWriter(),
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 9999 }),
      writeSentinel: sentinel,
      logger: { info: (msg, ctx) => infos.push({ msg, ctx }) },
    });
    expect(result).toEqual({ kind: 'success', fileCount: 1, totalBytes: 9999 });
    expect(sentinel).toHaveBeenCalledTimes(1);
    // The byte drift was surfaced as an informational log so operators
    // can still see the delta.
    const driftLogged = infos.some(
      (entry) =>
        entry.msg.includes('byte drift tolerated') ||
        (entry.msg.includes('C2 copy complete') &&
          (entry.ctx as { byteDelta?: number })?.byteDelta === 9996)
    );
    expect(driftLogged).toBe(true);
  });

  it('writes the sentinel when count parity matches but bytes drift lower', async () => {
    // Symmetric: drift can also be negative (e.g. a boot-time
    // compaction shrinks an entry). Count is the only gate.
    const manifest = manifestOf([{ type: 'file', path: '/a.txt', size: 1000 }], 1, 1000);
    const sentinel = vi.fn(async () => {});
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/a.txt': new Uint8Array(1000) }),
      target: buildFakeWriter(),
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 200 }),
      writeSentinel: sentinel,
    });
    expect(result).toEqual({ kind: 'success', fileCount: 1, totalBytes: 200 });
    expect(sentinel).toHaveBeenCalledTimes(1);
  });

  it('returns copy-error on writeFile failure and does NOT write the sentinel', async () => {
    const manifest = manifestOf([{ type: 'file', path: '/a.txt', size: 3 }], 1, 3);
    const writer = buildFakeWriter({ failOn: { stage: 'writeFile' } });
    const sentinel = vi.fn(async () => {});
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/a.txt': new Uint8Array([1, 2, 3]) }),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 3 }),
      writeSentinel: sentinel,
    });
    expect(result).toMatchObject({ kind: 'copy-error', stage: 'writeFile' });
    expect(sentinel).not.toHaveBeenCalled();
  });

  it('returns copy-error on legacy source read failure (sentinel not written, legacy unwritten)', async () => {
    const manifest = manifestOf([{ type: 'file', path: '/missing.txt', size: 1 }], 1, 1);
    const sentinel = vi.fn(async () => {});
    const writer = buildFakeWriter();
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({}),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 0, totalBytes: 0 }),
      writeSentinel: sentinel,
    });
    expect(result).toMatchObject({ kind: 'copy-error', stage: 'read' });
    expect(sentinel).not.toHaveBeenCalled();
    expect(writer.writeCalls).toEqual([]);
  });

  it('logs counts only — never paths or content bytes', async () => {
    const manifest = manifestOf([{ type: 'file', path: '/secret-name.txt', size: 5 }], 1, 5);
    const warns: Array<{ msg: string; ctx?: unknown }> = [];
    const infos: Array<{ msg: string; ctx?: unknown }> = [];
    await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/secret-name.txt': new Uint8Array([1, 2, 3, 4, 5]) }),
      target: buildFakeWriter(),
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 5 }),
      writeSentinel: async () => {},
      logger: {
        info: (msg, ctx) => infos.push({ msg, ctx }),
        warn: (msg, ctx) => warns.push({ msg, ctx }),
      },
    });
    for (const { msg, ctx } of [...infos, ...warns]) {
      const serialized = `${msg} ${JSON.stringify(ctx ?? {})}`;
      expect(serialized).not.toContain('secret-name');
      expect(serialized).not.toContain('.txt');
    }
  });

  it('tolerates EEXIST on pre-existing symlinks (re-run after aborted prior copy)', async () => {
    // Simulates the hotfix scenario: a prior migration partially
    // wrote symlinks before aborting, leaving them on OPFS. The re-run's
    // writer surfaces EEXIST for those entries; the copy must NOT abort
    // and must still reach `writeSentinel`.
    const manifest = manifestOf(
      [
        { type: 'file', path: '/a.txt', size: 3 },
        { type: 'symlink', path: '/link-a', target: '/a.txt' },
        { type: 'symlink', path: '/link-b', target: '/a.txt' },
      ],
      1,
      3
    );
    const writer = buildFakeWriter({ failOn: { stage: 'symlink', code: 'EEXIST' } });
    const sentinel = vi.fn(async () => {});
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/a.txt': new Uint8Array([1, 2, 3]) }),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 3 }),
      writeSentinel: sentinel,
    });
    expect(result).toEqual({ kind: 'success', fileCount: 1, totalBytes: 3 });
    expect(sentinel).toHaveBeenCalledTimes(1);
  });

  it('second copy run over a target carrying leftover symlinks still writes the sentinel', async () => {
    // End-to-end re-run shape: the writer accepts the first pass and,
    // for the second pass, throws EEXIST on every symlink (the leftover
    // links the first pass already wrote). The second run must still
    // succeed.
    const manifest = manifestOf(
      [
        { type: 'dir', path: '/workspace' },
        { type: 'file', path: '/workspace/a.txt', size: 3 },
        { type: 'symlink', path: '/workspace/link', target: '/workspace/a.txt' },
      ],
      1,
      3
    );
    // Run #1: clean writer, succeeds.
    const writer1 = buildFakeWriter();
    const r1 = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/workspace/a.txt': new Uint8Array([1, 2, 3]) }),
      target: writer1,
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 3 }),
      writeSentinel: async () => {},
    });
    expect(r1.kind).toBe('success');
    // Run #2: writer rejects symlinks with EEXIST (leftover from #1).
    const writer2 = buildFakeWriter({ failOn: { stage: 'symlink', code: 'EEXIST' } });
    const sentinel2 = vi.fn(async () => {});
    const r2 = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({ '/workspace/a.txt': new Uint8Array([1, 2, 3]) }),
      target: writer2,
      countOpfsFiles: async () => ({ fileCount: 1, totalBytes: 3 }),
      writeSentinel: sentinel2,
    });
    expect(r2).toEqual({ kind: 'success', fileCount: 1, totalBytes: 3 });
    expect(sentinel2).toHaveBeenCalledTimes(1);
  });

  it('still aborts on non-EEXIST symlink errors (no false success)', async () => {
    const manifest = manifestOf([{ type: 'symlink', path: '/link', target: '/missing' }], 0, 0);
    const writer = buildFakeWriter({ failOn: { stage: 'symlink', code: 'EACCES' } });
    const sentinel = vi.fn(async () => {});
    const result = await runLegacyMigrationCopy({
      manifest,
      source: buildSource({}),
      target: writer,
      countOpfsFiles: async () => ({ fileCount: 0, totalBytes: 0 }),
      writeSentinel: sentinel,
    });
    expect(result).toMatchObject({ kind: 'copy-error', stage: 'symlink' });
    expect(sentinel).not.toHaveBeenCalled();
  });
});
