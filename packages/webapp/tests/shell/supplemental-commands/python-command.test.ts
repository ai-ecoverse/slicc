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
import { PYODIDE_VERSION } from '../../../src/kernel/realm/py-realm-shared.js';
import {
  computeOverlappingMountPoints,
  computePyodideMountDirs,
  createPython3LikeCommand,
  pyodideVersionMismatchMessage,
  readInstalledPyodideVersion,
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
  const PKG_DIR = '/workspace/node_modules/pyodide';
  const ASSET_FILES = [
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
  ];

  /**
   * Build a `Partial<IFileSystem>` that exposes an ipk-installed
   * pyodide package at {@link PKG_DIR} with a configurable
   * `package.json` version. All four runtime assets are seeded so
   * `tryResolvePyodideAssetRoot` succeeds — the only knob the
   * version-pin tests need is the package.json version.
   */
  function fsWithInstalledPyodide(opts: {
    version?: string;
    packageJsonText?: string;
  }): Partial<IFileSystem> & { isDirectory?: (p: string) => Promise<boolean> } {
    const files = new Map<string, string>();
    if (opts.packageJsonText !== undefined) {
      files.set(`${PKG_DIR}/package.json`, opts.packageJsonText);
    } else if (opts.version !== undefined) {
      files.set(
        `${PKG_DIR}/package.json`,
        JSON.stringify({ name: 'pyodide', version: opts.version })
      );
    }
    for (const name of ASSET_FILES) files.set(`${PKG_DIR}/${name}`, 'x');
    return {
      resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
      exists: vi.fn().mockImplementation(async (p: string) => files.has(p)),
      isDirectory: vi
        .fn()
        .mockImplementation(async (p: string) => p === PKG_DIR || p === '/workspace/node_modules'),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (p === PKG_DIR || p === '/workspace/node_modules' || p === '/workspace') {
          return { isFile: false, isDirectory: true, size: 0 };
        }
        if (files.has(p)) return { isFile: true, isDirectory: false, size: 1 };
        throw new Error(`ENOENT: ${p}`);
      }),
      readdir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockImplementation(async (p: string) => {
        const content = files.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      }),
    };
  }

  function withStandaloneEnv<T>(fn: () => Promise<T>): Promise<T> {
    // Force standalone branch: no `chrome.runtime.id`, and a
    // `process` without `versions.node` so `isNodeRuntime()` is
    // false. We replace `globalThis.process` with a stub that
    // preserves `nextTick` (vitest's internal RPC layer assigns
    // to it on tick boundaries — zeroing `process` entirely
    // crashes that path with a false-positive unhandled error)
    // but omits `versions`. `process.versions` is non-writable
    // on Node's real `process`, so we can't mutate the original
    // in place.
    const savedChrome = (globalThis as { chrome?: unknown }).chrome;
    const savedProcess = (globalThis as { process?: unknown }).process;
    const realProcess = savedProcess as { nextTick?: (...args: unknown[]) => void } | undefined;
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as { process?: unknown }).process = {
      nextTick:
        realProcess?.nextTick?.bind(realProcess) ?? ((cb: () => void) => queueMicrotask(cb)),
    };
    return Promise.resolve(fn()).finally(() => {
      (globalThis as { chrome?: unknown }).chrome = savedChrome;
      (globalThis as { process?: unknown }).process = savedProcess;
    });
  }

  /**
   * Standalone-browser pyodide load surfaces the canonical
   * `ipk add pyodide@<PYODIDE_VERSION>` guidance from
   * `PYODIDE_NOT_INSTALLED` BEFORE the realm worker is spawned
   * when the VFS has no installed pyodide package. Mirrors
   * `FFMPEG_CORE_NOT_INSTALLED`'s null-means-not-installed contract
   * so the user never sees a JSON-parse-of-404 crash from the
   * loader's lockfile fetch.
   */
  it('exits 1 with the pinned-version install-required error when pyodide is not in VFS node_modules', async () => {
    await withStandaloneEnv(async () => {
      const fs: Partial<IFileSystem> & { isDirectory?: (p: string) => Promise<boolean> } = {
        resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
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
      expect(result.stderr).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);
    });
  });

  it('exits 1 with the version-mismatch error BEFORE booting the realm when the installed pyodide is the wrong version', async () => {
    await withStandaloneEnv(async () => {
      const fs = fsWithInstalledPyodide({ version: '0.29.4' });
      const realmFactory = vi.fn().mockRejectedValue(new Error('REALM_BOOT_REACHED'));
      const cmd = createPython3LikeCommand('python3', { realmFactory });
      const ctx = {
        fs: fs as IFileSystem,
        cwd: '/workspace',
        env: new Map<string, string>(),
        stdin: '',
      } as unknown as Parameters<typeof cmd.execute>[1];
      const result = await cmd.execute(['-c', 'print(1)'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `installed pyodide 0.29.4 is not the supported version ${PYODIDE_VERSION}`
      );
      expect(result.stderr).toContain('ipk uninstall pyodide');
      expect(result.stderr).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);
      // The version check must short-circuit before the realm boots.
      expect(realmFactory).not.toHaveBeenCalled();
    });
  });

  it('surfaces the not-installed guidance (not a mismatch) when the installed package.json is unreadable/corrupt', async () => {
    await withStandaloneEnv(async () => {
      const fs = fsWithInstalledPyodide({ packageJsonText: 'not json' });
      const realmFactory = vi.fn().mockRejectedValue(new Error('REALM_BOOT_REACHED'));
      const cmd = createPython3LikeCommand('python3', { realmFactory });
      const ctx = {
        fs: fs as IFileSystem,
        cwd: '/workspace',
        env: new Map<string, string>(),
        stdin: '',
      } as unknown as Parameters<typeof cmd.execute>[1];
      const result = await cmd.execute(['-c', 'print(1)'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('pyodide is not installed in node_modules');
      expect(result.stderr).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);
      expect(realmFactory).not.toHaveBeenCalled();
    });
  });

  it('proceeds past the version check (reaches the realm boot) when the installed version matches PYODIDE_VERSION', async () => {
    await withStandaloneEnv(async () => {
      const fs = fsWithInstalledPyodide({ version: PYODIDE_VERSION });
      // Reject with an identifiable error so we can assert the
      // command went past the version check and into the realm
      // factory without dragging in the heavy real factory.
      // `runInRealm` catches the factory rejection and turns it
      // into a non-zero exit with the error surfaced on stderr,
      // so we assert on that envelope rather than on a thrown
      // promise — the key invariant is that the factory was
      // actually invoked (i.e. the version-check did NOT
      // short-circuit) and the mismatch message is absent.
      const realmFactory = vi.fn().mockRejectedValue(new Error('REALM_BOOT_REACHED'));
      const cmd = createPython3LikeCommand('python3', { realmFactory });
      const ctx = {
        fs: fs as IFileSystem,
        cwd: '/workspace',
        env: new Map<string, string>(),
        stdin: '',
      } as unknown as Parameters<typeof cmd.execute>[1];
      const result = await cmd.execute(['-c', 'print(1)'], ctx);
      expect(realmFactory).toHaveBeenCalled();
      expect(result.stderr).toContain('REALM_BOOT_REACHED');
      expect(result.stderr).not.toContain('is not the supported version');
      expect(result.stderr).not.toContain('pyodide is not installed in node_modules');
    });
  });
});

