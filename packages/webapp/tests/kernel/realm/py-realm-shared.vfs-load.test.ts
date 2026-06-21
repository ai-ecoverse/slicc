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
 */

import { describe, expect, it, vi } from 'vitest';
import {
  loadPyodideAssetsViaRpc,
  PYODIDE_NOT_INSTALLED,
  PYODIDE_VERSION,
  tryResolvePyodideAssetRoot,
} from '../../../src/kernel/realm/py-realm-shared.js';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';

const PKG_DIR = '/workspace/node_modules/pyodide';
const ASSET_FILES = [
  'pyodide.asm.js',
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
    [`${PKG_DIR}/package.json`, JSON.stringify({ name: 'pyodide', version: '0.29.4' })],
    [`${PKG_DIR}/pyodide.asm.js`, 'globalThis._createPyodideModule = () => {};'],
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
    const asmJsSource = 'globalThis._createPyodideModule = () => {};';
    const lockJsonString = '{"packages":{}}';
    const asmWasmBytes = new Uint8Array([0, 0x61, 0x73, 0x6d]);
    const stdlibBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const rpc = makeRpc(async (op, args) => {
      const path = args[0] as string;
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide.asm.js`) return asmJsSource;
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
      if (op === 'readFile' && path === `${PKG_DIR}/pyodide.asm.js`) return 'x';
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
