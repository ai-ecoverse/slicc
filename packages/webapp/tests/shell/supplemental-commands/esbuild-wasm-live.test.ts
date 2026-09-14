import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as EsbuildNs from 'esbuild-wasm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNodeRuntime: () => false,
}));

vi.mock('esbuild-wasm', async () => {
  const glue = await import('esbuild-wasm/lib/browser.js');
  return (glue as { default?: typeof EsbuildNs }).default ?? glue;
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../../../../../node_modules/esbuild-wasm');
const WEBAPP_PKG_JSON = resolve(HERE, '../../../package.json');

const WASM_RELATIVE_PATH = 'esbuild.wasm';

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/esbuild-wasm`;

describe('esbuild-wasm live round-trip (real installed package)', () => {
  let esbuild: typeof EsbuildNs;
  let installedVersion: string;

  beforeAll(async () => {
    vi.stubGlobal('self', globalThis);
    expect(
      existsSync(`${PKG}/${WASM_RELATIVE_PATH}`),
      `no ${WASM_RELATIVE_PATH} under ${PKG} — esbuild-wasm changed its on-disk layout; ` +
        'update tryLoadEsbuildWasmFromNodeModules in esbuild-wasm.ts to match'
    ).toBe(true);

    const wasm = new Uint8Array(readFileSync(`${PKG}/${WASM_RELATIVE_PATH}`));
    const pkgJson = readFileSync(`${PKG}/package.json`, 'utf8');
    installedVersion = (JSON.parse(pkgJson) as { version: string }).version;

    const present = new Set([`${VFS_PKG}/package.json`, `${VFS_PKG}/${WASM_RELATIVE_PATH}`]);
    const ipk = {
      fromDir: VFS_ROOT,
      reader: {
        exists: async (path: string) => present.has(path),
        isDirectory: async (path: string) =>
          [...present].some((file) => file.startsWith(`${path}/`)),
        readFile: async (path: string) => {
          if (path === `${VFS_PKG}/package.json`) return pkgJson;
          throw new Error(`ENOENT: ${path}`);
        },
      },
      readBytes: async (path: string) =>
        path.endsWith('package.json') ? new TextEncoder().encode(pkgJson) : wasm,
    };
    const { getEsbuild } = await import('../../../src/shell/supplemental-commands/esbuild-wasm.js');
    esbuild = await getEsbuild({ ipk });
  }, 60_000);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('advertises the installed version, which is the version the bootstrap hint pins', async () => {
    const { ESBUILD_VERSION } = await import(
      '../../../src/shell/supplemental-commands/esbuild-wasm.js'
    );

    expect(ESBUILD_VERSION).toBe(installedVersion);
    const webappPkg = JSON.parse(readFileSync(WEBAPP_PKG_JSON, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(webappPkg.dependencies['esbuild-wasm']?.replace(/^[\^~]/, '')).toBe(ESBUILD_VERSION);
  });

  it('transforms TypeScript to JavaScript through the in-thread wasm service', async () => {
    const result = await esbuild.transform('const answer: number = 42; export { answer };', {
      loader: 'ts',
      format: 'cjs',
    });

    expect(result.code).toContain('const answer = 42');
    expect(result.code).not.toContain(': number');
    expect(result.code).toContain('exports');
  });

  it('bundles a virtual import graph through the plugin API', async () => {
    const result = await esbuild.build({
      stdin: { contents: 'import { leaf } from "virtual:leaf"; console.log(leaf);' },
      bundle: true,
      write: false,
      format: 'esm',
      plugins: [
        {
          name: 'virtual',
          setup(build) {
            build.onResolve({ filter: /^virtual:/ }, (args) => ({
              path: args.path,
              namespace: 'virtual',
            }));
            build.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
              contents: 'export const leaf = "LEAF_MARKER";',
            }));
          },
        },
      ],
    });
    expect(result.errors).toEqual([]);
    const output = result.outputFiles?.[0]?.text ?? '';

    expect(output).toContain('LEAF_MARKER');
    expect(output).not.toMatch(/from\s+["']virtual:leaf["']/);
  });
});
