/**
 * ESM import resolution wired through the host loader, exercised end-to-end in
 * the real in-process JS realm (`runJsRealm` over the `module`/buildGraph RPC —
 * the same engine the worker/iframe floats run). Fixtures seed an in-memory
 * `node_modules` tree; the host extracts the entry's tagged `require`/`import`
 * specifiers, resolves each per access path, transpiles ESM modules + the entry
 * itself, and the realm evaluates the dependency-ordered CJS graph.
 *
 * Covers VAL-ESM-001 (dynamic import -> namespace), VAL-ESM-002 (static import
 * forms), VAL-ESM-006 (exports conditions per access path), VAL-ESM-011 (mixed
 * cross-kind transitive graph), VAL-ESM-012 (single-eval + top-level await),
 * and VAL-ESM-013 (hard error on a not-installed package, no CDN fallback).
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode, runScript } from './cjs-realm-harness.js';

const NM = '/workspace/node_modules';

/** A seeded ESM package exposing default + two named bindings. */
const esmLib: Record<string, string> = {
  [`${NM}/esm-lib/package.json`]: JSON.stringify({
    name: 'esm-lib',
    type: 'module',
    main: 'index.js',
  }),
  [`${NM}/esm-lib/index.js`]: [
    'export function thing() { return 1; }',
    'export const value = 42;',
    'export default function def() { return 2; }',
  ].join('\n'),
};

