/**
 * Unit tests for the Wave 13c VFS-bytes pyodide loader helpers:
 *   • `tryResolvePyodideAssetRoot` (kernel-side discovery via
 *     `ipkResolve` + per-asset existence check).
 *   • `loadPyodideAssetsViaRpc` (worker-side VFS RPC read of the
 *     four runtime assets).
 *
 * The realm-host wires `runPyRealm` through `vfs` RPC ops that map
 * to `ctx.fs.readFile` / `ctx.fs.readFileBuffer`, so we mock a
 * minimal `RealmRpcClient` that responds to those two ops and pin
 * the per-asset paths the loader expects.
 *
 * Wave 2 additions wire the staged wheels into the boot path:
 *   • `loadPyodideFromVfsAssets` threads `packageBaseUrl =
 *     toPreviewUrl('/workspace/python_wheels/')` into `loadPyodide`
 *     so the lockfile's relative `file_name` resolves against the
 *     flat-staged wheel dir.
 *   • `runPyRealm` preloads `micropip` once after boot, degrading a
 *     rejecting preload (empty staging) to a warning rather than a
 *     hard boot failure.
 */

import type { PyodideInterface } from 'pyodide';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadPyodideAssetsViaRpc,
  loadPyodideFromVfsAssets,
  PYODIDE_NOT_INSTALLED,
  PYODIDE_VERSION,
  resolvePyodideLockfilePath,
  runPyRealm,
  tryResolvePyodideAssetRoot,
} from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmPortLike, RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { RealmInitMsg } from '../../../src/kernel/realm/realm-types.js';
import { sha256Hex } from '../../../src/shell/di/fetcher.js';
import { toPreviewUrl } from '../../../src/shell/supplemental-commands/shared.js';

