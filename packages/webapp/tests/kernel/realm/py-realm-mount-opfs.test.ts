/**
 * Wave E2 — pins the in-tree `OPFS_SYNC_FS` plugin mount path in
 * `py-realm-shared.ts`. The realm worker has no `localStorage`
 * shim, so the kernel side detects the OPFS flag and threads the
 * dbName through `RealmInitMsg.opfsMountDbName`; presence of that
 * field is what switches the realm into the OPFS-mount branch.
 *
 * These tests stub `navigator.storage.getDirectory` and a minimal
 * Pyodide-FS surface so the contract can be pinned without a real
 * Pyodide or OPFS instance. The mount path swaps the Wave D1
 * `mountNativeFS` + `syncfs(true)` round-trip for an in-tree
 * `FS.mount(OPFS_SYNC_FS, …)` call backed by `prewalkOpfsTree`,
 * `createBufferedOpfsSahProvider`, and `flushOpfsRealmMounts`.
 */

import type { PyodideInterface } from 'pyodide';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpfsSyncFsPlugin } from '../../../src/kernel/realm/opfs-sync-fs.js';
import {
  flushOpfsRealmMounts,
  mountOpfsDirsAndSyncIn,
  type OpfsRealmMount,
} from '../../../src/kernel/realm/py-realm-shared.js';
import { createMutableDirectoryHandle } from '../../fs/fsa-test-helpers.js';

interface MountRecord {
  plugin: unknown;
  opts: { rootHandle: FileSystemDirectoryHandle; prewalk: unknown; sahProvider: unknown };
  mountpoint: string;
}

function makeFakePyodide(): {
  pyodide: PyodideInterface;
  mountedAt: Map<string, FileSystemDirectoryHandle>;
  mountRecords: MountRecord[];
  filesystems: Record<string, unknown>;
} {
  const dirs = new Set<string>(['/']);
  const mountedAt = new Map<string, FileSystemDirectoryHandle>();
  const mountRecords: MountRecord[] = [];
  const filesystems: Record<string, unknown> = {};
  const DIR_MODE = 0o40000;
  const FILE_MODE = 0o100000;
  const FS = {
    filesystems,
    stat: (path: string): { mode: number; size: number } => {
      if (dirs.has(path)) return { mode: DIR_MODE, size: 0 };
      throw Object.assign(new Error(`ENOENT: ${path}`), { errno: 44 });
    },
    mkdirTree: (path: string): void => {
      let cursor = '';
      for (const part of path.split('/').filter(Boolean)) {
        cursor += '/' + part;
        dirs.add(cursor);
      }
      dirs.add('/');
    },
    isDir: (mode: number): boolean => (mode & 0o170000) === DIR_MODE,
    isFile: (mode: number): boolean => (mode & 0o170000) === FILE_MODE,
    isLink: (mode: number): boolean => (mode & 0o170000) === 0o120000,
    ErrnoError: class extends Error {
      errno: number;
      constructor(errno: number) {
        super(`errno ${errno}`);
        this.errno = errno;
      }
    },
    createNode: (
      _parent: unknown,
      _name: string,
      _mode: number,
      _dev?: number
    ): Record<string, unknown> => ({}),
    mount: vi.fn(
      (
        plugin: unknown,
        opts: {
          rootHandle: FileSystemDirectoryHandle;
          prewalk: unknown;
          sahProvider: unknown;
        },
        mountpoint: string
      ): { mount: { opts: unknown; mountpoint: string; root: unknown } } => {
        mountRecords.push({ plugin, opts, mountpoint });
        mountedAt.set(mountpoint, opts.rootHandle);
        const mount = { opts, mountpoint, root: {} };
        return { mount };
      }
    ),
  };
  const pyodide = { FS } as unknown as PyodideInterface;
  return { pyodide, mountedAt, mountRecords, filesystems };
}

async function readHandleText(
  root: FileSystemDirectoryHandle,
  segments: string[]
): Promise<string> {
  let cursor = root;
  for (const part of segments.slice(0, -1)) {
    cursor = await cursor.getDirectoryHandle(part);
  }
  const fileHandle = await cursor.getFileHandle(segments[segments.length - 1]);
  const file = await fileHandle.getFile();
  return file.text();
}

