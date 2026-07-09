/**
 * Host-side ESM module-kind detection + ESM->CJS transpile tests
 * (architecture 4.4; VAL-ESM-003/004/005/017).
 *
 * Covers `hasEsmSyntax` syntax detection, `vfsPathToModuleUrl`, and
 * `createEsmTranspile` (esbuild primary + typescript fallback), including:
 * transpiling real ESM source to evaluable CJS, leaving plain CJS untouched
 * (no needless transpile), and preserving `import.meta.url` as a defined,
 * module-correct URL through the transpile (so `new URL(rel, import.meta.url)`
 * resolves against the module's own VFS path).
 */
import { describe, expect, it } from 'vitest';
import {
  createEntryTranspile,
  createEsmTranspile,
  hasEsmSyntax,
  vfsPathToModuleUrl,
} from '../../../src/shell/ipk/esm-transpile.js';
import { buildModuleGraph } from '../../../src/shell/ipk/module-loader.js';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';

function makeReader(files: Record<string, string>): ModuleReader {
  const dirs = new Set<string>(['/']);
  for (const key of Object.keys(files)) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (dir) dirs.add(dir);
    }
  }
  const fileSet = new Set(Object.keys(files));
  return {
    exists: async (p) => fileSet.has(p) || dirs.has(p),
    isDirectory: async (p) => dirs.has(p),
    readFile: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
}

/** Evaluate transpiled CJS source and return its `module.exports`. */
function evalCjs(
  code: string,
  requireImpl: (id: string) => unknown = () => ({})
): Record<string, unknown> {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  fn(module, module.exports, requireImpl);
  return module.exports;
}

describe('hasEsmSyntax()', () => {
  it('detects static import forms', () => {
    expect(hasEsmSyntax("import foo from 'foo';")).toBe(true);
    expect(hasEsmSyntax("import { a, b } from 'foo';")).toBe(true);
    expect(hasEsmSyntax("import * as ns from 'foo';")).toBe(true);
    expect(hasEsmSyntax("import 'side-effect';")).toBe(true);
    expect(hasEsmSyntax("import def, { named } from 'foo';")).toBe(true);
    expect(hasEsmSyntax('const x = 1;\nimport y from "y";')).toBe(true);
  });

  it('detects export forms', () => {
    expect(hasEsmSyntax('export default 1;')).toBe(true);
    expect(hasEsmSyntax('export const x = 1;')).toBe(true);
    expect(hasEsmSyntax('export function f(){}')).toBe(true);
    expect(hasEsmSyntax('export { a, b };')).toBe(true);
    expect(hasEsmSyntax("export * from './x.js';")).toBe(true);
    expect(hasEsmSyntax('const a=1;}\nexport { a };')).toBe(true);
  });

  it('detects import.meta', () => {
    expect(hasEsmSyntax('const u = import.meta.url;')).toBe(true);
    expect(hasEsmSyntax('console.log(import . meta . url);')).toBe(true);
  });

  it('does NOT flag plain CJS', () => {
    expect(hasEsmSyntax('module.exports = 1;')).toBe(false);
    expect(hasEsmSyntax('exports.foo = 1;')).toBe(false);
    expect(hasEsmSyntax("const x = require('x');")).toBe(false);
    expect(hasEsmSyntax('module.exports.bar = 2;')).toBe(false);
  });

  it('does NOT treat dynamic import() as a static ESM marker', () => {
    expect(hasEsmSyntax("const m = await import('x');")).toBe(false);
    expect(hasEsmSyntax("import('x').then(() => {});")).toBe(false);
  });

  it('does NOT match identifiers that merely start with import/export', () => {
    expect(hasEsmSyntax('const important = 1; const exporter = 2;')).toBe(false);
  });

  it('ignores import/export keywords inside string and template literals', () => {
    expect(hasEsmSyntax('const help = "import x from \'y\'";')).toBe(false);
    expect(hasEsmSyntax("const help = 'export const x = 1;';")).toBe(false);
    expect(hasEsmSyntax('const help = `usage:\nexport default foo`;')).toBe(false);
    expect(hasEsmSyntax('const q = "he said \\"import a from b\\"";')).toBe(false);
  });

  it('ignores import/export keywords inside comments', () => {
    expect(hasEsmSyntax('// import x from "y"\nmodule.exports = 1;')).toBe(false);
    expect(hasEsmSyntax('/* export default 1; */ module.exports = 1;')).toBe(false);
    expect(hasEsmSyntax('const u = 1;\n/*\nexport const y = 2;\n*/')).toBe(false);
  });

  it('still detects real syntax alongside masked keywords', () => {
    expect(hasEsmSyntax('const s = "not a real import";\nexport const y = 2;')).toBe(true);
    expect(hasEsmSyntax('// export default 1;\nimport y from "y";')).toBe(true);
  });

  it('detects import.meta inside a template interpolation (real code)', () => {
    expect(hasEsmSyntax('const u = `${import.meta.url}`;')).toBe(true);
  });
});

