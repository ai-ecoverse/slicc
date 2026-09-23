/**
 * `__slicc_mountVfs` body (`mountVfsIntoEmscripten`). Pyodide stands in for
 * "an Emscripten module" — its `FS` is the same classic FS a wasm tool has —
 * and the bridge is a host-`node:fs` adapter over a temp dir. The realm's
 * sync-fs cache is a recording fake, so the coherence contract is pinned.
 */
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type EmscriptenFsForHook,
  mountVfsIntoEmscripten,
} from '../../../src/kernel/realm/emscripten-vfs-hook.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import type { SyncFsCache } from '../../../src/kernel/realm/sync-fs-cache.js';
import type {
  SyncFsBridgeStat,
  SyncFsPosixBridge,
} from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide');

let host = '';
const at = (p: string): string => join(host, p);

function toStat(s: nodeFs.Stats): SyncFsBridgeStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
  };
}

function wrap<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a) => {
    try {
      return fn(...a);
    } catch (err) {
      throw Object.assign(new Error(String(err)), { code: (err as { code?: string }).code });
    }
  };
}

const bridge: SyncFsPosixBridge = {
  readFile: wrap((p) => new Uint8Array(nodeFs.readFileSync(at(p)))),
  writeFile: wrap((p, b) => nodeFs.writeFileSync(at(p), b)),
  stat: wrap((p) => toStat(nodeFs.statSync(at(p)))),
  lstat: wrap((p) => toStat(nodeFs.lstatSync(at(p)))),
  readdir: wrap((p) => nodeFs.readdirSync(at(p))),
  exists: wrap((p) => nodeFs.existsSync(at(p))),
  mkdir: wrap((p) => void nodeFs.mkdirSync(at(p), { recursive: true })),
  rm: wrap((p) => nodeFs.rmSync(at(p), { recursive: true })),
  rename: wrap((a, b) => nodeFs.renameSync(at(a), at(b))),
  unlink: wrap((p) => nodeFs.unlinkSync(at(p))),
  rmdir: wrap((p) => nodeFs.rmdirSync(at(p))),
  symlink: wrap((t, l) => nodeFs.symlinkSync(t, at(l))),
  readlink: wrap((p) => nodeFs.readlinkSync(at(p))),
  chmod: wrap((p, m) => nodeFs.chmodSync(at(p), m)),
  utimes: wrap((p, a, m) => nodeFs.utimesSync(at(p), a / 1000, m / 1000)),
};

/** Records the calls the hook makes on the realm's sync-fs cache. */
function fakeSyncFs(used: boolean, pending: { path: string; content: Uint8Array }[] = []) {
  const events: string[] = [];
  const cache = {
    wasUsed: () => used,
    getMutations: () => {
      events.push('getMutations');
      const created = pending.map((p) => ({ ...p, isDirectory: false }));
      pending = [];
      return { deleted: [], created, modified: [] };
    },
    resetBaseline: () => events.push('resetBaseline'),
    invalidate: () => events.push('invalidate'),
  };
  return { cache: cache as unknown as SyncFsCache, events };
}

let pyodide: PyodideInterface;
let FS: EmscriptenFsForHook & { unmount(p: string): void; cwd(): string };
const warnings: string[] = [];

beforeAll(async () => {
  pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  FS = pyodide.FS as unknown as typeof FS;
}, 60_000);

let mounted: string[] = [];

beforeEach(() => {
  host = nodeFs.mkdtempSync(join(tmpdir(), 'em-hook-'));
  nodeFs.mkdirSync(at('/proj/src'), { recursive: true });
  nodeFs.mkdirSync(at('/dev'));
  nodeFs.writeFileSync(at('/proj/src/main.c'), 'int main(void){return 0;}\n');
  nodeFs.writeFileSync(at('/README'), 'a top-level file, not a dir');
  warnings.length = 0;
});

afterEach(() => {
  FS.chdir('/');
  for (const dir of mounted) FS.unmount(dir);
  mounted = [];
  nodeFs.rmSync(host, { recursive: true, force: true });
});

const py = (code: string): unknown => pyodide.runPython(code);