function installNavigatorStub(rootHandle: FileSystemDirectoryHandle | null): void {
  vi.stubGlobal(
    'navigator',
    rootHandle === null
      ? {}
      : { storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => rootHandle } }
  );
}

describe('mountOpfsDirsAndSyncIn (Wave E2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('walks OPFS root → <dbName>/<vfsPath>, registers OPFS_SYNC_FS, and mounts each dir', async () => {
    const opfs = createMutableDirectoryHandle({
      'slicc-fs': {
        workspace: { 'a.txt': 'A', sub: { 'b.txt': 'BB' } },
        tmp: {},
      },
    });
    installNavigatorStub(opfs.handle);
    const { pyodide, mountedAt, mountRecords, filesystems } = makeFakePyodide();
    const warnings: string[] = [];

    const { mounts } = await mountOpfsDirsAndSyncIn(
      pyodide,
      ['/workspace', '/tmp'],
      'slicc-fs',
      (msg) => warnings.push(msg)
    );

    // Plugin registered exactly once and shared across mounts.
    expect(filesystems.OPFS_SYNC_FS).toBeDefined();
    const plugin = filesystems.OPFS_SYNC_FS as OpfsSyncFsPlugin;
    expect(typeof plugin.mount).toBe('function');
    expect(typeof plugin.node_ops.lookup).toBe('function');
    expect(typeof plugin.stream_ops.read).toBe('function');

    // Each sync dir routed through `FS.mount(plugin, opts, dir)`.
    expect(pyodide.FS.mount).toHaveBeenCalledTimes(2);
    expect(mountRecords.map((r) => r.mountpoint).sort()).toEqual(['/tmp', '/workspace']);
    expect(mountRecords.every((r) => r.plugin === plugin)).toBe(true);
    for (const rec of mountRecords) {
      expect(rec.opts.prewalk).toBeDefined();
      expect(rec.opts.sahProvider).toBeDefined();
      expect(rec.opts.rootHandle).toBeDefined();
    }
    expect(mountedAt.has('/workspace')).toBe(true);
    expect(mountedAt.has('/tmp')).toBe(true);

    expect(mounts).toHaveLength(2);
    expect(mounts.map((m) => m.pyPath).sort()).toEqual(['/tmp', '/workspace']);
    expect(warnings).toEqual([]);
  });

  it('reuses the registered plugin on a second mount call', async () => {
    const opfs = createMutableDirectoryHandle({ 'slicc-fs': { workspace: {}, tmp: {} } });
    installNavigatorStub(opfs.handle);
    const { pyodide, filesystems } = makeFakePyodide();
    await mountOpfsDirsAndSyncIn(pyodide, ['/workspace'], 'slicc-fs');
    const firstPlugin = filesystems.OPFS_SYNC_FS;
    await mountOpfsDirsAndSyncIn(pyodide, ['/tmp'], 'slicc-fs');
    expect(filesystems.OPFS_SYNC_FS).toBe(firstPlugin);
  });

  it('creates missing OPFS subdirectories so a fresh boot mounts a writable tree', async () => {
    // No `slicc-fs/workspace` in OPFS yet — `getDirectoryHandle`
    // with `{ create: true }` materializes the path so the mount
    // succeeds even on first run.
    const opfs = createMutableDirectoryHandle({});
    installNavigatorStub(opfs.handle);
    const { pyodide, mountedAt } = makeFakePyodide();
    const warnings: string[] = [];

    const { mounts } = await mountOpfsDirsAndSyncIn(
      pyodide,
      ['/workspace/new-cwd'],
      'slicc-fs',
      (msg) => warnings.push(msg)
    );

    expect(pyodide.FS.mount).toHaveBeenCalledTimes(1);
    expect(mountedAt.has('/workspace/new-cwd')).toBe(true);
    expect(mounts).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('skips with warning when navigator.storage.getDirectory is unavailable', async () => {
    installNavigatorStub(null);
    const { pyodide } = makeFakePyodide();
    const warnings: string[] = [];

    const { mounts } = await mountOpfsDirsAndSyncIn(pyodide, ['/workspace'], 'slicc-fs', (msg) =>
      warnings.push(msg)
    );

    expect(pyodide.FS.mount).not.toHaveBeenCalled();
    expect(mounts).toEqual([]);
    expect(warnings.some((w) => w.includes('navigator.storage.getDirectory'))).toBe(true);
  });

  it('warns and continues to the next dir when one mount rejects', async () => {
    const opfs = createMutableDirectoryHandle({
      'slicc-fs': { ok: { 'k.txt': 'K' } },
    });
    installNavigatorStub(opfs.handle);
    const { pyodide, mountedAt } = makeFakePyodide();
    let firstCall = true;
    (pyodide.FS.mount as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_plugin: unknown, opts: { rootHandle: FileSystemDirectoryHandle }, mountpoint: string) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('mount denied');
        }
        mountedAt.set(mountpoint, opts.rootHandle);
        return { mount: { opts, mountpoint, root: {} } };
      }
    );
    const warnings: string[] = [];

    const { mounts } = await mountOpfsDirsAndSyncIn(pyodide, ['/bad', '/ok'], 'slicc-fs', (msg) =>
      warnings.push(msg)
    );

    expect(mountedAt.has('/ok')).toBe(true);
    expect(mounts.map((m) => m.pyPath)).toEqual(['/ok']);
    expect(warnings.some((w) => w.includes('/bad') && w.includes('mount denied'))).toBe(true);
  });
});