describe('readInstalledPyodideVersion', () => {
  it('returns the version string when package.json is well-formed', async () => {
    const reader = {
      readFile: async (p: string) => {
        if (p === '/pkg/package.json') return JSON.stringify({ version: '1.2.3' });
        throw new Error(`ENOENT: ${p}`);
      },
    };
    expect(await readInstalledPyodideVersion(reader, '/pkg')).toBe('1.2.3');
  });

  it('returns null on a missing package.json', async () => {
    const reader = {
      readFile: async () => {
        throw new Error('ENOENT');
      },
    };
    expect(await readInstalledPyodideVersion(reader, '/pkg')).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const reader = { readFile: async () => 'not json' };
    expect(await readInstalledPyodideVersion(reader, '/pkg')).toBeNull();
  });

  it('returns null when version is not a string', async () => {
    const reader = { readFile: async () => JSON.stringify({ version: 42 }) };
    expect(await readInstalledPyodideVersion(reader, '/pkg')).toBeNull();
  });
});

describe('pyodideVersionMismatchMessage', () => {
  it('names both versions plus the uninstall + ipk add@<pinned> remediation', () => {
    const msg = pyodideVersionMismatchMessage('314.0.0', '0.29.4');
    expect(msg).toBe(
      'installed pyodide 314.0.0 is not the supported version 0.29.4: run `ipk uninstall pyodide` then `ipk add pyodide@0.29.4`'
    );
  });
});