describe('vfsPathToModuleUrl()', () => {
  it('builds a file:// URL reflecting the absolute VFS path', () => {
    expect(vfsPathToModuleUrl('/app/node_modules/pkg/index.js')).toBe(
      'file:///app/node_modules/pkg/index.js'
    );
  });

  it('preserves scope segments and encodes spaces', () => {
    expect(vfsPathToModuleUrl('/app/node_modules/@scope/p/index.js')).toBe(
      'file:///app/node_modules/@scope/p/index.js'
    );
    expect(vfsPathToModuleUrl('/a b/c.js')).toBe('file:///a%20b/c.js');
  });

  it('resolves a relative URL against the module path', () => {
    const url = vfsPathToModuleUrl('/app/node_modules/pkg/index.js');
    expect(new URL('./data.txt', url).href).toBe('file:///app/node_modules/pkg/data.txt');
  });
});

describe('createEsmTranspile() — esbuild primary path', () => {
  const PATH = '/app/node_modules/pkg/index.js';
  const ESM_SRC = [
    "export const id = 'pkg';",
    'export default function whereAmI() { return import.meta.url; }',
    "export function asset() { return new URL('./data.txt', import.meta.url).href; }",
  ].join('\n');

  it('transpiles ESM to evaluable CJS and preserves import.meta.url', async () => {
    const transpile = createEsmTranspile();
    const cjs = await transpile({ source: ESM_SRC, path: PATH, kind: 'esm' });
    expect(cjs).not.toContain('import.meta');
    const exp = evalCjs(cjs);
    expect(exp.__esModule).toBe(true);
    expect(typeof exp.default).toBe('function');
    expect((exp.default as () => string)()).toBe('file:///app/node_modules/pkg/index.js');
    expect((exp.asset as () => string)()).toBe('file:///app/node_modules/pkg/data.txt');
    expect(exp.id).toBe('pkg');
  });

  it('passes plain CJS through untouched even when kind is esm (no needless transpile)', async () => {
    const transpile = createEsmTranspile();
    const cjs = 'module.exports = 42;';
    const out = await transpile({ source: cjs, path: PATH, kind: 'esm' });
    expect(out).toBe(cjs);
  });

  it('returns source unchanged for a cjs kind', async () => {
    const transpile = createEsmTranspile();
    const src = "const x = require('y'); module.exports = x;";
    expect(await transpile({ source: src, path: PATH, kind: 'cjs' })).toBe(src);
  });
});

describe('createEsmTranspile() — typescript fallback path', () => {
  const PATH = '/app/node_modules/pkg/index.mjs';
  const ESM_SRC = [
    'export default function whereAmI() { return import.meta.url; }',
    "export function asset() { return new URL('./d.txt', import.meta.url).href; }",
  ].join('\n');

  it('falls back to typescript when esbuild fails, still preserving import.meta.url', async () => {
    const { getTypeScript } = await import('../../../src/shell/supplemental-commands/shared.js');
    const transpile = createEsmTranspile({
      loadEsbuild: async () => {
        throw new Error('esbuild unavailable');
      },
      loadTypeScript: getTypeScript,
    });
    const cjs = await transpile({ source: ESM_SRC, path: PATH, kind: 'esm' });
    expect(cjs).not.toContain('import.meta');
    const exp = evalCjs(cjs);
    expect((exp.default as () => string)()).toBe('file:///app/node_modules/pkg/index.mjs');
    expect((exp.asset as () => string)()).toBe('file:///app/node_modules/pkg/d.txt');
  });
});

