/**
 * Unit coverage for the ESM wiring in the host module-loader + entry
 * transpiler: tagged specifier extraction (`extractModuleSpecifiers`), dynamic
 * import detection (`hasDynamicImport`), the entry-code transpile hook
 * (`createEntryTranspile`), and `buildRealmModuleGraph` (per-entry isolation,
 * per-kind exports conditions, and `entrySource` presence).
 */
import { describe, expect, it } from 'vitest';
import { normalizePath, splitPath } from '../../../src/fs/path-utils.js';
import { createEntryTranspile } from '../../../src/shell/ipk/esm-transpile.js';
import {
  buildRealmModuleGraph,
  extractModuleSpecifiers,
} from '../../../src/shell/ipk/module-loader.js';
import { hasDynamicImport, type ModuleReader } from '../../../src/shell/ipk/resolver.js';
import { getTypeScript } from '../../../src/shell/supplemental-commands/shared.js';

function makeReader(files: Record<string, string>): ModuleReader {
  const norm: Record<string, string> = {};
  const dirs = new Set<string>(['/']);
  for (const [key, value] of Object.entries(files)) {
    const p = normalizePath(key);
    norm[p] = value;
    let dir = splitPath(p).dir;
    while (dir && dir !== '/') {
      dirs.add(dir);
      dir = splitPath(dir).dir;
    }
  }
  const fileSet = new Set(Object.keys(norm));
  return {
    exists: async (path) => fileSet.has(normalizePath(path)) || dirs.has(normalizePath(path)),
    isDirectory: async (path) => dirs.has(normalizePath(path)),
    readFile: async (path) => {
      const p = normalizePath(path);
      if (!(p in norm)) throw new Error(`ENOENT: ${p}`);
      return norm[p];
    },
  };
}

/** Run a transpiled entry body in an AsyncFunction with a require stub. */
async function runEntry(
  code: string,
  requireImpl: (id: string) => unknown
): Promise<{ logs: unknown[][] }> {
  const logs: unknown[][] = [];
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn('require', 'console', `"use strict";\n${code}`);
  await fn(requireImpl, { log: (...parts: unknown[]) => logs.push(parts) });
  return { logs };
}

describe('extractModuleSpecifiers()', () => {
  it('tags require() as require and every import form as import', () => {
    const src = [
      "const a = require('a');",
      "import def from 'b';",
      "import { named } from 'c';",
      "import * as ns from 'd';",
      "import combined, { x } from 'e';",
      "import 'side-effect';",
      "export { thing } from 'f';",
      "export * from 'g';",
      "import('h').then(() => {});",
    ].join('\n');
    const specs = extractModuleSpecifiers(src);
    const byId = Object.fromEntries(specs.map((s) => [s.specifier, s.kind]));
    expect(byId).toEqual({
      a: 'require',
      b: 'import',
      c: 'import',
      d: 'import',
      e: 'import',
      'side-effect': 'import',
      f: 'import',
      g: 'import',
      h: 'import',
    });
  });

  it('handles multi-line import statements', () => {
    const src = "import {\n  one,\n  two,\n} from 'multi';";
    expect(extractModuleSpecifiers(src)).toEqual([{ specifier: 'multi', kind: 'import' }]);
  });

  it('lets import win when a specifier appears as both require and import', () => {
    const src = "const a = require('dup');\nimport x from 'dup';";
    expect(extractModuleSpecifiers(src)).toEqual([{ specifier: 'dup', kind: 'import' }]);
  });

  it('does not treat import.meta as a specifier', () => {
    expect(extractModuleSpecifiers('const u = import.meta.url;')).toEqual([]);
  });
});

describe('hasDynamicImport()', () => {
  it('detects a dynamic import() call', () => {
    expect(hasDynamicImport("const m = await import('x');")).toBe(true);
    expect(hasDynamicImport("import('x').then(() => {});")).toBe(true);
  });

  it('does not match static import or import.meta', () => {
    expect(hasDynamicImport("import x from 'x';")).toBe(false);
    expect(hasDynamicImport('const u = import.meta.url;')).toBe(false);
    expect(hasDynamicImport("const x = require('x');")).toBe(false);
  });
});