const PKG_DIR = '/workspace/node_modules/pyodide';
const ASSET_FILES = [
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

function makeReader(files: Map<string, string>): {
  reader: {
    exists: (p: string) => Promise<boolean>;
    isDirectory: (p: string) => Promise<boolean>;
    readFile: (p: string) => Promise<string>;
  };
  fromDir: string;
} {
  return {
    reader: {
      exists: async (p) => files.has(p),
      isDirectory: async (p) => p === PKG_DIR || p === '/workspace/node_modules',
      readFile: async (p) => {
        const content = files.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
    },
    fromDir: '/workspace',
  };
}

function seedInstalled(extra: Record<string, string> = {}): Map<string, string> {
  return new Map<string, string>([
    [`${PKG_DIR}/package.json`, JSON.stringify({ name: 'pyodide', version: '314.0.0' })],
    [`${PKG_DIR}/pyodide.asm.mjs`, 'export default () => {};'],
    [`${PKG_DIR}/pyodide.asm.wasm`, '\u0000asm'],
    [`${PKG_DIR}/python_stdlib.zip`, 'PK\u0003\u0004'],
    [`${PKG_DIR}/pyodide-lock.json`, '{"packages":{}}'],
    ...Object.entries(extra),
  ]);
}

describe('tryResolvePyodideAssetRoot', () => {
  it('returns the package directory when all four assets exist', async () => {
    const ipk = makeReader(seedInstalled());
    const result = await tryResolvePyodideAssetRoot(ipk);
    expect(result).toBe(PKG_DIR);
  });

  it('returns null when pyodide/package.json is missing (uninstalled)', async () => {
    const ipk = makeReader(new Map());
    const result = await tryResolvePyodideAssetRoot(ipk);
    expect(result).toBeNull();
  });

  it.each(ASSET_FILES)('returns null when %s is missing (partial install)', async (missing) => {
    const files = seedInstalled();
    files.delete(`${PKG_DIR}/${missing}`);
    const ipk = makeReader(files);
    const result = await tryResolvePyodideAssetRoot(ipk);
    expect(result).toBeNull();
  });

  it('returns null when the resolver throws (e.g. broken node_modules tree)', async () => {
    const ipk = {
      reader: {
        exists: async () => false,
        isDirectory: async () => false,
        readFile: async () => {
          throw new Error('boom');
        },
      },
      fromDir: '/workspace',
    };
    const result = await tryResolvePyodideAssetRoot(ipk);
    expect(result).toBeNull();
  });
});

describe('loadPyodideAssetsViaRpc', () => {
  function makeRpc(handler: (op: string, args: unknown[]) => Promise<unknown>): RealmRpcClient {
    return {
      call: vi.fn((_channel: string, op: string, args: unknown[]) => handler(op, args)),
    } as unknown as RealmRpcClient;
  }

  it('reads the four assets in parallel and normalizes binary returns to Uint8Array', async () => {
    const asmJsSource = 'export default () => {};';
    const lockJsonString = '{"packages":{}}';
    const asmWasmBytes = new Uint8Array([0, 0x61, 0x73, 0x6d]);
    const stdlibBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const rpc = makeRpc(async (op, args) => {
      const path = args[0] as string;
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide.asm.mjs`) return asmJsSource;
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide-lock.json`) return lockJsonString;
      if (op === 'readFileBinary' && path === `${PKG_DIR}/pyodide.asm.wasm`) return asmWasmBytes;
      if (op === 'readFileBinary' && path === `${PKG_DIR}/python_stdlib.zip`) return stdlibBytes;
      throw new Error(`unexpected ${op} ${path}`);
    });
    const assets = await loadPyodideAssetsViaRpc(rpc, PKG_DIR);
    expect(assets).not.toBeNull();
    expect(assets?.asmJsSource).toBe(asmJsSource);
    expect(assets?.lockJsonString).toBe(lockJsonString);
    expect(assets?.asmWasmBytes).toEqual(asmWasmBytes);
    expect(assets?.stdlibBytes).toEqual(stdlibBytes);
  });

  it('normalizes ArrayBuffer binary returns to Uint8Array', async () => {
    const asmWasmAb = new Uint8Array([1, 2, 3]).buffer;
    const stdlibAb = new Uint8Array([4, 5]).buffer;
    const rpc = makeRpc(async (op, args) => {
      const path = args[0] as string;
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide.asm.mjs`) return 'x';
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide-lock.json`) return '{}';
      if (op === 'readFileBinary' && path === `${PKG_DIR}/pyodide.asm.wasm`) return asmWasmAb;
      if (op === 'readFileBinary' && path === `${PKG_DIR}/python_stdlib.zip`) return stdlibAb;
      throw new Error('unexpected');
    });
    const assets = await loadPyodideAssetsViaRpc(rpc, PKG_DIR);
    expect(assets?.asmWasmBytes).toBeInstanceOf(Uint8Array);
    expect(assets?.asmWasmBytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(assets?.stdlibBytes).toBeInstanceOf(Uint8Array);
    expect(assets?.stdlibBytes).toEqual(new Uint8Array([4, 5]));
  });

  it('returns null when any asset read fails (defensive parity with kernel-side check)', async () => {
    const rpc = makeRpc(async (op, args) => {
      const path = args[0] as string;
      if (path === `${PKG_DIR}/python_stdlib.zip`) throw new Error('ENOENT');
      if (op === 'readFile') return 'x';
      return new Uint8Array([0]);
    });
    const assets = await loadPyodideAssetsViaRpc(rpc, PKG_DIR);
    expect(assets).toBeNull();
  });
});

describe('PYODIDE_NOT_INSTALLED', () => {
  it('matches the canonical install-required loader wording, pinned to PYODIDE_VERSION', () => {
    expect(PYODIDE_NOT_INSTALLED).toBe(
      `pyodide is not installed in node_modules: run \`ipk add pyodide@${PYODIDE_VERSION}\` (no network fallback)`
    );
  });

  it('interpolates the pinned version into the install guidance', () => {
    expect(PYODIDE_NOT_INSTALLED).toContain(`ipk add pyodide@${PYODIDE_VERSION}`);
    expect(PYODIDE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('loadPyodideFromVfsAssets packageBaseUrl', () => {
  // The loader dynamically `import()`s the asm.mjs blob URL and creates
  // blob URLs for the stdlib zip. Node has no object-URL registry, so
  // stub `createObjectURL` to return a `data:` URL whose module exposes
  // a `default` export (the factory `loadPyodide` would receive) and
  // `revokeObjectURL` to a no-op. The mocked `loadPyodide` ignores both.
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(
      'data:text/javascript,export default () => ({})'
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeAssetRpc(): RealmRpcClient {
    return {
      call: vi.fn(async (_channel: string, op: string, args: unknown[]) => {
        const path = args[0] as string;
        if (op === 'readFile' && path.endsWith('pyodide.asm.mjs'))
          return 'export default () => ({});';
        if (op === 'readFile' && path.endsWith('pyodide-lock.json')) return '{"packages":{}}';
        if (op === 'readFileBinary' && path.endsWith('pyodide.asm.wasm'))
          return new Uint8Array([0, 0x61, 0x73, 0x6d]);
        if (op === 'readFileBinary' && path.endsWith('python_stdlib.zip'))
          return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        throw new Error(`unexpected ${op} ${path}`);
      }),
    } as unknown as RealmRpcClient;
  }

  it('threads packageBaseUrl = toPreviewUrl(...) into loadPyodide with a trailing slash', async () => {
    const fakePyodide = { id: 'fake' } as unknown as PyodideInterface;
    const loadPyodide = vi.fn(async () => fakePyodide);
    const mod = { loadPyodide } as unknown as typeof import('pyodide');

    const result = await loadPyodideFromVfsAssets(mod, PKG_DIR, makeAssetRpc());

    expect(result).toBe(fakePyodide);
    expect(loadPyodide).toHaveBeenCalledTimes(1);
    const cfg = (loadPyodide.mock.calls[0] as unknown[])[0] as { packageBaseUrl?: string };
    const expected = toPreviewUrl('/workspace/python_wheels/');
    expect(cfg.packageBaseUrl).toBe(expected);
    expect(cfg.packageBaseUrl?.endsWith('/')).toBe(true);
  });
});

describe('runPyRealm micropip preload', () => {
  // `runPyRealm`'s manifest-activation step issues `vfs` `exists`
  // RPC calls; a non-responding port would hang the boot forever.
  // This port answers `exists` with `false` (no manifest in the
  // fresh-VFS default case) so the existing preload assertions still
  // exercise the micropip-only path. Non-RPC outbound messages
  // (`realm-done`) are recorded for assertions via `postMessage`.
  function makePort(): RealmPortLike {
    let handler: ((event: MessageEvent) => void) | null = null;
    const postMessage = vi.fn((msg: unknown) => {
      const req = msg as { type?: string; id?: number; channel?: string; op?: string };
      if (req?.type !== 'realm-rpc-req' || req.channel !== 'vfs') return;
      queueMicrotask(() =>
        handler?.({
          data: { type: 'realm-rpc-res', id: req.id, result: false },
        } as MessageEvent)
      );
    });
    return {
      postMessage,
      addEventListener: vi.fn((_type: 'message', h: (event: MessageEvent) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };
  }

  function makeFakePyodide(loadPackage: (names: string[]) => Promise<unknown>): PyodideInterface {
    return {
      loadPackage,
      setStdout: vi.fn(),
      setStderr: vi.fn(),
      setStdin: vi.fn(),
      registerJsModule: vi.fn(),
      runPythonAsync: vi.fn(async () => undefined),
      runPython: vi.fn(),
      globals: { set: vi.fn(), get: vi.fn(() => 0) },
      FS: { chdir: vi.fn() },
    } as unknown as PyodideInterface;
  }

  function makeInit(): RealmInitMsg {
    return {
      type: 'realm-init',
      kind: 'py',
      code: 'print(1)',
      argv: [],
      env: {},
      cwd: '/workspace',
      filename: '<eval>',
      pyodideIndexURL: 'file:///fake/pyodide/',
    };
  }

  function postedMessages(port: RealmPortLike): { type: string; stderr?: string }[] {
    return (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { type: string; stderr?: string }
    );
  }

  it('calls loadPackage(["micropip"]) exactly once after boot', async () => {
    const loadPackage = vi.fn(async () => undefined);
    const fake = makeFakePyodide(loadPackage);
    const loaderImport = async (): Promise<typeof import('pyodide')> =>
      ({ loadPyodide: vi.fn(async () => fake) }) as unknown as typeof import('pyodide');

    await runPyRealm(makeInit(), makePort(), loaderImport);

    expect(loadPackage).toHaveBeenCalledTimes(1);
    expect(loadPackage).toHaveBeenCalledWith(['micropip']);
  });

  it('survives an empty staging dir: a rejecting micropip preload degrades to a warning, not a hard boot failure', async () => {
    const loadPackage = vi.fn(async () => {
      throw new Error('No known package matching micropip');
    });
    const fake = makeFakePyodide(loadPackage);
    const loaderImport = async (): Promise<typeof import('pyodide')> =>
      ({ loadPyodide: vi.fn(async () => fake) }) as unknown as typeof import('pyodide');
    const port = makePort();

    await runPyRealm(makeInit(), port, loaderImport);

    const posted = postedMessages(port);
    // Boot must complete with a `realm-done` (clean boot), never a
    // `realm-error` (which is reserved for pre-user-code load failures).
    const done = posted.find((m) => m.type === 'realm-done');
    expect(done).toBeDefined();
    expect(posted.some((m) => m.type === 'realm-error')).toBe(false);
    expect(done?.stderr).toContain('micropip preload failed');
    expect(loadPackage).toHaveBeenCalledTimes(1);
  });
});

describe('runPyRealm micropip wheel auto-staging', () => {
  const LOCKFILE_PATH = '/workspace/node_modules/pyodide/pyodide-lock.json';
  const WHEELS_DIR = '/workspace/python_wheels';
  const WHEEL_FILE = 'micropip-0.6.0-py3-none-any.whl';
  const WHEEL_PATH = `${WHEELS_DIR}/${WHEEL_FILE}`;

  // Stateful port: serves the ipk-installed lockfile + a stubbed CDN
  // wheel fetch, and records `writeFileBinary` so the test can assert
  // the wheel lands in the flat-staged dir. Records the order of
  // `fetch` vs `loadPackage` indirectly: `loadPackage` is only invoked
  // after `preloadMicropip` awaits the staging round-trip.
  function makeStagingPort(opts: {
    files: Map<string, string>;
    fetchBody: Uint8Array;
    written: Map<string, Uint8Array>;
  }): RealmPortLike {
    let handler: ((event: MessageEvent) => void) | null = null;
    const postMessage = vi.fn((msg: unknown) => {
      const req = msg as {
        type?: string;
        id?: number;
        channel?: string;
        op?: string;
        args?: unknown[];
      };
      if (req?.type !== 'realm-rpc-req') return;
      const respond = (result: unknown): void => {
        queueMicrotask(() =>
          handler?.({ data: { type: 'realm-rpc-res', id: req.id, result } } as MessageEvent)
        );
      };
      const args = req.args ?? [];
      if (req.channel === 'vfs') {
        const path = args[0] as string;
        switch (req.op) {
          case 'exists':
            return respond(opts.files.has(path) || opts.written.has(path));
          case 'readFile':
            return respond(opts.files.get(path) ?? '');
          case 'mkdir':
            return respond(true);
          case 'writeFileBinary':
            opts.written.set(path, args[1] as Uint8Array);
            return respond(true);
          default:
            return respond(false);
        }
      }
      if (req.channel === 'fetch' && req.op === 'request') {
        return respond({
          status: 200,
          statusText: 'OK',
          headers: {},
          body: opts.fetchBody,
          url: args[0] as string,
        });
      }
      respond(false);
    });
    return {
      postMessage,
      addEventListener: vi.fn((_type: 'message', h: (event: MessageEvent) => void) => {
        handler = h;
      }),
      removeEventListener: vi.fn(),
    };
  }

  function makeFakePyodide(loadPackage: (names: string[]) => Promise<unknown>): PyodideInterface {
    return {
      loadPackage,
      setStdout: vi.fn(),
      setStderr: vi.fn(),
      setStdin: vi.fn(),
      registerJsModule: vi.fn(),
      runPythonAsync: vi.fn(async () => undefined),
      runPython: vi.fn(),
      globals: { set: vi.fn(), get: vi.fn(() => 0) },
      FS: { chdir: vi.fn() },
    } as unknown as PyodideInterface;
  }

  function makeInit(): RealmInitMsg {
    return {
      type: 'realm-init',
      kind: 'py',
      code: 'print(1)',
      argv: [],
      env: {},
      cwd: '/workspace',
      filename: '<eval>',
      pyodideIndexURL: 'file:///fake/pyodide/',
    };
  }

  it('fetches + stages the micropip wheel, then calls loadPackage(["micropip"]) once', async () => {
    const fetchBody = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x10, 0x20, 0x30]);
    const sha256 = await sha256Hex(fetchBody);
    const files = new Map<string, string>([
      [
        LOCKFILE_PATH,
        JSON.stringify({
          packages: {
            micropip: { name: 'micropip', version: '0.6.0', file_name: WHEEL_FILE, sha256 },
          },
        }),
      ],
    ]);
    const written = new Map<string, Uint8Array>();
    const port = makeStagingPort({ files, fetchBody, written });

    const loadPackage = vi.fn(async () => undefined);
    const fake = makeFakePyodide(loadPackage);
    const loaderImport = async (): Promise<typeof import('pyodide')> =>
      ({ loadPyodide: vi.fn(async () => fake) }) as unknown as typeof import('pyodide');

    await runPyRealm(makeInit(), port, loaderImport);

    // Wheel ended up in the flat-staged dir with the fetched bytes.
    expect(written.has(WHEEL_PATH)).toBe(true);
    expect(written.get(WHEEL_PATH)).toEqual(fetchBody);
    // loadPackage ran exactly once, after staging.
    expect(loadPackage).toHaveBeenCalledTimes(1);
    expect(loadPackage).toHaveBeenCalledWith(['micropip']);
  });

  it('skips the fetch when the wheel is already staged', async () => {
    const fetchBody = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await sha256Hex(fetchBody);
    const files = new Map<string, string>([
      [
        LOCKFILE_PATH,
        JSON.stringify({
          packages: {
            micropip: { name: 'micropip', version: '0.6.0', file_name: WHEEL_FILE, sha256 },
          },
        }),
      ],
    ]);
    // Pre-stage the wheel so `exists(WHEEL_PATH)` short-circuits.
    const written = new Map<string, Uint8Array>([[WHEEL_PATH, fetchBody]]);
    const port = makeStagingPort({ files, fetchBody, written });

    const loadPackage = vi.fn(async () => undefined);
    const fake = makeFakePyodide(loadPackage);
    const loaderImport = async (): Promise<typeof import('pyodide')> =>
      ({ loadPyodide: vi.fn(async () => fake) }) as unknown as typeof import('pyodide');

    await runPyRealm(makeInit(), port, loaderImport);

    const fetchCalls = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { channel?: string }).channel === 'fetch'
    );
    expect(fetchCalls).toHaveLength(0);
    expect(loadPackage).toHaveBeenCalledTimes(1);
    expect(loadPackage).toHaveBeenCalledWith(['micropip']);
  });
});

describe('resolvePyodideLockfilePath', () => {
  // Regression: `ipk add pyodide` can land outside `/workspace/node_modules`
  // (e.g. a root-level `/node_modules`). Micropip staging MUST follow the
  // resolved `pyodideAssetRoot`, otherwise the lockfile read misses and
  // micropip is silently never staged (every later `import micropip` fails).
  it('derives the lockfile path from a resolved asset root', () => {
    expect(resolvePyodideLockfilePath('/node_modules/pyodide')).toBe(
      '/node_modules/pyodide/pyodide-lock.json'
    );
    expect(resolvePyodideLockfilePath('/workspace/node_modules/pyodide')).toBe(
      '/workspace/node_modules/pyodide/pyodide-lock.json'
    );
  });

  it('falls back to the fixed /workspace path when no asset root is given', () => {
    expect(resolvePyodideLockfilePath(undefined)).toBe(
      '/workspace/node_modules/pyodide/pyodide-lock.json'
    );
  });
});
