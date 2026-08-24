import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';
import {
  ESBUILD_VERSION,
  getEsbuild,
  resetEsbuildForTests,
} from '../../../src/shell/supplemental-commands/esbuild-wasm.js';

const bootstrap = `ipk add esbuild-wasm@${ESBUILD_VERSION}`;

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
