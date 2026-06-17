/**
 * CJS require error/edge hardening (m4-cjs-require-rewire / cjs-require-errors-edge).
 *
 * Drives the in-process realm factory (the same `runJsRealm` engine the
 * production worker/iframe floats use, so behavior parity is by construction)
 * over a directory-aware in-memory VFS, exercising the `module`/buildGraph RPC
 * end to end for the THREE error/edge surfaces the loader must harden
 * (architecture 4.4, 7):
 *   - a Node-native package still hard-fails (NOT routed to a CDN / node_modules
 *     path) — VAL-REQUIRE-012;
 *   - broken/malformed package metadata errors clearly and the realm terminates
 *     (no hang) — VAL-REQUIRE-014;
 *   - circular requires terminate with CommonJS partial-exports semantics
 *     (no deadlock) — VAL-REQUIRE-015.
 *
 * Each "no hang" claim is bounded by a wall-clock assertion so a regression
 * that parks the realm fails loudly instead of timing the whole suite out.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

/** A fetch spy that explodes if the realm ever attempts a (CDN) fetch. */
function noFetchSpy(): CommandContext['fetch'] {
  return vi.fn(async () => {
    throw new Error('NO CDN: the realm must never fetch a module');
  }) as unknown as CommandContext['fetch'];
}

describe('VAL-REQUIRE-012: a Node-native package hard-fails (no CDN / node_modules path)', () => {
  it('require("sharp") rejects with the native-module guidance error, non-zero exit, no fetch', async () => {
    const fetchSpy = noFetchSpy();
    const ctx = makeCtx({ fetch: fetchSpy });
    const start = Date.now();
    const out = await runCode("require('sharp');", ctx);
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(1);
    // Native-module guidance — distinct from the "Cannot find module" install hint.
    expect(out.stderr).toContain('native module');
    expect(out.stderr).toContain('C++ bindings');
    expect(out.stderr).toContain("require('sharp')");
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stderr).not.toContain('ipk install');
    // No CDN download and the failure is immediate (no prefetch/timeout stall).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.stderr).not.toContain('esm.sh');
    expect(out.stderr).not.toContain('jsdelivr');
    expect(elapsed).toBeLessThan(2000);
  });

  it('the native hard-fail wins even when the package is present on disk in node_modules', async () => {
    // A user could `ipk install`-shaped a folder named `sqlite3`; the native
    // guard must still fire BEFORE any node_modules resolution so the realm
    // never tries to evaluate the (unusable) C++ binding stub.
    const fetchSpy = noFetchSpy();
    const ctx = makeCtx({
      fetch: fetchSpy,
      files: {
        '/workspace/node_modules/sqlite3/package.json': JSON.stringify({
          name: 'sqlite3',
          version: '5.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/sqlite3/index.js': "module.exports = { real: 'should-not-load' };",
      },
    });
    const out = await runCode("const s = require('sqlite3'); console.log(s.real);", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('native module');
    expect(out.stdout).not.toContain('should-not-load');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves the original specifier (node: prefix) and runs no shell command', async () => {
    const fetchSpy = noFetchSpy();
    const ctx = makeCtx({ fetch: fetchSpy });
    const out = await runCode("require('node:canvas');", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("require('node:canvas')");
    expect(out.stderr).toContain('native module');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('VAL-REQUIRE-014: broken package metadata errors clearly without hanging', () => {
  it('a package whose main points at a nonexistent file errors clearly and terminates', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/brokenmain/package.json': JSON.stringify({
          name: 'brokenmain',
          version: '1.0.0',
          main: './nope.js',
        }),
      },
    });
    const start = Date.now();
    const out = await runCode("require('brokenmain');", ctx);
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(1);
    // A clear resolution error that names the missing entry — not a silent
    // success and not an opaque crash with no output.
    expect(out.stderr).toMatch(/missing/);
    expect(out.stderr).toContain('nope.js');
    expect(out.stderr).not.toBe('');
    expect(elapsed).toBeLessThan(2000);
  });

  it('a package with malformed (invalid-JSON) package.json errors clearly and terminates', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/badmeta/package.json': '{ "name": "badmeta", not valid json',
        '/workspace/node_modules/badmeta/index.js': 'module.exports = 1;',
      },
    });
    const start = Date.now();
    const out = await runCode("require('badmeta');", ctx);
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('Invalid package.json');
    expect(out.stderr).toContain('badmeta');
    expect(elapsed).toBeLessThan(2000);
  });

  it('broken metadata reached through a nested require surfaces and terminates (no hang)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/good/package.json': JSON.stringify({
          name: 'good',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/good/index.js': "module.exports = require('brokendep');",
        '/workspace/node_modules/brokendep/package.json': JSON.stringify({
          name: 'brokendep',
          version: '1.0.0',
          main: './missing.js',
        }),
      },
    });
    const start = Date.now();
    const out = await runCode("require('good');", ctx);
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toMatch(/missing/);
    expect(out.stderr).not.toBe('');
    expect(elapsed).toBeLessThan(2000);
  });

  it('the realm stays usable after a broken-metadata failure (no broken shell state)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/badmeta/package.json': '{ not json',
      },
    });
    const failed = await runCode("require('badmeta');", ctx);
    expect(failed.exitCode).toBe(1);
    // A fresh realm run against the same ctx still executes normally.
    const ok = await runCode("console.log('still-alive');", ctx);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('still-alive');
  });
});