describe('createEntryTranspile()', () => {
  it('passes a plain-CJS entry through untouched', async () => {
    const transpile = createEntryTranspile();
    const src = "const x = require('a'); module.exports = x;";
    expect(await transpile({ source: src, filename: '[eval]', fromDir: '/workspace' })).toBe(src);
  });

  it('lowers a static import to require (esbuild primary path)', async () => {
    const transpile = createEntryTranspile();
    const out = await transpile({
      source: "import def from 'dep';\nconsole.log(def);",
      filename: '[eval]',
      fromDir: '/workspace',
    });
    expect(out).toContain('require("dep")');
    const { logs } = await runEntry(out, () => ({ default: 'D', __esModule: true }));
    expect(logs[0]?.[0]).toBe('D');
  });

  it('preserves top-level await by falling back to typescript (TLA + dynamic import)', async () => {
    const transpile = createEntryTranspile({
      // Force the esbuild path to fail so the typescript fallback runs even for
      // a case esbuild also rejects (top-level await under format:cjs).
      loadEsbuild: async () => {
        throw new Error('esbuild unavailable');
      },
      loadTypeScript: getTypeScript,
    });
    const out = await transpile({
      source: "const m = await import('dep');\nconsole.log(m.tag);",
      filename: '[eval]',
      fromDir: '/workspace',
    });
    expect(out).toContain('require');
    const { logs } = await runEntry(out, () => ({ tag: 'T', __esModule: true }));
    expect(logs[0]?.[0]).toBe('T');
  });

  it('throws a clear error when both esbuild and typescript fail', async () => {
    const transpile = createEntryTranspile({
      loadEsbuild: async () => {
        throw new Error('no esbuild');
      },
      loadTypeScript: async () => {
        throw new Error('no typescript');
      },
    });
    await expect(
      transpile({ source: "import x from 'a';", filename: '[eval]', fromDir: '/' })
    ).rejects.toThrow(/Failed to transpile entry source/);
  });
});

describe('buildRealmModuleGraph()', () => {
  const passthroughTranspile = ({ source }: { source: string }) => source;

  it('isolates a failing entry: a missing package becomes errors[specifier], others still build', async () => {
    const reader = makeReader({
      '/workspace/node_modules/ok/package.json': JSON.stringify({ name: 'ok', main: 'index.js' }),
      '/workspace/node_modules/ok/index.js': 'module.exports = 1;',
    });
    const graph = await buildRealmModuleGraph({
      entryCode: "const a = require('ok'); const b = require('missing-xyz');",
      fromDir: '/workspace',
      reader,
      transpile: passthroughTranspile,
    });
    expect(graph.entryMap.ok).toBe('/workspace/node_modules/ok/index.js');
    expect(graph.errors['missing-xyz']).toContain(
      "Cannot find module 'missing-xyz' (run: ipk install missing-xyz)"
    );
    // The healthy entry's graph is intact despite the sibling failure.
    expect(graph.files.map((f) => f.path)).toEqual(['/workspace/node_modules/ok/index.js']);
  });

  it('skips scheme / builtin / native specifiers (served by the realm shim)', async () => {
    const reader = makeReader({});
    const graph = await buildRealmModuleGraph({
      entryCode: "require('fs'); require('node:path'); require('sliccy:exec'); require('sharp');",
      fromDir: '/workspace',
      reader,
    });
    expect(graph.files).toEqual([]);
    expect(graph.entryMap).toEqual({});
    expect(graph.errors).toEqual({});
  });

  it('resolves the import access path with import conditions for a dual-exports package', async () => {
    const reader = makeReader({
      '/workspace/node_modules/dual/package.json': JSON.stringify({
        name: 'dual',
        exports: { '.': { import: './esm.js', require: './cjs.js' } },
      }),
      '/workspace/node_modules/dual/esm.js': "export const C = 'import';",
      '/workspace/node_modules/dual/cjs.js': "module.exports = { C: 'require' };",
    });
    const importGraph = await buildRealmModuleGraph({
      entryCode: "import { C } from 'dual';",
      fromDir: '/workspace',
      reader,
      transpile: passthroughTranspile,
    });
    expect(importGraph.entryMap.dual).toBe('/workspace/node_modules/dual/esm.js');

    const requireGraph = await buildRealmModuleGraph({
      entryCode: "const d = require('dual');",
      fromDir: '/workspace',
      reader,
      transpile: passthroughTranspile,
    });
    expect(requireGraph.entryMap.dual).toBe('/workspace/node_modules/dual/cjs.js');
  });

  it('omits entrySource for a plain-CJS entry and includes it for an ESM entry', async () => {
    const reader = makeReader({
      '/workspace/node_modules/ok/package.json': JSON.stringify({ name: 'ok', main: 'index.js' }),
      '/workspace/node_modules/ok/index.js': 'module.exports = 1;',
    });
    const cjsGraph = await buildRealmModuleGraph({
      entryCode: "const a = require('ok');",
      fromDir: '/workspace',
      reader,
      transpile: passthroughTranspile,
      transpileEntry: createEntryTranspile(),
    });
    expect(cjsGraph.entrySource).toBeUndefined();

    const esmGraph = await buildRealmModuleGraph({
      entryCode: "import a from 'ok';",
      fromDir: '/workspace',
      reader,
      transpile: passthroughTranspile,
      transpileEntry: createEntryTranspile(),
    });
    expect(typeof esmGraph.entrySource).toBe('string');
    expect(esmGraph.entrySource).toContain('require("ok")');
  });
});
