/**
 * Wave D1 — pins the new `mountNativeFS` + `syncfs(true)` path in
 * `py-realm-shared.ts` that replaces the legacy `walkTree` copy when
 * `slicc_opfs_vfs === 'opfs'`. The realm worker has no `localStorage`
 * shim, so the kernel side detects the flag and threads the OPFS
 * dbName through `RealmInitMsg.opfsMountDbName`; presence of that
 * field is what switches the realm into the OPFS-mount branch.
 *
 * These tests stub `navigator.storage.getDirectory` and the
 * Pyodide-side `mountNativeFS` / `FS.syncfs` so the contract can be
 * pinned without a real Pyodide or OPFS instance.
 */

import type { PyodideInterface } from 'pyodide';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOpfsDirsAndSyncIn } from '../../../src/kernel/realm/py-realm-shared.js';
import { createMutableDirectoryHandle } from '../../fs/fsa-test-helpers.js';

function makeFakePyodide(): {
  pyodide: PyodideInterface;
  files: Map<string, Uint8Array>;
  dirs: Set<string>;
  mountedAt: Map<string, FileSystemDirectoryHandle>;
  syncfsCalls: Array<{ populate: boolean }>;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/']);
  const mountedAt = new Map<string, FileSystemDirectoryHandle>();
  const syncfsCalls: Array<{ populate: boolean }> = [];
  const DIR_MODE = 0o40000;
  const FILE_MODE = 0o100000;
  const FS = {
    stat: (path: string): { mode: number; size: number } => {
      if (dirs.has(path)) return { mode: DIR_MODE, size: 0 };
      if (files.has(path)) return { mode: FILE_MODE, size: files.get(path)!.length };
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
    readdir: (path: string): string[] => {
      if (!dirs.has(path)) throw new Error(`ENOENT: ${path}`);
      const out = new Set<string>(['.', '..']);
      const prefix = path === '/' ? '/' : `${path}/`;
      for (const f of files.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix) || d === path) continue;
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf('/');
        out.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...out];
    },
    isDir: (mode: number): boolean => (mode & 0o170000) === DIR_MODE,
    isFile: (mode: number): boolean => (mode & 0o170000) === FILE_MODE,
    syncfs: vi.fn((populate: boolean, cb: (err: Error | null | undefined) => void): void => {
      syncfsCalls.push({ populate });
      // Simulate OPFS→MEMFS materialization for syncfs(true) when
      // a handle is registered: read the mock handle's tree into
      // the fake FS so post-sync sees the files.
      if (populate) {
        for (const [mountPath, handle] of mountedAt) {
          void hydrateFromHandle(handle, mountPath, files, dirs).then(() => cb(null));
          return;
        }
      }
      cb(null);
    }),
  };
  const pyodide = {
    FS,
    mountNativeFS: vi.fn(
      async (
        path: string,
        handle: FileSystemDirectoryHandle
      ): Promise<{ syncfs: () => Promise<void> }> => {
        mountedAt.set(path, handle);
        return { syncfs: async (): Promise<void> => {} };
      }
    ),
  } as unknown as PyodideInterface;
  return { pyodide, files, dirs, mountedAt, syncfsCalls };
}

async function hydrateFromHandle(
  handle: FileSystemDirectoryHandle,
  pyPath: string,
  files: Map<string, Uint8Array>,
  dirs: Set<string>
): Promise<void> {
  dirs.add(pyPath);
  // Mock dirs are async-iterable [name, child] tuples.
  for await (const [name, child] of handle as unknown as AsyncIterable<
    [string, FileSystemDirectoryHandle | FileSystemFileHandle]
  >) {
    const childPath = pyPath === '/' ? `/${name}` : `${pyPath}/${name}`;
    if ((child as { kind?: string }).kind === 'directory') {
      await hydrateFromHandle(child as FileSystemDirectoryHandle, childPath, files, dirs);
    } else {
      const file = await (child as FileSystemFileHandle).getFile();
      const ab = await file.arrayBuffer();
      files.set(childPath, new Uint8Array(ab));
    }
  }
}

function installNavigatorStub(rootHandle: FileSystemDirectoryHandle | null): void {
  vi.stubGlobal(
    'navigator',
    rootHandle === null
      ? {}
      : { storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => rootHandle } }
  );
}

