/**
 * `getEsbuild` wasm-service handshake tests (#2200).
 *
 * The browser loader used to await `esbuild.initialize()` unbounded, so a
 * handshake that never settled hung every ESM transpile and the `esbuild`
 * command with no output and no error — and, because the module-scope cache
 * was cleared only in `.catch`, the never-settling promise poisoned every
 * later call for the rest of the session.
 *
 * These tests drive the real loader with `esbuild-wasm` and the host wasm
 * compiler mocked, so the browser branch runs end to end without the 14 MB
 * binary: a stalled `initialize` must REJECT inside the budget with the
 * resolved package path and byte count, and must not leave a pending promise
 * behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';
import {
  EsbuildInitStallError,
  getEsbuild,
  type IpkResolutionContext,
  resetEsbuildForTests,
} from '../../../src/shell/supplemental-commands/esbuild-wasm.js';

/** `initialize` behavior for the current test, set per case. */
let initializeImpl: () => Promise<void> = () => Promise.resolve();
const initialize = vi.fn(() => initializeImpl());

vi.mock('esbuild-wasm', () => ({
  version: '0.28.2',
  initialize: (...args: unknown[]) => initialize(...(args as [])),
  transform: () => Promise.resolve({ code: '' }),
}));

vi.mock('../../../src/kernel/realm/wasm-compiler.js', () => ({
  compileWasmModule: () => Promise.resolve({} as WebAssembly.Module),
}));

// Force the BROWSER branch (the Node branch never calls `initialize`).
// Faking it through the runtime predicates instead of `vi.stubGlobal('process',
// undefined)` keeps vitest's own `process.nextTick` intact.
vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shell/supplemental-commands/shared.js')>()),
  isNodeRuntime: () => false,
  isExtensionRuntime: () => false,
}));

const WASM_BYTES = new Uint8Array(4096);

function installedIpkContext(fromDir = '/workspace'): IpkResolutionContext {
  const files = new Set([
    '/workspace/node_modules/esbuild-wasm/package.json',
    '/workspace/node_modules/esbuild-wasm/esbuild.wasm',
  ]);
  const dirs = new Set([
    '/',
    '/workspace',
    '/workspace/node_modules',
    '/workspace/node_modules/esbuild-wasm',
  ]);
  const reader: ModuleReader = {
    exists: async (p) => files.has(p) || dirs.has(p),
    isDirectory: async (p) => dirs.has(p),
    readFile: async (p) => {
      if (p === '/workspace/node_modules/esbuild-wasm/package.json') {
        return JSON.stringify({ name: 'esbuild-wasm', version: '0.28.2' });
      }
      throw new Error(`ENOENT: ${p}`);
    },
  };
  return { reader, readBytes: async () => WASM_BYTES, fromDir };
}

beforeEach(() => {
  initialize.mockClear();
  initializeImpl = () => Promise.resolve();
  resetEsbuildForTests({ initTimeoutMs: 25 });
});

afterEach(() => {
  resetEsbuildForTests();
});

describe('getEsbuild wasm-service handshake', () => {
  it('rejects with the resolved path, byte count and budget when initialize never settles', async () => {
    initializeImpl = () => new Promise<void>(() => {});

    const error = await getEsbuild({ ipk: installedIpkContext() }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(EsbuildInitStallError);
    const message = (error as Error).message;
    expect(message).toContain('/workspace/node_modules/esbuild-wasm');
    expect(message).toContain(`${WASM_BYTES.byteLength} bytes`);
    expect(message).toContain('did not start within');
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('does not poison the session: a later call fails fast instead of awaiting the stalled load', async () => {
    initializeImpl = () => new Promise<void>(() => {});
    const stalled = (await getEsbuild({ ipk: installedIpkContext() }).catch(
      (cause: unknown) => cause
    )) as EsbuildInitStallError;
    initialize.mockClear();

    // The stalled attempt is abandoned, not cached: a later call (any cwd)
    // must re-report the stall immediately rather than await a promise that
    // will never settle, and must NOT start a second `initialize` (esbuild
    // permits exactly one per realm).
    const second = await Promise.race([
      getEsbuild({ ipk: installedIpkContext('/shared') }).catch((cause: unknown) => cause),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 500)),
    ]);

    expect(second).toBeInstanceOf(EsbuildInitStallError);
    expect((second as Error).message).toBe(stalled.message);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('names the walked node_modules directories when nothing is installed', async () => {
    const reader: ModuleReader = {
      exists: async () => false,
      isDirectory: async () => false,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    };

    const error = await getEsbuild({
      ipk: { reader, readBytes: async () => new Uint8Array(), fromDir: '/shared/nodetest' },
    }).catch((cause: unknown) => cause);

    const message = (error as Error).message;
    expect(message).toContain('esbuild-wasm is not installed in node_modules');
    expect(message).toContain('searched from /shared/nodetest');
    expect(message).toContain('/shared/nodetest/node_modules');
    expect(message).toContain('/shared/node_modules');
    expect(message).toContain('/node_modules');
  });

  it('caches a successful load so initialize runs once per session', async () => {
    const ipk = installedIpkContext();
    const first = await getEsbuild({ ipk });
    const second = await getEsbuild({ ipk });

    expect(second).toBe(first);
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('boots in-thread (`worker: false`) so no nested blob Worker can stall the handshake', async () => {
    await getEsbuild({ ipk: installedIpkContext() });

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ worker: false, wasmModule: expect.anything() })
    );
  });

  it('retries after a REJECTED load (a package installed in the meantime resolves)', async () => {
    const missing: ModuleReader = {
      exists: async () => false,
      isDirectory: async () => false,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    };
    await expect(
      getEsbuild({
        ipk: { reader: missing, readBytes: async () => new Uint8Array(), fromDir: '/shared' },
      })
    ).rejects.toThrow(/not installed/);

    await expect(getEsbuild({ ipk: installedIpkContext() })).resolves.toBeDefined();
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
