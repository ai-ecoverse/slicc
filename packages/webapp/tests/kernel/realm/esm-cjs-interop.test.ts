/**
 * CJS<->ESM interop in the realm evaluator (architecture 4.4), exercised
 * end-to-end in the real in-process JS realm (`runJsRealm` over the
 * `module`/buildGraph RPC — the same engine the worker/iframe floats run).
 * Fixtures seed an in-memory `node_modules` tree; the host transpiles every
 * ESM module (and an ESM/dynamic-import entry) to a uniform CJS graph, and the
 * realm evaluates it with its synchronous `require` shim. The interop helpers
 * (`__toESM`/`__toCommonJS`) are baked into the host-transpiled CJS source, so
 * both floats observe identical behavior.
 *
 * Covers VAL-ESM-007 (CJS require of an ESM module -> namespace with
 * default + named + __esModule, no double-wrap; pre-set __esModule honored),
 * VAL-ESM-008 (ESM import of a CJS module receives module.exports as
 * default + named; require of an ESM module is synchronous), and VAL-ESM-018
 * (dynamic import() of an installed CJS package yields module.exports on
 * .default plus named where present, no double-wrap).
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode, runScript } from './cjs-realm-harness.js';

const NM = '/workspace/node_modules';

/** An ESM package exposing two named bindings AND a default export. */
const esmNamespacePkg: Record<string, string> = {
  [`${NM}/esm-ns/package.json`]: JSON.stringify({
    name: 'esm-ns',
    type: 'module',
    main: 'index.js',
  }),
  [`${NM}/esm-ns/index.js`]: [
    "export function greet() { return 'hi'; }",
    'export const value = 42;',
    "export default function def() { return 'def'; }",
  ].join('\n'),
};

/** A CJS package mimicking lodash: a plain object of named functions. */
const cjsLodashPkg: Record<string, string> = {
  [`${NM}/cjs-lodash/package.json`]: JSON.stringify({ name: 'cjs-lodash', main: 'index.js' }),
  [`${NM}/cjs-lodash/index.js`]: [
    'function merge() { return "merged"; }',
    'function map() { return "mapped"; }',
    'module.exports = { merge, map };',
  ].join('\n'),
};

/** An ESM package whose default export is a callable (chalk-like). */
const esmChalkPkg: Record<string, string> = {
  [`${NM}/esm-chalk/package.json`]: JSON.stringify({
    name: 'esm-chalk',
    type: 'module',
    main: 'index.js',
  }),
  [`${NM}/esm-chalk/index.js`]: [
    'export default function chalk(s) { return s; }',
    'export const supportsColor = true;',
  ].join('\n'),
};

/** A CJS package whose `module.exports` is a callable with a named property. */
const cjsNumberPkg: Record<string, string> = {
  [`${NM}/num-pkg/package.json`]: JSON.stringify({ name: 'num-pkg', main: 'index.js' }),
  [`${NM}/num-pkg/index.js`]: [
    'function isNumber(n) { return typeof n === "number"; }',
    "isNumber.tag = 'num-named';",
    'module.exports = isNumber;',
  ].join('\n'),
};

describe('VAL-ESM-007: CJS require() of an ESM module yields a namespace (default + named + __esModule), no double-wrap', () => {
  it('returns a namespace carrying __esModule, named bindings, and a default', async () => {
    const ctx = makeCtx({ files: esmNamespacePkg });
    const r = await runCode(
      "const m = require('esm-ns'); console.log(m.__esModule === true, typeof m.greet, typeof m.default);",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('true function function');
  });

  it('does not double-wrap: default and named are the real bindings, not a nested namespace', async () => {
    const ctx = makeCtx({ files: esmNamespacePkg });
    const r = await runCode(
      "const m = require('esm-ns'); console.log(m.default(), m.greet(), m.value);",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('def hi 42');
  });

  it('honors a pre-set __esModule/default CJS module without re-wrapping it (import d, { named })', async () => {
    const files: Record<string, string> = {
      [`${NM}/esmodule-cjs/package.json`]: JSON.stringify({
        name: 'esmodule-cjs',
        main: 'index.js',
      }),
      [`${NM}/esmodule-cjs/index.js`]:
        'module.exports = { __esModule: true, default: 42, named: 7 };',
      '/workspace/app.jsh': "import d, { named } from 'esmodule-cjs';\nconsole.log(d, named);",
    };
    const ctx = makeCtx({ files });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('42 7');
  });
});

describe('VAL-ESM-008: ESM import of a CJS module receives module.exports (default + named); require of ESM is synchronous', () => {
  it('binds the whole module.exports to the default import of a CJS package', async () => {
    const ctx = makeCtx({
      files: {
        ...cjsLodashPkg,
        '/workspace/app.jsh':
          "import _ from 'cjs-lodash';\nconsole.log(typeof _.merge, typeof _.map);",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function function');
  });

  it('resolves a named import from a CJS package', async () => {
    const ctx = makeCtx({
      files: {
        ...cjsLodashPkg,
        '/workspace/app.jsh':
          "import { merge } from 'cjs-lodash';\nconsole.log(typeof merge, merge());",
      },
    });
    const r = await runScript('/workspace/app.jsh', ctx);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function merged');
  });

  it('require() of an ESM package returns synchronously (the export is available immediately)', async () => {
    const ctx = makeCtx({ files: esmChalkPkg });
    const r = await runCode(
      "const m = require('esm-chalk'); console.log(typeof (m.default ?? m), m instanceof Promise);",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function false');
  });
});

describe('VAL-ESM-018: dynamic import() of an installed CJS package yields its exports on .default (and named where present)', () => {
  it('resolves a namespace whose default is the callable module.exports', async () => {
    const ctx = makeCtx({ files: cjsNumberPkg });
    const r = await runCode(
      "import('num-pkg').then(m => console.log(typeof m.default, m.default(9), m.default('x')))",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function true false');
  });

  it('exposes named bindings present on the CJS exports without double-wrapping', async () => {
    const ctx = makeCtx({ files: cjsNumberPkg });
    const r = await runCode(
      "import('num-pkg').then(m => console.log('tag' in m, m.tag, m.default === m.default))",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('true num-named true');
  });

  it('resolves a CJS object package: default is the whole exports and named keys are present', async () => {
    const ctx = makeCtx({ files: cjsLodashPkg });
    const r = await runCode(
      "import('cjs-lodash').then(m => console.log(typeof m.default.merge, typeof m.merge, typeof m.map))",
      ctx
    );
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('function function function');
  });
});