describe('mountOpfsDirsAndSyncIn (Wave D1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('walks OPFS root → <dbName>/<vfsPath> for each sync dir, mounts, and runs syncfs(true)', async () => {
    const opfs = createMutableDirectoryHandle({
      'slicc-fs': {
        workspace: { 'a.txt': 'A', sub: { 'b.txt': 'BB' } },
        tmp: {},
      },
    });
    installNavigatorStub(opfs.handle);
    const { pyodide, files, mountedAt, syncfsCalls } = makeFakePyodide();
    const warnings: string[] = [];

    const snapshot = await mountOpfsDirsAndSyncIn(
      pyodide,
      ['/workspace', '/tmp'],
      'slicc-fs',
      (msg) => warnings.push(msg)
    );

    expect(pyodide.mountNativeFS).toHaveBeenCalledTimes(2);
    expect(mountedAt.has('/workspace')).toBe(true);
    expect(mountedAt.has('/tmp')).toBe(true);
    expect(syncfsCalls).toEqual([{ populate: true }, { populate: true }]);
    // OPFS contents are visible in Pyodide-FS after syncfs(true).
    expect(new TextDecoder().decode(files.get('/workspace/a.txt')!)).toBe('A');
    expect(new TextDecoder().decode(files.get('/workspace/sub/b.txt')!)).toBe('BB');
    // The snapshot mirrors the post-mount Pyodide-FS state so the
    // legacy post-sync diff (still active until Wave D2) treats
    // OPFS-loaded files as pre-existing instead of "new".
    expect(snapshot.files.get('/workspace/a.txt')).toBe(1);
    expect(snapshot.files.get('/workspace/sub/b.txt')).toBe(2);
    expect(snapshot.dirs.has('/workspace')).toBe(true);
    expect(snapshot.dirs.has('/workspace/sub')).toBe(true);
    expect(snapshot.dirs.has('/tmp')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('creates missing OPFS subdirectories so a fresh boot mounts a writable tree', async () => {
    // No `slicc-fs/workspace` in OPFS yet — `getDirectoryHandle`
    // with `{ create: true }` must materialize the path so the mount
    // succeeds even on first run.
    const opfs = createMutableDirectoryHandle({});
    installNavigatorStub(opfs.handle);
    const { pyodide, mountedAt } = makeFakePyodide();
    const warnings: string[] = [];

    const snapshot = await mountOpfsDirsAndSyncIn(
      pyodide,
      ['/workspace/new-cwd'],
      'slicc-fs',
      (msg) => warnings.push(msg)
    );

    expect(pyodide.mountNativeFS).toHaveBeenCalledTimes(1);
    expect(mountedAt.has('/workspace/new-cwd')).toBe(true);
    expect(snapshot.dirs.has('/workspace/new-cwd')).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('skips with warning when navigator.storage.getDirectory is unavailable', async () => {
    installNavigatorStub(null);
    const { pyodide } = makeFakePyodide();
    const warnings: string[] = [];

    const snapshot = await mountOpfsDirsAndSyncIn(pyodide, ['/workspace'], 'slicc-fs', (msg) =>
      warnings.push(msg)
    );

    expect(pyodide.mountNativeFS).not.toHaveBeenCalled();
    expect(snapshot.files.size).toBe(0);
    expect(snapshot.dirs.size).toBe(0);
    expect(warnings.some((w) => w.includes('navigator.storage.getDirectory'))).toBe(true);
  });

  it('warns and continues to the next dir when one mount rejects', async () => {
    const opfs = createMutableDirectoryHandle({
      'slicc-fs': { ok: { 'k.txt': 'K' } },
    });
    installNavigatorStub(opfs.handle);
    const { pyodide, files, mountedAt } = makeFakePyodide();
    let firstCall = true;
    (pyodide.mountNativeFS as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (path: string, handle: FileSystemDirectoryHandle) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('mount denied');
        }
        mountedAt.set(path, handle);
        return { syncfs: async (): Promise<void> => {} };
      }
    );
    const warnings: string[] = [];

    await mountOpfsDirsAndSyncIn(pyodide, ['/bad', '/ok'], 'slicc-fs', (msg) => warnings.push(msg));

    expect(mountedAt.has('/ok')).toBe(true);
    expect(files.get('/ok/k.txt')).toBeTruthy();
    expect(warnings.some((w) => w.includes('/bad') && w.includes('mount denied'))).toBe(true);
  });
});
