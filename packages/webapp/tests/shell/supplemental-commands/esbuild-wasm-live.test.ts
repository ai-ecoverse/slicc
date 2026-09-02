/**
 * Live canary for the bundled `esbuild-wasm` glue.
 *
 * Every other esbuild test drives the loader over a synthetic file map or a
 * mocked `esbuild-wasm`, so all of them stay green when the real package
 * changes shape underneath us — the failure mode PR #2744 hit with
 * `@imagemagick/magick-wasm` (see `magick-wasm-live.test.ts`). The loader
 * reads `esbuild.wasm` from ONE hardcoded place inside the installed
 * package, and a release that moves it would make `esbuild` report "not
 * installed" while the unit suite passes.
 *
 * This test uses the REAL installed package — its actual layout, its actual
 * `esbuild.wasm`, its actual browser glue — and runs one real transform and
 * one real bundle through `getEsbuild`. It is the check that fails when a
 * dependency update changes the package's shape, its exports, or its ABI.
 * Keep it pointed at the installed copy.
 *
 * Two things are deliberately redirected, and both point AT the production
 * path rather than away from it:
 *
 * - `isNodeRuntime` is forced false so the loader takes the browser branch
 *   (compile bytes to a `WebAssembly.Module`, `initialize({ wasmModule,
 *   worker: false })`) — the path every SLICC float actually runs.
 * - `esbuild-wasm` is resolved to `lib/browser.js`, the file Vite picks
 *   through the package's `browser` field for the kernel-worker bundle.
 *   Under vitest the bare specifier resolves to `lib/main.js` (the `main`
 *   field), whose Node service spawns a wasm subprocess and REJECTS the
 *   `wasmModule` / `worker` options outright — it cannot exercise the
 *   browser branch at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as EsbuildNs from 'esbuild-wasm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNodeRuntime: () => false,
}));

// `lib/browser.js` is CommonJS; its exports object is the `default` of the
// interop namespace.
vi.mock('esbuild-wasm', async () => {
  const glue = await import('esbuild-wasm/lib/browser.js');
  return (glue as { default?: typeof EsbuildNs }).default ?? glue;
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '../../../../../node_modules/esbuild-wasm');
const WEBAPP_PKG_JSON = resolve(HERE, '../../../package.json');

/**
 * The one location the loader reads (`tryLoadEsbuildWasmFromNodeModules`).
 * Every `esbuild-wasm` release from 0.5.0 through the pinned version has
 * shipped the binary here; a release that moves it fails the precondition
 * below by name instead of surfacing as a mysterious "not installed".
 */
const WASM_RELATIVE_PATH = 'esbuild.wasm';

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/esbuild-wasm`;

describe('esbuild-wasm live round-trip (real installed package)', () => {
  let esbuild: typeof EsbuildNs;
  let installedVersion: string;

  beforeAll(async () => {
    // The in-thread (`worker: false`) service snapshots its globals off
    // `self`, which every browser realm has and Node does not. Alias it so
    // the glue sees the same host it sees inside the kernel worker.
    vi.stubGlobal('self', globalThis);
    expect(
      existsSync(`${PKG}/${WASM_RELATIVE_PATH}`),
      `no ${WASM_RELATIVE_PATH} under ${PKG} — esbuild-wasm changed its on-disk layout; ` +
        'update tryLoadEsbuildWasmFromNodeModules in esbuild-wasm.ts to match'
    ).toBe(true);

    const wasm = new Uint8Array(readFileSync(`${PKG}/${WASM_RELATIVE_PATH}`));
    const pkgJson = readFileSync(`${PKG}/package.json`, 'utf8');
    installedVersion = (JSON.parse(pkgJson) as { version: string }).version;
    // Mirror the real layout into the VFS the loader walks.
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
    // `ipk add esbuild-wasm@<ESBUILD_VERSION>` must name the same release the
    // bundled glue came from, or the VFS install and the glue drift apart.
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
    // Type annotation stripped and the export lowered — a real transform, not
    // a passthrough.
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
    // The import was resolved and inlined, not left for a runtime loader.
    expect(output).toContain('LEAF_MARKER');
    expect(output).not.toMatch(/from\s+["']virtual:leaf["']/);
  });
});
