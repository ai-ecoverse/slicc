import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';
import {
  ESBUILD_VERSION,
  getEsbuild,
  resetEsbuildForTests,
  tryLoadEsbuildWasmFromNodeModules,
} from '../../../src/shell/supplemental-commands/esbuild-wasm.js';
import { GLOBAL_IPK_ADD } from '../../../src/shell/supplemental-commands/shared.js';

const bootstrap = `${GLOBAL_IPK_ADD} esbuild-wasm@${ESBUILD_VERSION}`;

afterEach(() => {
  vi.unstubAllGlobals();
  resetEsbuildForTests();
});

describe('getEsbuild browser recovery guidance', () => {
  it('uses the pinned bootstrap when no ipk context is available', async () => {
    vi.stubGlobal('process', undefined);

    const error = await getEsbuild().catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `esbuild-wasm is not available: install via \`${bootstrap}\``
    );
    expect((error as Error).message).not.toContain('ipx esbuild');
  });

  it('uses the pinned bootstrap when esbuild-wasm is not installed', async () => {
    vi.stubGlobal('process', undefined);
    const reader: ModuleReader = {
      exists: async () => false,
      isDirectory: async () => false,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    };

    const error = await getEsbuild({
      ipk: { reader, readBytes: async () => new Uint8Array(), fromDir: '/workspace' },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `esbuild-wasm is not installed in node_modules: run \`${bootstrap}\`` +
        ` (searched from /workspace: /workspace/node_modules, /node_modules, ${GLOBAL_NODE_MODULES})`
    );
    expect((error as Error).message).not.toContain('ipx esbuild');
  });
});

/**
 * Resolution of the binary inside an ipk-installed package. The loader reads
 * `esbuild.wasm` from exactly one place — the package root, where every
 * release since 0.5.0 has shipped it — and answers `null` for every miss so
 * `getEsbuild` can raise its "not installed" guidance. Mocked filesystem, so
 * this pins the walk and the miss handling; `esbuild-wasm-live.test.ts` is
 * what proves the hardcoded location still matches the real package.
 */
describe('tryLoadEsbuildWasmFromNodeModules', () => {
  const PKG_DIR = '/workspace/node_modules/esbuild-wasm';
  const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);

  function installedReader(files: string[]): ModuleReader {
    const present = new Set(files);
    return {
      exists: async (p) => present.has(p) || [...present].some((f) => f.startsWith(`${p}/`)),
      isDirectory: async (p) => [...present].some((f) => f.startsWith(`${p}/`)),
      readFile: async (p) => {
        if (p === `${PKG_DIR}/package.json`) {
          return JSON.stringify({ name: 'esbuild-wasm', version: ESBUILD_VERSION });
        }
        throw new Error(`ENOENT: ${p}`);
      },
    };
  }

  it('walks up from a nested cwd and reads the binary beside package.json', async () => {
    const readBytes = vi.fn(async () => WASM);
    const binary = await tryLoadEsbuildWasmFromNodeModules({
      reader: installedReader([`${PKG_DIR}/package.json`, `${PKG_DIR}/esbuild.wasm`]),
      readBytes,
      fromDir: '/workspace/src/deep',
    });

    expect(binary).toEqual({ packageDir: PKG_DIR, bytes: WASM });
    expect(readBytes).toHaveBeenCalledWith(`${PKG_DIR}/esbuild.wasm`);
  });

  it('answers null when the package resolves but the binary is not where the loader looks', async () => {
    // A release that moves the binary (the magick 0.0.43 shape) resolves the
    // package fine and must still surface as "not installed", never as a
    // read of a path that does not exist.
    const readBytes = vi.fn(async () => WASM);
    const binary = await tryLoadEsbuildWasmFromNodeModules({
      reader: installedReader([`${PKG_DIR}/package.json`, `${PKG_DIR}/dist/esbuild.wasm`]),
      readBytes,
      fromDir: '/workspace',
    });

    expect(binary).toBeNull();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('answers null when no esbuild-wasm is installed on the walk', async () => {
    const binary = await tryLoadEsbuildWasmFromNodeModules({
      reader: installedReader([]),
      readBytes: async () => WASM,
      fromDir: '/workspace',
    });

    expect(binary).toBeNull();
  });

  it('answers null when the binary exists but cannot be read', async () => {
    const binary = await tryLoadEsbuildWasmFromNodeModules({
      reader: installedReader([`${PKG_DIR}/package.json`, `${PKG_DIR}/esbuild.wasm`]),
      readBytes: async () => {
        throw new Error('EIO');
      },
      fromDir: '/workspace',
    });

    expect(binary).toBeNull();
  });
});
