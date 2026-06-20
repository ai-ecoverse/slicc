/**
 * Unit tests for `computePyodideMountDirs` — the top-level VFS
 * enumeration helper that picks which dirs `python` / `python3`
 * mount into the Pyodide realm. The realm-side mount mechanics are
 * covered by `tests/kernel/realm/py-realm-mount-opfs.test.ts`; this
 * file just pins the enumeration contract used to build the mount
 * list before it leaves the kernel-worker shell.
 */

import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  computeOverlappingMountPoints,
  computePyodideMountDirs,
  createPython3LikeCommand,
} from '../../../src/shell/supplemental-commands/python-command.js';

function makeFs(
  entries: Array<{ name: string; isDir?: boolean; statThrows?: boolean }>,
  opts: { readdirThrows?: boolean } = {}
): IFileSystem {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const fs: Partial<IFileSystem> = {
    readdir: vi.fn().mockImplementation(async (p: string) => {
      if (opts.readdirThrows) throw new Error('ENOENT');
      if (p !== '/') return [];
      return entries.map((e) => e.name);
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      const name = p.startsWith('/') ? p.slice(1) : p;
      const entry = byName.get(name);
      if (!entry || entry.statThrows) throw new Error(`ENOENT: ${p}`);
      return { isFile: !entry.isDir, isDirectory: !!entry.isDir, size: 0 };
    }),
  };
  return fs as IFileSystem;
}

describe('computePyodideMountDirs', () => {
  it('enumerates top-level VFS directories as absolute paths', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'shared', isDir: true },
      { name: 'scoops', isDir: true },
      { name: 'sessions', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/scoops', '/sessions', '/tmp']);
  });

  it('skips files at the VFS root', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'README.md', isDir: false },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('excludes Pyodide/Emscripten built-in names', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'dev', isDir: true },
      { name: 'proc', isDir: true },
      { name: 'lib', isDir: true },
      { name: 'bin', isDir: true },
      { name: 'usr', isDir: true },
      { name: 'etc', isDir: true },
      { name: 'home', isDir: true },
      { name: 'tmp', isDir: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('always appends /tmp even when the VFS root has no /tmp dir', async () => {
    const fs = makeFs([{ name: 'workspace', isDir: true }]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toContain('/tmp');
    // /tmp should appear exactly once and at the tail.
    expect(dirs.filter((d) => d === '/tmp')).toHaveLength(1);
    expect(dirs[dirs.length - 1]).toBe('/tmp');
  });

  it('skips entries whose stat() throws (dangling/unreadable)', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'broken', isDir: true, statThrows: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('falls back to [/tmp] when readdir(/) fails', async () => {
    const fs = makeFs([], { readdirThrows: true });
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/tmp']);
  });

  it('does not include "/" when invoked with a cwd of "/"', async () => {
    // The legacy code was `const syncDirs = [ctx.cwd, '/tmp']`; from
    // cwd '/' that collapsed to ['/', '/tmp'] and Emscripten rejected
    // the root mount with EBUSY. The new helper ignores cwd entirely
    // and emits absolute top-level dirs, so '/' must never appear.
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).not.toContain('/');
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('deduplicates and ignores names containing a slash', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'workspace', isDir: true },
      { name: 'a/b', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/tmp']);
  });
});

describe('computeOverlappingMountPoints', () => {
  function fsWithMounts(mounts: { path: string; kind: 'local' | 's3' | 'da' | 'proc' }[]) {
    return { listMountPoints: () => mounts } as unknown as IFileSystem;
  }
  it('returns [] when the FS does not expose listMountPoints (test stub)', () => {
    expect(computeOverlappingMountPoints({} as IFileSystem, ['/workspace'])).toEqual([]);
  });
  it('tags each overlapping mount with its kind, drops internal proc mounts', () => {
    const fs = fsWithMounts([
      { path: '/mnt/myapp', kind: 'local' },
      { path: '/mnt/s3', kind: 's3' },
      { path: '/workspace/repo', kind: 'da' },
      { path: '/proc', kind: 'proc' },
    ]);
    const out = computeOverlappingMountPoints(fs, ['/workspace', '/mnt', '/tmp']);
    expect(out).toEqual([
      { path: '/mnt/myapp', kind: 'local' },
      { path: '/mnt/s3', kind: 's3' },
      { path: '/workspace/repo', kind: 'da' },
    ]);
  });
  it('drops mounts that do not overlap any sync dir', () => {
    const fs = fsWithMounts([
      { path: '/somewhere-else', kind: 's3' },
      { path: '/workspace/x', kind: 'local' },
    ]);
    const out = computeOverlappingMountPoints(fs, ['/workspace']);
    expect(out).toEqual([{ path: '/workspace/x', kind: 'local' }]);
  });
});

describe('createPython3LikeCommand — Wave 13c standalone install guidance', () => {
  /**
   * Standalone-browser pyodide load surfaces the canonical
   * `ipk add pyodide` guidance from `PYODIDE_NOT_INSTALLED` BEFORE
   * the realm worker is spawned when the VFS has no installed
   * pyodide package. Mirrors `FFMPEG_CORE_NOT_INSTALLED`'s null-means-
   * not-installed contract so the user never sees a JSON-parse-of-404
   * crash from the loader's lockfile fetch.
   */
  it('exits 1 with the canonical install-required error when pyodide is not in VFS node_modules', async () => {
    // Force standalone branch: no `chrome.runtime.id`, no `process`.
    // The command's resolvePyodideIndexURL() returns undefined and
    // the new `tryResolvePyodideAssetRoot` runs against this fs.
    const savedChrome = (globalThis as { chrome?: unknown }).chrome;
    const savedProcess = (globalThis as { process?: unknown }).process;
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as { process?: unknown }).process = undefined;
    try {
      const fs: Partial<IFileSystem> = {
        resolvePath: (base, p) => (p.startsWith('/') ? p : `${base}/${p}`),
        exists: vi.fn().mockResolvedValue(false),
        isDirectory: vi.fn().mockResolvedValue(false),
        stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
        readdir: vi.fn().mockResolvedValue([]),
        readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
      };
      const cmd = createPython3LikeCommand('python3');
      const ctx = {
        fs: fs as IFileSystem,
        cwd: '/workspace',
        env: new Map<string, string>(),
        stdin: '',
      } as unknown as Parameters<typeof cmd.execute>[1];
      const result = await cmd.execute(['-c', 'print(1)'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('pyodide is not installed in node_modules');
      expect(result.stderr).toContain('ipk add pyodide');
    } finally {
      (globalThis as { chrome?: unknown }).chrome = savedChrome;
      (globalThis as { process?: unknown }).process = savedProcess;
    }
  });
});