describe('VAL-REQUIRE-015: circular requires terminate with CJS partial-exports semantics', () => {
  it('a relative a.js <-> b.js cycle resolves deterministically without deadlocking', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/a.js': `
          exports.name = 'a';
          const b = require('./b.js');
          exports.bValue = b.value;
          module.exports.done = true;
        `,
        '/workspace/b.js': `
          const a = require('./a.js');
          // When b loads, a is partially evaluated: a.name is already set,
          // but a.done has not been assigned yet (CJS partial exports).
          exports.aNameWhenLoaded = a.name;
          exports.aDoneWhenLoaded = a.done;
          exports.value = 'b-value';
        `,
      },
    });
    const start = Date.now();
    const out = await runCode(
      `const a = require('./a.js');
       const b = require('./b.js');
       console.log(a.name, a.done, a.bValue);
       console.log(b.aNameWhenLoaded, String(b.aDoneWhenLoaded), b.value);`,
      ctx
    );
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    const lines = out.stdout.split('\n').filter(Boolean);
    // a fully evaluated.
    expect(lines[0]).toBe('a true b-value');
    // b observed a's partial exports: a.name present, a.done not yet assigned.
    expect(lines[1]).toBe('a undefined b-value');
    expect(elapsed).toBeLessThan(2000);
  });

  it('a package-level cycle (two installed packages requiring each other) terminates', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/pkg-a/package.json': JSON.stringify({
          name: 'pkg-a',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/pkg-a/index.js': `
          exports.tag = 'a';
          const b = require('pkg-b');
          exports.bTag = b.tag;
        `,
        '/workspace/node_modules/pkg-b/package.json': JSON.stringify({
          name: 'pkg-b',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/pkg-b/index.js': `
          const a = require('pkg-a');
          exports.tag = 'b';
          exports.aTagWhenLoaded = a.tag;
        `,
      },
    });
    const start = Date.now();
    const out = await runCode(
      `const a = require('pkg-a');
       const b = require('pkg-b');
       console.log(a.tag, a.bTag, b.tag, b.aTagWhenLoaded);`,
      ctx
    );
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('a b b a');
    expect(elapsed).toBeLessThan(2000);
  });

  it('a self-referential require terminates and returns the partial exports', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/self.js': `
          exports.first = 1;
          const me = require('./self.js');
          exports.sawFirst = me.first;
          exports.sawSecond = me.second;
          exports.second = 2;
        `,
      },
    });
    const start = Date.now();
    const out = await runCode(
      `const m = require('./self.js');
       console.log(m.first, m.second, m.sawFirst, String(m.sawSecond));`,
      ctx
    );
    const elapsed = Date.now() - start;

    expect(out.exitCode).toBe(0);
    // self-require returns the partial exports captured at the point of the
    // recursive require: first present, second not yet assigned.
    expect(out.stdout.trim()).toBe('1 2 1 undefined');
    expect(elapsed).toBeLessThan(2000);
  });
});