describe('flushOpfsRealmMounts (Wave E2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drains queued OPFS ops and persists dirty buffers via createWritable', async () => {
    // Seed OPFS with a file the prewalk picks up, then simulate
    // user code writing through the buffered SAH provider and
    // assert `flushOpfsRealmMounts` lands the dirty buffer on
    // disk via the mocked OPFS handle.
    const opfs = createMutableDirectoryHandle({
      'slicc-fs': {
        workspace: { 'seed.txt': 'SEED' },
        tmp: {},
      },
    });
    installNavigatorStub(opfs.handle);
    const { pyodide } = makeFakePyodide();
    const warnings: string[] = [];

    const { mounts } = await mountOpfsDirsAndSyncIn(
      pyodide,
      ['/workspace', '/tmp'],
      'slicc-fs',
      (msg) => warnings.push(msg)
    );

    // Drive the buffered SAH provider directly to simulate Python
    // opening, writing, and closing a fresh file under each mount.
    writeViaProvider(mounts, '/workspace', 'new.txt', 'NEW');
    writeViaProvider(mounts, '/tmp', 'scratch.txt', 'SCRATCH');

    await flushOpfsRealmMounts(mounts);

    expect(await readHandleText(opfs.handle, ['slicc-fs', 'workspace', 'new.txt'])).toBe('NEW');
    expect(await readHandleText(opfs.handle, ['slicc-fs', 'tmp', 'scratch.txt'])).toBe('SCRATCH');
    // Pre-existing seed file untouched.
    expect(await readHandleText(opfs.handle, ['slicc-fs', 'workspace', 'seed.txt'])).toBe('SEED');
    expect(warnings).toEqual([]);
  });

  it('is a no-op when no mounts were registered', async () => {
    await expect(flushOpfsRealmMounts([])).resolves.toBeUndefined();
  });
});

function writeViaProvider(
  mounts: OpfsRealmMount[],
  pyPath: string,
  relPath: string,
  text: string
): void {
  const entry = mounts.find((m) => m.pyPath === pyPath);
  if (!entry) throw new Error(`no mount for ${pyPath}`);
  const provider = entry.mount.opts.sahProvider;
  const sah = provider.acquire(relPath);
  const bytes = new TextEncoder().encode(text);
  sah.truncate(0);
  sah.write(bytes, { at: 0 });
  sah.flush();
  sah.close();
}