describe('VAL-ESM-001: dynamic import() of an installed ESM package resolves to a namespace', () => {
  it('resolves named + default bindings via import().then', async () => {
    const ctx = makeCtx({ files: esmLib });
    const r = await runCode(
      "import('esm-lib').then(m => console.log(typeof m.thing, ('default' in m), typeof m.default))",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function true function');
  });

  it('resolves an ESM package that lazy-loads via its own internal dynamic import', async () => {
    const files: Record<string, string> = {
      [`${NM}/lazy-host/package.json`]: JSON.stringify({
        name: 'lazy-host',
        type: 'module',
        main: 'index.js',
      }),
      // The package exposes an async function that dynamically imports a
      // sibling module on demand (no module-level top-level await — require
      // stays synchronous, the lazy import resolves through the same loader).
      [`${NM}/lazy-host/index.js`]: [
        "export async function load() { const m = await import('./lazy.js'); return m.secret; }",
      ].join('\n'),
      [`${NM}/lazy-host/lazy.js`]: "export const secret = 'lazy-ok';",
    };
    const ctx = makeCtx({ files });
    const r = await runCode(
      "import('lazy-host').then(m => m.load()).then(v => console.log(v))",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('lazy-ok');
  });
});

describe('VAL-ESM-002: static import forms resolve (default, named, namespace, combined)', () => {
  it('resolves the default import binding', async () => {
    const ctx = makeCtx({
      files: {
        ...esmLib,
        '/workspace/app.jsh': "import def from 'esm-lib';\nconsole.log(typeof def);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function');
  });

  it('resolves named imports', async () => {
    const ctx = makeCtx({
      files: {
        ...esmLib,
        '/workspace/app.jsh':
          "import { thing, value } from 'esm-lib';\nconsole.log(typeof thing, value);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function 42');
  });

  it('resolves a namespace import', async () => {
    const ctx = makeCtx({
      files: {
        ...esmLib,
        '/workspace/app.jsh':
          "import * as ns from 'esm-lib';\nconsole.log(typeof ns.thing, ns.value);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function 42');
  });

  it('resolves a combined default + named import in one statement', async () => {
    const ctx = makeCtx({
      files: {
        ...esmLib,
        '/workspace/app.jsh':
          "import def, { thing } from 'esm-lib';\nconsole.log(typeof def, typeof thing);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function function');
  });
});

describe('VAL-ESM-006: exports conditions select per access path (import vs require, default, subpath)', () => {
  const dualFixture: Record<string, string> = {
    [`${NM}/dual-fixture/package.json`]: JSON.stringify({
      name: 'dual-fixture',
      exports: { '.': { import: './esm.js', require: './cjs.js' } },
    }),
    [`${NM}/dual-fixture/esm.js`]: "export const CONDITION = 'import';",
    [`${NM}/dual-fixture/cjs.js`]: "module.exports = { CONDITION: 'require' };",
  };

  it('selects the import condition for a static import', async () => {
    const ctx = makeCtx({
      files: {
        ...dualFixture,
        '/workspace/app.jsh': "import { CONDITION } from 'dual-fixture';\nconsole.log(CONDITION);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('import');
  });

  it('selects the require condition for require()', async () => {
    const ctx = makeCtx({ files: dualFixture });
    const r = await runCode("console.log(require('dual-fixture').CONDITION)", ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('require');
  });

  it('falls back to a default-only exports for both import and require', async () => {
    const files: Record<string, string> = {
      [`${NM}/default-only/package.json`]: JSON.stringify({
        name: 'default-only',
        exports: { '.': { default: './main.js' } },
      }),
      [`${NM}/default-only/main.js`]:
        "export const TAG = 'default-tag';\nmodule.exports = { TAG: 'default-tag' };",
    };
    const importCtx = makeCtx({
      files: {
        ...files,
        '/workspace/app.jsh': "import { TAG } from 'default-only';\nconsole.log(TAG);",
      },
    });
    const importRun = await runScript('/workspace/app.jsh', importCtx);
    expect(importRun.exitCode).toBe(0);
    expect(importRun.stdout.trim()).toBe('default-tag');

    const requireCtx = makeCtx({ files });
    const requireRun = await runCode("console.log(require('default-only').TAG)", requireCtx);
    expect(requireRun.exitCode).toBe(0);
    expect(requireRun.stdout.trim()).toBe('default-tag');
  });

  it('resolves a declared subpath export for both import and require', async () => {
    const files: Record<string, string> = {
      [`${NM}/pkg-sub/package.json`]: JSON.stringify({
        name: 'pkg-sub',
        exports: { './sub': './lib/sub.js' },
      }),
      [`${NM}/pkg-sub/lib/sub.js`]: "module.exports = { SUB: 'sub-ok' };",
    };
    const requireCtx = makeCtx({ files });
    const requireRun = await runCode("console.log(require('pkg-sub/sub').SUB)", requireCtx);
    expect(requireRun.exitCode).toBe(0);
    expect(requireRun.stdout.trim()).toBe('sub-ok');

    const importCtx = makeCtx({
      files: {
        ...files,
        '/workspace/app.jsh': "import { SUB } from 'pkg-sub/sub';\nconsole.log(SUB);",
      },
    });
    const importRun = await runScript('/workspace/app.jsh', importCtx);
    expect(importRun.exitCode).toBe(0);
    expect(importRun.stdout.trim()).toBe('sub-ok');
  });
});

describe('VAL-ESM-011: mixed cross-kind transitive graph resolves in dependency order', () => {
  it('ESM root importing a CJS dependency composes correctly', async () => {
    const files: Record<string, string> = {
      [`${NM}/esm-root/package.json`]: JSON.stringify({
        name: 'esm-root',
        type: 'module',
        main: 'index.js',
      }),
      [`${NM}/esm-root/index.js`]: [
        "import dep from 'cjs-dep';",
        'export default `esm(${dep})`;',
      ].join('\n'),
      [`${NM}/cjs-dep/package.json`]: JSON.stringify({ name: 'cjs-dep', main: 'index.js' }),
      [`${NM}/cjs-dep/index.js`]: "module.exports = 'cjs';",
    };
    const ctx = makeCtx({
      files: { ...files, '/workspace/app.jsh': "import v from 'esm-root';\nconsole.log(v);" },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('esm(cjs)');
  });

  it('CJS root requiring an ESM dependency yields the namespace', async () => {
    const files: Record<string, string> = {
      [`${NM}/cjs-root/package.json`]: JSON.stringify({ name: 'cjs-root', main: 'index.js' }),
      [`${NM}/cjs-root/index.js`]: [
        "const dep = require('esm-dep');",
        'module.exports = { value: `cjs(${dep.tag})` };',
      ].join('\n'),
      [`${NM}/esm-dep/package.json`]: JSON.stringify({
        name: 'esm-dep',
        type: 'module',
        main: 'index.js',
      }),
      [`${NM}/esm-dep/index.js`]: "export const tag = 'esm';",
    };
    const ctx = makeCtx({ files });
    const r = await runCode("console.log(require('cjs-root').value)", ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('cjs(esm)');
  });

  it('a deep a(ESM)->b(CJS)->c(ESM)->d(CJS) chain surfaces the deepest marker', async () => {
    const files: Record<string, string> = {
      [`${NM}/a/package.json`]: JSON.stringify({ name: 'a', type: 'module', main: 'index.js' }),
      [`${NM}/a/index.js`]: "import b from 'b';\nexport default `a:${b}`;",
      [`${NM}/b/package.json`]: JSON.stringify({ name: 'b', main: 'index.js' }),
      [`${NM}/b/index.js`]: "const c = require('c');\nmodule.exports = `b:${c.tag}`;",
      [`${NM}/c/package.json`]: JSON.stringify({ name: 'c', type: 'module', main: 'index.js' }),
      [`${NM}/c/index.js`]: "import d from 'd';\nexport const tag = `c:${d}`;",
      [`${NM}/d/package.json`]: JSON.stringify({ name: 'd', main: 'index.js' }),
      [`${NM}/d/index.js`]: "module.exports = 'd-marker';",
    };
    const ctx = makeCtx({
      files: { ...files, '/workspace/app.jsh': "import v from 'a';\nconsole.log(v);" },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('a:b:c:d-marker');
  });

  it('resolves an ESM re-export barrel (export { x } from / export * from)', async () => {
    const files: Record<string, string> = {
      [`${NM}/barrel-pkg/package.json`]: JSON.stringify({
        name: 'barrel-pkg',
        type: 'module',
        main: 'index.js',
      }),
      [`${NM}/barrel-pkg/index.js`]: [
        "export { thing } from './impl.js';",
        "export * from './more.js';",
      ].join('\n'),
      [`${NM}/barrel-pkg/impl.js`]: "export const thing = 'thing-ok';",
      [`${NM}/barrel-pkg/more.js`]: "export const extra = 'extra-ok';",
    };
    const ctx = makeCtx({
      files: {
        ...files,
        '/workspace/app.jsh':
          "import { thing, extra } from 'barrel-pkg';\nconsole.log(thing, extra);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('thing-ok extra-ok');
  });
});

describe('VAL-ESM-012: an ESM module is evaluated once and shared; top-level await works', () => {
  const counterPkg: Record<string, string> = {
    [`${NM}/counter-pkg/package.json`]: JSON.stringify({
      name: 'counter-pkg',
      type: 'module',
      main: 'index.js',
    }),
    [`${NM}/counter-pkg/index.js`]: [
      "console.log('LOADED');",
      'export const id = Math.random();',
      'export function ping() { return id; }',
    ].join('\n'),
  };

  it('runs the load side-effect once across a static + dynamic import of the same module', async () => {
    const ctx = makeCtx({
      files: {
        ...counterPkg,
        '/workspace/app.jsh': [
          "import { ping } from 'counter-pkg';",
          "const m = await import('counter-pkg');",
          'console.log(ping() === m.ping());',
        ].join('\n'),
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split('\n').filter(Boolean);
    // 'LOADED' appears exactly once (single evaluation), and both references
    // share the same module instance (identical `id`).
    expect(lines.filter((l) => l === 'LOADED')).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe('true');
  });

  it('supports top-level await in the entry (await import)', async () => {
    const ctx = makeCtx({
      files: {
        ...esmLib,
        '/workspace/app.jsh': [
          "const m = await import('esm-lib');",
          'console.log(typeof m.thing, m.value);',
        ].join('\n'),
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function 42');
  });
});

describe('VAL-ESM-013: hard error on import of a NOT-installed package, no CDN fallback', () => {
  it('static import of a missing package throws the install-hint error with non-zero exit', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/app.jsh': "import x from 'definitely-not-installed-xyz';\nconsole.log(x);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(
      "Cannot find module 'definitely-not-installed-xyz' (run: ipk install definitely-not-installed-xyz)"
    );
  });

  it('dynamic import of a missing package rejects with the same install-hint error', async () => {
    const ctx = makeCtx({
      files: {},
    });
    const r = await runCode(
      "import('definitely-not-installed-xyz').then(() => console.log('NO'), e => console.log('ERR', e.message))",
      ctx
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(
      "ERR Cannot find module 'definitely-not-installed-xyz' (run: ipk install definitely-not-installed-xyz)"
    );
  });

  it('resolves an installed ESM package without ever contacting the network (no CDN fetch)', async () => {
    const fetchCalls: string[] = [];
    const ctx = makeCtx({
      files: esmLib,
      fetch: (async (input: unknown) => {
        fetchCalls.push(String(input));
        throw new Error('network is unavailable');
      }) as never,
    });
    const r = await runCode("import('esm-lib').then(m => console.log(typeof m.thing))", ctx);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function');
    expect(fetchCalls).toEqual([]);
  });
});
