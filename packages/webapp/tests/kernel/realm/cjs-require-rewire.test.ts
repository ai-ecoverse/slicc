/**
 * CJS require hard-switch (m4-cjs-require-rewire / cjs-require-rewire-core).
 *
 * The realm `require()` is wired to the host-resolved `node_modules` CJS loader
 * in BOTH floats (architecture 4.4, 6). These tests drive the in-process realm
 * factory (same `runJsRealm` engine the production worker/iframe floats use, so
 * behavior parity is by construction) over a directory-aware in-memory VFS,
 * exercising the `module`/buildGraph RPC end to end: installed packages,
 * intra-package relative requires, transitive deps, the CJS singleton cache,
 * preserved schemes/built-ins, and the hard install-hint error with NO CDN.
 *
 * Fulfills VAL-REQUIRE-001/002/003/004/011/013/016 and the resolution side of
 * VAL-CROSS-001/002/011 (the live-registry browser leg is validated separately).
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

// Minimal faithful fixtures mirroring the validation-contract packages.
const PKG_IS_NUMBER = {
  '/workspace/node_modules/is-number/package.json': JSON.stringify({
    name: 'is-number',
    version: '7.0.0',
    main: 'index.js',
  }),
  '/workspace/node_modules/is-number/index.js': `
    module.exports = function isNumber(num) {
      if (typeof num === 'number') return num - num === 0;
      if (typeof num === 'string' && num.trim() !== '') {
        return Number.isFinite ? Number.isFinite(+num) : isFinite(+num);
      }
      return false;
    };
  `,
};

describe('VAL-REQUIRE-001: installed CJS package is requirable and returns module.exports verbatim', () => {
  it('runs the package and returns the raw function export (no {default}/namespace wrapper)', async () => {
    const ctx = makeCtx({ files: PKG_IS_NUMBER });
    const out = await runCode(
      `const isNumber = require('is-number');
       console.log(isNumber(5), isNumber('x'));
       console.log(typeof require('is-number'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('true false');
    expect(lines[1]).toBe('function');
  });
});

describe('VAL-REQUIRE-002: intra-package relative requires load', () => {
  it('resolves a sibling file require transparently', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/multi/package.json': JSON.stringify({
          name: 'multi',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/multi/index.js': "module.exports = require('./lib/greet.js');",
        '/workspace/node_modules/multi/lib/greet.js':
          "module.exports = function greet(name) { return 'hello ' + name; };",
      },
    });
    const out = await runCode("console.log(require('multi')('world'));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello world');
  });
});

describe('VAL-REQUIRE-003: transitive dependency resolves transparently', () => {
  it("is-odd's own require('is-number') resolves from the installed tree", async () => {
    const ctx = makeCtx({
      files: {
        ...PKG_IS_NUMBER,
        '/workspace/node_modules/is-odd/package.json': JSON.stringify({
          name: 'is-odd',
          version: '3.0.1',
          main: 'index.js',
        }),
        '/workspace/node_modules/is-odd/index.js': `
          const isNumber = require('is-number');
          module.exports = function isOdd(value) {
            const n = Math.abs(Number(value));
            if (!isNumber(n)) throw new TypeError('expected a number');
            return (n % 2) === 1;
          };
        `,
      },
    });
    const out = await runCode("console.log(require('is-odd')(3), require('is-odd')(4));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true false');
  });
});

describe('VAL-REQUIRE-004: CJS module cache returns one shared singleton', () => {
  it('returns the identical instance across two requires of the same module', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/m.js':
          'const m = { value: 0 }; m.bump = function () { m.value++; }; module.exports = m;',
      },
    });
    const out = await runCode(
      `const a = require('./m.js');
       const b = require('./m.js');
       a.bump();
       console.log(b.value, a === b);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('1 true');
  });
});

describe('VAL-REQUIRE-011: schemes and Node built-ins are preserved through the rewire', () => {
  it('node:path / bare path / fs / node:fs / sliccy:exec all resolve without install or hard-error', async () => {
    const ctx = makeCtx({
      exec: (async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })) as CommandContext['exec'],
    });
    const out = await runCode(
      `console.log(require('node:path').join('a', 'b'));
       console.log(require('path').basename('/x/y.txt'));
       const fs = require('fs');
       console.log(typeof fs.readFile);
       await fs.writeFile('rt.txt', 'roundtrip');
       console.log(await fs.readFile('rt.txt'));
       console.log(typeof require('node:fs').readFile);
       console.log(typeof require('sliccy:exec'));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('Cannot find module');
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('a/b');
    expect(lines[1]).toBe('y.txt');
    expect(lines[2]).toBe('function');
    expect(lines[3]).toBe('roundtrip');
    expect(lines[4]).toBe('function');
    expect(lines[5]).toBe('function');
  });

  it('a .json require returns the parsed object', async () => {
    const ctx = makeCtx({ files: { '/workspace/data.json': '{"answer":42}' } });
    const out = await runCode("console.log(require('./data.json').answer);", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('42');
  });
});

describe('VAL-REQUIRE-013 / VAL-CROSS-011: uninstalled bare module hard-errors with the install hint, no CDN', () => {
  it('throws exactly "Cannot find module \'x\' (run: ipk install x)" with non-zero exit and no fetch', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('NO CDN: realm must never fetch a module');
    });
    const ctx = makeCtx({ fetch: fetchSpy as unknown as CommandContext['fetch'] });
    const start = Date.now();
    const out = await runCode("require('not-installed');", ctx);
    const elapsed = Date.now() - start;
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain(
      "Cannot find module 'not-installed' (run: ipk install not-installed)"
    );
    expect(out.stderr).not.toContain('esm.sh');
    expect(out.stderr).not.toContain('jsdelivr');
    // No CDN fetch occurred and the failure is immediate (no ~15s prefetch).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(2000);
  });

  it('a real-on-npm-but-uninstalled package (left-pad) also hard-errors with the install hint', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('NO CDN');
    });
    const ctx = makeCtx({ fetch: fetchSpy as unknown as CommandContext['fetch'] });
    const out = await runCode("require('left-pad');", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Cannot find module 'left-pad' (run: ipk install left-pad)");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