describe('buildModuleGraph() with createEsmTranspile (end-to-end)', () => {
  it('builds an evaluable CJS graph for an installed ESM package preserving import.meta.url', async () => {
    const reader = makeReader({
      '/app/node_modules/esm-pkg/package.json': JSON.stringify({
        name: 'esm-pkg',
        type: 'module',
        main: 'index.js',
      }),
      '/app/node_modules/esm-pkg/index.js': [
        "export const here = new URL('./here', import.meta.url).href;",
        'export default 7;',
      ].join('\n'),
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['esm-pkg'],
      fromDir: '/app',
      reader,
      conditions: ['node', 'import', 'default'],
      transpile: createEsmTranspile(),
    });
    const mod = graph.files.find((f) => f.path === '/app/node_modules/esm-pkg/index.js');
    expect(mod?.kind).toBe('esm');
    expect(mod?.cjsSource).not.toContain('import.meta');
    const exp = evalCjs(mod!.cjsSource);
    expect(exp.default).toBe(7);
    expect(exp.here).toBe('file:///app/node_modules/esm-pkg/here');
  });

  it('leaves a syntax-detected plain-CJS package untranspiled (passed through)', async () => {
    const reader = makeReader({
      // No "type" field; index.js uses only module.exports -> detected CJS.
      '/app/node_modules/plain-cjs/package.json': JSON.stringify({
        name: 'plain-cjs',
        main: 'index.js',
      }),
      '/app/node_modules/plain-cjs/index.js': 'module.exports = (n) => n + 1;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['plain-cjs'],
      fromDir: '/app',
      reader,
      transpile: createEsmTranspile(),
    });
    const mod = graph.files.find((f) => f.path === '/app/node_modules/plain-cjs/index.js');
    expect(mod?.kind).toBe('cjs');
    expect(mod?.cjsSource).toBe('module.exports = (n) => n + 1;');
    const exp = evalCjs(mod!.cjsSource);
    expect((exp as unknown as (n: number) => number)(1)).toBe(2);
  });

  it('detects ESM by syntax for a no-type .js entry and transpiles it', async () => {
    const reader = makeReader({
      '/app/node_modules/syntax-esm/package.json': JSON.stringify({
        name: 'syntax-esm',
        main: 'index.js',
      }),
      '/app/node_modules/syntax-esm/index.js': 'export default 99;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['syntax-esm'],
      fromDir: '/app',
      reader,
      conditions: ['node', 'import', 'default'],
      transpile: createEsmTranspile(),
    });
    const mod = graph.files.find((f) => f.path === '/app/node_modules/syntax-esm/index.js');
    expect(mod?.kind).toBe('esm');
    const exp = evalCjs(mod!.cjsSource);
    expect(exp.default).toBe(99);
  });
});

describe('createEntryTranspile() — .mjs/.mts interop honors __esModule (no Node-mode mis-binding)', () => {
  // A `.mjs` entry's extension makes esbuild emit `__toESM(require(x), 1)`
  // (`isNodeMode`), which binds a default import to the whole `module.exports`
  // and IGNORES a Babel-style `__esModule` shim — exactly the shim the host
  // produces for transpiled ESM dependencies. The sourcefile is normalized to
  // `.js` so the default import binds the real `default` export instead.
  const esmShim = { __esModule: true, default: () => 'default-fn' } as const;

  it('default import in a .mjs entry binds the __esModule default (a function), not the namespace', async () => {
    const entry = await createEntryTranspile()({
      source: "import d from 'esm-shim';\nglobalThis.__ESM_MJS_OUT = typeof d;",
      filename: '/work/esm.mjs',
      fromDir: '/work',
    });
    expect(entry).not.toMatch(/__toESM\(\s*require\([^)]*\)\s*,\s*1\s*\)/);
    try {
      evalCjs(entry, () => esmShim);
      expect((globalThis as Record<string, unknown>).__ESM_MJS_OUT).toBe('function');
    } finally {
      delete (globalThis as Record<string, unknown>).__ESM_MJS_OUT;
    }
  });

  it('default import in a .mts entry likewise binds the __esModule default', async () => {
    const entry = await createEntryTranspile()({
      source: "import d from 'esm-shim';\nglobalThis.__ESM_MTS_OUT = d();",
      filename: '/work/esm.mts',
      fromDir: '/work',
    });
    try {
      evalCjs(entry, () => esmShim);
      expect((globalThis as Record<string, unknown>).__ESM_MTS_OUT).toBe('default-fn');
    } finally {
      delete (globalThis as Record<string, unknown>).__ESM_MTS_OUT;
    }
  });
});