describe('mountVfsIntoEmscripten', () => {
  it('mounts each top-level VFS dir except module-owned ones, then chdirs', () => {
    const { cache } = fakeSyncFs(false);
    const handle = mountVfsIntoEmscripten(FS, {
      bridge,
      syncFs: cache,
      cwd: '/proj/src',
      warn: (m) => warnings.push(m),
    });
    mounted = handle.mounted;
    expect(handle.mounted).toEqual(['/proj']);
    expect(FS.cwd()).toBe('/proj/src');
    expect(py(`open('main.c').read()`)).toBe('int main(void){return 0;}\n');
    expect(warnings).toEqual([]);
  });

  it('honors an explicit cwd', () => {
    const { cache } = fakeSyncFs(false);
    mounted = mountVfsIntoEmscripten(
      FS,
      { bridge, syncFs: cache, cwd: '/', warn: () => {} },
      { cwd: '/proj' }
    ).mounted;
    expect(FS.cwd()).toBe('/proj');
  });

  it('flushes pending realm fs writes first, and resyncs the cache around each tool write', () => {
    const { cache, events } = fakeSyncFs(true, [
      { path: '/proj/from-script.txt', content: new TextEncoder().encode('script wrote this') },
    ]);
    mounted = mountVfsIntoEmscripten(FS, {
      bridge,
      syncFs: cache,
      cwd: '/proj',
      warn: () => {},
    }).mounted;
    // The script's pending write reached the VFS before the mount, so the
    // module sees it.
    expect(py(`open('/proj/from-script.txt').read()`)).toBe('script wrote this');
    events.length = 0;
    py(`open('/proj/out.o', 'w').write('obj')`);
    expect(nodeFs.readFileSync(at('/proj/out.o'), 'utf8')).toBe('obj');
    // Each mutation: flush (getMutations + resetBaseline), then invalidate.
    expect(events.slice(-3)).toEqual(['getMutations', 'resetBaseline', 'invalidate']);
  });

  it('flushes a pending sync write before the tool mutation runs', () => {
    const pending = [{ path: '/proj/gen', content: new TextEncoder().encode('x') }];
    const { cache } = fakeSyncFs(true);
    const handle = mountVfsIntoEmscripten(FS, {
      bridge: {
        ...bridge,
        mkdir: (p) => {
          // The pending write must already be live when the tool's op runs.
          expect(nodeFs.existsSync(at('/proj/gen'))).toBe(true);
          bridge.mkdir(p);
        },
      },
      syncFs: Object.assign(cache, {
        getMutations: () => {
          const created = pending.splice(0).map((e) => ({ ...e, isDirectory: false }));
          return { deleted: [], created, modified: [] };
        },
      }),
      cwd: '/proj',
      warn: () => {},
    });
    mounted = handle.mounted;
    py(`import os; os.mkdir('/proj/outdir')`);
    expect(nodeFs.statSync(at('/proj/outdir')).isDirectory()).toBe(true);
  });

  it('invalidates the boot snapshot even when the script never used sync fs', () => {
    const { cache, events } = fakeSyncFs(false);
    mounted = mountVfsIntoEmscripten(FS, {
      bridge,
      syncFs: cache,
      cwd: '/proj',
      warn: () => {},
    }).mounted;
    py(`open('/proj/out.o', 'w').write('obj')`);
    // No flush (nothing pending), but the stale snapshot is dropped.
    expect(events).not.toContain('getMutations');
    expect(events).toContain('invalidate');
  });

  it('invalidates the cache even when the mutation throws', () => {
    const { cache, events } = fakeSyncFs(false);
    mounted = mountVfsIntoEmscripten(FS, {
      bridge: {
        ...bridge,
        mkdir: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      },
      syncFs: cache,
      cwd: '/proj',
      warn: () => {},
    }).mounted;
    expect(() => py(`import os; os.mkdir('/proj/boom')`)).toThrow();
    expect(events).toEqual(['invalidate']);
  });

  it('warns and mounts nothing when the VFS root listing fails', () => {
    const { cache } = fakeSyncFs(false);
    const handle = mountVfsIntoEmscripten(FS, {
      bridge: {
        ...bridge,
        readdir: (p) => {
          if (p === '/') throw Object.assign(new Error('EIO'), { code: 'EIO' });
          return bridge.readdir(p);
        },
      },
      syncFs: cache,
      cwd: '/',
      warn: (m) => warnings.push(m),
    });
    mounted = handle.mounted;
    expect(handle.mounted).toEqual([]);
    expect(warnings[0]).toContain('cannot list the VFS root');
  });

  it('warns and stays at / when the cwd is not reachable', () => {
    const { cache } = fakeSyncFs(false);
    mounted = mountVfsIntoEmscripten(FS, {
      bridge,
      syncFs: cache,
      cwd: '/nowhere',
      warn: (m) => warnings.push(m),
    }).mounted;
    expect(FS.cwd()).toBe('/');
    expect(warnings[0]).toContain('/nowhere');
  });
});

describe('__slicc_mountVfs global', () => {
  it('is not installed in a realm without a sync bridge', async () => {
    const { executeJsCode } = await import('../../../src/shell/jsh-executor.js');
    const ctx = {
      fs: { resolvePath: (b: string, p: string) => (p.startsWith('/') ? p : `${b}/${p}`) },
      cwd: '/workspace',
      env: new Map<string, string>(),
    };
    const result = await executeJsCode(
      "console.log('hook=' + typeof globalThis.__slicc_mountVfs);",
      ['node'],
      ctx as never,
      undefined,
      { realmFactory: createInProcessJsRealmFactory() }
    );
    expect(result.stdout).toContain('hook=undefined');
  });
});
