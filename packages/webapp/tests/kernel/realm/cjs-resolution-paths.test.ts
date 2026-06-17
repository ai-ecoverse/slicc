/**
 * Full Node resolution surface through the realm `require()`
 * (m4-cjs-require-rewire / cjs-resolution-paths). These integration tests drive
 * the in-process realm factory (the same `runJsRealm` engine the production
 * worker/iframe floats use) over a synthesized `node_modules` tree, proving the
 * resolution behaviors END TO END via `require()` — not just at the pure
 * `resolve()` unit level (see `module-resolve.test.ts`).
 *
 * Fulfills VAL-REQUIRE-005 (nearest-node_modules walk + nearest-wins),
 * 006 (relative/absolute path bases), 007 (extension/JSON/directory-index with
 * file-over-directory precedence), 008 (deep subpath import), 009 (main entry /
 * index.js fallback), 010 (exports require/default/subpath conditions),
 * 017 (scoped packages), 018 (`node <script.js>` resolves relative to the
 * script's own directory), and 019 (per-module `__dirname`/`__filename`).
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode, runScript } from './cjs-realm-harness.js';

const PKG_IS_NUMBER = {
  '/workspace/node_modules/is-number/package.json': JSON.stringify({
    name: 'is-number',
    version: '7.0.0',
    main: 'index.js',
  }),
  '/workspace/node_modules/is-number/index.js':
    "module.exports = function isNumber(n) { return typeof n === 'number' && n - n === 0; };",
};

describe('VAL-REQUIRE-005: nearest-node_modules walk resolves ancestors and prefers the nearest copy', () => {
  it('a script in a nested subdirectory resolves a package from an ancestor node_modules', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        ...PKG_IS_NUMBER,
        '/workspace/a/b/use.js': "console.log(require('is-number')(5));",
      },
    });
    const out = await runScript('/workspace/a/b/use.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('true');
  });

  it('the nearest copy wins when the same package exists nested and at an ancestor', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/dep/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/node_modules/dep/index.js': "module.exports = 'far';",
        '/workspace/a/node_modules/dep/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/a/node_modules/dep/index.js': "module.exports = 'near';",
        '/workspace/a/b/use.js': "console.log(require('dep'));",
      },
    });
    const out = await runScript('/workspace/a/b/use.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('near');
  });
});

describe('VAL-REQUIRE-006: relative and absolute path requires resolve against the right base', () => {
  it("resolves './local.js', '../sib.js', and a VFS-absolute path", async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/proj/main.js': `
          console.log(require('./local.js'));
          console.log(require('../sib.js'));
          console.log(require('/workspace/abs/x.js'));
        `,
        '/workspace/proj/local.js': "module.exports = 'local';",
        '/workspace/sib.js': "module.exports = 'sibling';",
        '/workspace/abs/x.js': "module.exports = 'absolute';",
      },
    });
    const out = await runScript('/workspace/proj/main.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.split('\n').filter(Boolean)).toEqual(['local', 'sibling', 'absolute']);
  });
});

describe('VAL-REQUIRE-007: extension, JSON, and directory-index resolution (file-over-directory)', () => {
  it('resolves extensionless .js/.cjs, JSON, directory index, and prefers file over directory', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/proj/main.js': `
          console.log(require('./local'));
          console.log(require('./onlycjs'));
          console.log(require('./data.json').answer, typeof require('./data.json'));
          console.log(require('./data').answer);
          console.log(require('./dir'));
          console.log(require('./x'));
        `,
        '/workspace/proj/local.js': "module.exports = 'js';",
        '/workspace/proj/onlycjs.cjs': "module.exports = 'cjs';",
        '/workspace/proj/data.json': '{"answer":42}',
        '/workspace/proj/dir/index.js': "module.exports = 'dir-index';",
        '/workspace/proj/x.js': "module.exports = 'file-wins';",
        '/workspace/proj/x/index.js': "module.exports = 'dir-loses';",
      },
    });
    const out = await runScript('/workspace/proj/main.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.split('\n').filter(Boolean)).toEqual([
      'js',
      'cjs',
      '42 object',
      '42',
      'dir-index',
      'file-wins',
    ]);
  });
});

describe('VAL-REQUIRE-008: deep subpath import into a package', () => {
  it('requires a specific file inside a package by subpath, independent of main', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/multi/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/node_modules/multi/index.js': "module.exports = 'main-entry';",
        '/workspace/node_modules/multi/lib/greet.js':
          "module.exports = function greet(name) { return 'hello ' + name; };",
      },
    });
    const out = await runCode("console.log(require('multi/lib/greet.js')('world'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello world');
  });
});

describe('VAL-REQUIRE-009: main selects the entry; missing main/exports falls back to index.js', () => {
  it("'main' selects the declared entry over a decoy index.js", async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/withmain/package.json': JSON.stringify({ main: 'lib/entry.js' }),
        '/workspace/node_modules/withmain/lib/entry.js': "module.exports = 'real-entry';",
        '/workspace/node_modules/withmain/index.js': "module.exports = 'decoy';",
      },
    });
    const out = await runCode("console.log(require('withmain'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('real-entry');
  });

  it('a package with no main/exports falls back to its root index.js', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/noentry/package.json': JSON.stringify({ name: 'noentry' }),
        '/workspace/node_modules/noentry/index.js': "module.exports = 'fallback-index';",
      },
    });
    const out = await runCode("console.log(require('noentry'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('fallback-index');
  });
});

describe('VAL-REQUIRE-010: exports map honors require, default, and subpath conditions', () => {
  it("the 'require' condition wins over import/default", async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/dual/package.json': JSON.stringify({
          exports: { '.': { require: './cjs.js', import: './esm.js', default: './fallback.js' } },
        }),
        '/workspace/node_modules/dual/cjs.js': "module.exports = 'cjs-condition';",
        '/workspace/node_modules/dual/esm.js': "module.exports = 'esm-condition';",
        '/workspace/node_modules/dual/fallback.js': "module.exports = 'default-condition';",
      },
    });
    const out = await runCode("console.log(require('dual'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('cjs-condition');
  });

  it("falls back to the 'default' condition when require/import are absent", async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/defonly/package.json': JSON.stringify({
          exports: { '.': { default: './d.js' } },
        }),
        '/workspace/node_modules/defonly/d.js': "module.exports = 'default-only';",
      },
    });
    const out = await runCode("console.log(require('defonly'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('default-only');
  });

  it('an exports subpath map resolves the requested subpath', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/feat/package.json': JSON.stringify({
          exports: { './feature': { require: './feature-cjs.js' } },
        }),
        '/workspace/node_modules/feat/feature-cjs.js': "module.exports = 'subpath-export';",
      },
    });
    const out = await runCode("console.log(require('feat/feature'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('subpath-export');
  });
});

describe('VAL-REQUIRE-017: scoped packages resolve from their nested @scope directory', () => {
  it('requires a scoped package by its @scope/name specifier honoring its main', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/node_modules/@acme/util/package.json': JSON.stringify({ main: 'main.js' }),
        '/workspace/node_modules/@acme/util/main.js':
          "module.exports = { tag: 'acme-util' }; module.exports.helper = require('./lib/h.js');",
        '/workspace/node_modules/@acme/util/lib/h.js': "module.exports = 'scoped-helper';",
      },
    });
    const out = await runCode(
      "const u = require('@acme/util'); console.log(u.tag, u.helper);",
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('acme-util scoped-helper');
  });
});

describe("VAL-REQUIRE-018: `node <script.js>` resolves requires relative to the script's own directory", () => {
  it("resolves a package installed under the script's directory, not the shell cwd", async () => {
    // is-number lives ONLY under the script's directory tree; the realm cwd
    // (/workspace) cannot resolve it. Success proves script-directory bases.
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/proj/node_modules/is-number/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/proj/node_modules/is-number/index.js':
          "module.exports = function isNumber(n) { return typeof n === 'number'; };",
        '/workspace/proj/run.js': "console.log(require('is-number')(5));",
      },
    });
    const out = await runScript('/workspace/proj/run.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('true');
  });

  it('the same require from the shell cwd (node -e) cannot see the script-local package', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/proj/node_modules/is-number/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/proj/node_modules/is-number/index.js': 'module.exports = function () {};',
      },
    });
    const out = await runCode("require('is-number');", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Cannot find module 'is-number' (run: ipk install is-number)");
  });
});

describe("VAL-REQUIRE-019: __dirname/__filename resolve to each module's OWN directory (asset-loading)", () => {
  it('a required module sees its own package dir for __dirname/__filename and reads a bundled asset', async () => {
    const ctx = makeCtx({
      cwd: '/workspace/app',
      files: {
        '/workspace/app/main.js': `
          const pkg = require('asset-pkg');
          console.log(pkg.dir);
          console.log(pkg.file);
          console.log(await pkg.readAsset());
        `,
        '/workspace/node_modules/asset-pkg/package.json': JSON.stringify({ main: 'index.js' }),
        '/workspace/node_modules/asset-pkg/index.js': `
          const fs = require('fs');
          const path = require('path');
          module.exports = {
            dir: __dirname,
            file: __filename,
            readAsset: () => fs.readFile(path.join(__dirname, 'data.txt')),
          };
        `,
        '/workspace/node_modules/asset-pkg/data.txt': 'bundled-asset-bytes',
      },
    });
    const out = await runScript('/workspace/app/main.js', ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    const lines = out.stdout.split('\n').filter(Boolean);
    // __dirname/__filename are the module's OWN dir, not cwd (/workspace/app)
    // and not the entry script's dir (/workspace/app).
    expect(lines[0]).toBe('/workspace/node_modules/asset-pkg');
    expect(lines[1]).toBe('/workspace/node_modules/asset-pkg/index.js');
    expect(lines[2]).toBe('bundled-asset-bytes');
  });

  it('the entry script and a required module report distinct __dirname values', async () => {
    const ctx = makeCtx({
      cwd: '/workspace',
      files: {
        '/workspace/app/entry.js': `
          const dep = require('./lib/dep.js');
          console.log('entry:' + __dirname);
          console.log('dep:' + dep.dir);
        `,
        '/workspace/app/lib/dep.js': 'module.exports = { dir: __dirname };',
      },
    });
    const out = await runScript('/workspace/app/entry.js', ctx);
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('entry:/workspace/app');
    expect(lines[1]).toBe('dep:/workspace/app/lib');
  });
});
