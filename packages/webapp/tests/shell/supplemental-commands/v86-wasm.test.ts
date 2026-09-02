/**
 * Resolution and contract tests for the v86 loader, over a synthetic
 * VFS. The live canary (`v86-wasm-live.test.ts`) is what touches the real
 * package; these pin the loader's behaviour for every supported layout
 * and every miss path without any package on disk.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GLOBAL_IPK_ADD } from '../../../src/shell/supplemental-commands/shared.js';
import {
  getV86Module,
  resetV86ForTests,
  tryLoadV86FromNodeModules,
  V86_LAYOUT_CANDIDATES,
  V86_NOT_INSTALLED,
  V86_PINNED_VERSION,
} from '../../../src/shell/supplemental-commands/v86-wasm.js';

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/v86`;
const MANIFEST = JSON.stringify({ name: 'v86', version: '0.5.999', main: 'build/libv86.mjs' });
const GLUE = 'export class V86 {}';
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

/**
 * Synthetic ipk context over an in-memory file map. `readFile` serves
 * strings, `readBytes` serves bytes; either can be forced to throw to
 * exercise the read-failure paths.
 */
function makeIpk(
  files: Record<string, string | Uint8Array>,
  opts: { failRead?: string; failBytes?: string } = {}
) {
  const paths = Object.keys(files);
  return {
    fromDir: VFS_ROOT,
    reader: {
      exists: async (path: string) => path in files,
      isDirectory: async (path: string) => paths.some((file) => file.startsWith(`${path}/`)),
      readFile: async (path: string) => {
        const body = files[path];
        if (body === undefined || path === opts.failRead) throw new Error(`ENOENT: ${path}`);
        return typeof body === 'string' ? body : new TextDecoder().decode(body);
      },
    },
    readBytes: async (path: string) => {
      const body = files[path];
      if (body === undefined || path === opts.failBytes) throw new Error(`ENOENT: ${path}`);
      return typeof body === 'string' ? new TextEncoder().encode(body) : body;
    },
  };
}

function install(layout: { js: string; wasm: string }, manifest = MANIFEST) {
  return {
    [`${VFS_PKG}/package.json`]: manifest,
    [`${VFS_PKG}/${layout.js}`]: GLUE,
    [`${VFS_PKG}/${layout.wasm}`]: WASM,
  };
}

describe('tryLoadV86FromNodeModules', () => {
  it.each(V86_LAYOUT_CANDIDATES.map((layout) => [`${layout.js} + ${layout.wasm}`, layout]))(
    'resolves the %s layout',
    async (_label, layout) => {
      const loaded = await tryLoadV86FromNodeModules(makeIpk(install(layout)));
      expect(loaded).not.toBeNull();
      expect(loaded?.jsSource).toBe(GLUE);
      expect(loaded?.wasmBytes).toBe(WASM);
      expect(loaded?.version).toBe('0.5.999');
    }
  );

  it('returns null when v86 is not installed at all', async () => {
    expect(await tryLoadV86FromNodeModules(makeIpk({}))).toBeNull();
  });

  it('returns null when the package is present in an unknown layout', async () => {
    // The pre-0.5 fork layout: a real historical shape that is deliberately
    // not a candidate (different publisher, different API).
    const files = {
      [`${VFS_PKG}/package.json`]: MANIFEST,
      [`${VFS_PKG}/build/index.js`]: GLUE,
      [`${VFS_PKG}/build/v86.wasm`]: WASM,
    };
    expect(await tryLoadV86FromNodeModules(makeIpk(files))).toBeNull();
  });

  it.each(V86_LAYOUT_CANDIDATES)(
    'returns null when only one half of a layout is present',
    async (layout) => {
      const glueOnly = install(layout);
      delete glueOnly[`${VFS_PKG}/${layout.wasm}`];
      expect(await tryLoadV86FromNodeModules(makeIpk(glueOnly))).toBeNull();
      const wasmOnly = install(layout);
      delete wasmOnly[`${VFS_PKG}/${layout.js}`];
      expect(await tryLoadV86FromNodeModules(makeIpk(wasmOnly))).toBeNull();
    }
  );

  it('returns null when the manifest, glue, or engine cannot be read', async () => {
    const layout = V86_LAYOUT_CANDIDATES[0]!;
    const files = install(layout);
    expect(
      await tryLoadV86FromNodeModules(makeIpk(files, { failRead: `${VFS_PKG}/package.json` }))
    ).toBeNull();
    expect(
      await tryLoadV86FromNodeModules(makeIpk(files, { failRead: `${VFS_PKG}/${layout.js}` }))
    ).toBeNull();
    expect(
      await tryLoadV86FromNodeModules(makeIpk(files, { failBytes: `${VFS_PKG}/${layout.wasm}` }))
    ).toBeNull();
  });

  it('falls back to the pinned version when the manifest carries none', async () => {
    const loaded = await tryLoadV86FromNodeModules(
      makeIpk(install(V86_LAYOUT_CANDIDATES[0]!, JSON.stringify({ name: 'v86' })))
    );
    expect(loaded?.version).toBe(V86_PINNED_VERSION);
  });
});

describe('v86 loader contract', () => {
  it('pins the install guidance to the exact devDependency version', () => {
    expect(V86_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(V86_NOT_INSTALLED).toContain(`${GLOBAL_IPK_ADD} v86@${V86_PINNED_VERSION}`);
    expect(V86_NOT_INSTALLED).not.toMatch(/https?:\/\//);
  });

  it('refuses to load the engine in the Node runtime', async () => {
    resetV86ForTests();
    await expect(getV86Module()).rejects.toThrow(/not available in Node runtime/);
    resetV86ForTests();
  });

  /**
   * `v86` sits in webapp's devDependencies for the version define and the
   * live canary only. A static or dynamic import from any v86 source module
   * would put the ~350 kB glue into the kernel worker's cold-boot graph —
   * a bundling-shape invariant no runtime test can see, so it is pinned at
   * the source level like the magick import-shape test.
   */
  it('never imports the v86 package from source', () => {
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../src/shell/supplemental-commands'
    );
    for (const file of ['v86-wasm.ts', 'v86-vm.ts', 'v86-command.ts']) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      expect(source, `${file} imports the v86 package`).not.toMatch(/from\s+['"]v86['"]/);
      expect(source, `${file} imports the v86 package`).not.toMatch(/import\(\s*['"]v86['"]/);
    }
  });
});
