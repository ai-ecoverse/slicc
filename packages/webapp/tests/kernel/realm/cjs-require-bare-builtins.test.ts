/**
 * Bare Node built-ins through the realm require shim and the host-side graph
 * walker (m4-fix-graph-walker-bare-builtins).
 *
 * A real npm package frequently does `require('crypto')` / `require('stream')`
 * / `require('http')` internally. The host-side graph walker must treat EVERY
 * bare Node built-in (and its `node:` form) as graph-external — never routing
 * it through node_modules resolution — so the package's graph builds. The
 * realm require shim then SERVES the available built-ins (fs/path/crypto/
 * process/buffer) and HARD-FAILS the rest with the browser-unavailable message
 * (NOT a misleading "Cannot find module 'x' (run: ipk install x)").
 *
 * `crypto` is now SERVED (Web Crypto-backed `nodeCrypto` bridge), so the
 * still-unavailable-builtin contract is pinned via `os` instead; the positive
 * crypto coverage lives in the "crypto built-in bridge" describe below.
 *
 * Drives the same in-process `runJsRealm` engine the worker/iframe floats use,
 * so behavior parity is by construction.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('m4: nested package require of a browser-unavailable built-in', () => {
  it('a package that internally requires os hard-fails with the built-in-unavailable message (not Cannot find module)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/usesos/package.json': JSON.stringify({
          name: 'usesos',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usesos/index.js':
          "const os = require('os'); module.exports = () => os.hostname();",
      },
    });
    const out = await runCode("const u = require('usesos'); u();", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('not available in the browser');
    expect(out.stderr).toContain('os');
    // The bug: the graph walker used to route bare builtins into node_modules,
    // surfacing the install-hint instead of the built-in-unavailable error.
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stderr).not.toContain('ipk install');
  });

  it.each([
    'stream',
    'http',
    'os',
    'events',
  ])('a package that internally requires %s hard-fails with the built-in-unavailable message', async (builtin) => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/usesbuiltin/package.json': JSON.stringify({
          name: 'usesbuiltin',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usesbuiltin/index.js': `const m = require('${builtin}'); module.exports = () => m;`,
      },
    });
    const out = await runCode("const u = require('usesbuiltin'); u();", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('not available in the browser');
    expect(out.stderr).toContain(builtin);
    expect(out.stderr).not.toContain('Cannot find module');
  });

  it('a package that internally requires an unavailable built-in LOADS fine until it is actually requested', async () => {
    // Importing the package must not fail at graph-build time — only the actual
    // require('os') at call time hard-fails. A lazily-guarded path that never
    // touches the unavailable built-in runs clean.
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/lazyos/package.json': JSON.stringify({
          name: 'lazyos',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/lazyos/index.js':
          "module.exports = { host: () => require('os').hostname(), tag: 'loaded' };",
      },
    });
    const out = await runCode("const m = require('lazyos'); console.log(m.tag);", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('loaded');
    expect(out.stderr).not.toContain('Cannot find module');
  });
});

describe('m4: available bare built-ins and node:-prefixed built-ins keep working', () => {
  it('a package that internally requires fs/path/process/buffer resolves them as built-ins', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/a.txt': 'file-contents',
        '/workspace/node_modules/usesfs/package.json': JSON.stringify({
          name: 'usesfs',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usesfs/index.js': `
          const fsMod = require('fs');
          const pathMod = require('path');
          const procMod = require('process');
          const bufMod = require('buffer');
          module.exports = {
            read: () => fsMod.readFile('/workspace/a.txt'),
            joined: pathMod.join('/x', 'y'),
            hasCwd: typeof procMod.cwd === 'function',
            buf: bufMod.Buffer.from('hi').toString(),
          };
        `,
      },
    });
    const out = await runCode(
      `const m = require('usesfs');
       console.log(m.joined, m.hasCwd, m.buf);
       console.log(await m.read());`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('/x/y true hi');
    expect(lines[1]).toBe('file-contents');
  });

  it('require("node:os") at top level still hard-fails with the unavailable message', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      "try { require('node:os'); console.log('UNEXPECTED'); } catch (e) { console.log(e.message); }",
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('not available in the browser');
    expect(out.stdout).toContain('os');
    expect(out.stdout).not.toContain('Cannot find module');
  });
});

describe('m5: crypto built-in is served by the Web Crypto-backed bridge', () => {
  it('require("crypto") and require("node:crypto") return the SAME bridge with randomFillSync/randomUUID/randomBytes', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const crypto = require('crypto');
       const aliased = require('node:crypto');
       const buf = new Uint8Array(8);
       const same = crypto.randomFillSync(buf) === buf;
       const filled = buf.some((b) => b !== 0);
       const uuid = crypto.randomUUID();
       const rb = crypto.randomBytes(16);
       const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
       console.log(same, filled, v4.test(uuid), rb.length === 16, aliased === crypto);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('true true true true true');
  });

  it('randomFillSync fills buffers larger than the 65536-byte Web Crypto limit (chunked) and returns the same buffer', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const crypto = require('crypto');
       const big = new Uint8Array(70000);
       const ret = crypto.randomFillSync(big);
       // A correctly-chunked fill leaves no long all-zero run; sample a few
       // bytes past the 65536 boundary to confirm the second chunk ran.
       const pastBoundary = big.subarray(65536).some((b) => b !== 0);
       console.log(ret === big, big.length === 70000, pastBoundary);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true true true');
  });

  it('randomFillSync honors the offset/size arguments, leaving the rest untouched', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const crypto = require('crypto');
       const buf = new Uint8Array(16);
       crypto.randomFillSync(buf, 4, 4);
       const headZero = buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
       const tailZero = buf.subarray(8).every((b) => b === 0);
       console.log(headZero, tailZero);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true true');
  });
});

describe('Wave 14: assert built-in is served by the nodeAssert shim', () => {
  it('require("assert") and require("node:assert") return the SAME callable shim with .ok / .equal / .strictEqual / .deepEqual / .throws / .AssertionError / .strict', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const assert = require('assert');
       const aliased = require('node:assert');
       assert(true, 'callable form ok');
       assert.ok(1);
       assert.equal(1, '1');
       assert.strictEqual(2, 2);
       assert.notEqual(1, 2);
       assert.notStrictEqual(1, '1');
       assert.deepEqual({ a: 1, b: [2] }, { a: 1, b: [2] });
       assert.deepStrictEqual([1, 2, 3], [1, 2, 3]);
       assert.throws(() => { throw new TypeError('boom'); }, TypeError);
       assert.doesNotThrow(() => {});
       const isErr = assert.AssertionError && new assert.AssertionError({ message: 'x' }).code === 'ERR_ASSERTION';
       const same = aliased === assert;
       const strictRef = assert.strict && assert.strict.strict === assert.strict;
       console.log(isErr, same, strictRef);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('true true true');
  });

  it('assert.strictEqual throws an AssertionError-shaped error on mismatch', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const assert = require('assert');
       try {
         assert.strictEqual(1, 2);
         console.log('UNEXPECTED');
       } catch (e) {
         console.log(e.name, e.code, e.actual, e.expected, e.operator);
       }`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('AssertionError ERR_ASSERTION 1 2 strictEqual');
  });

  it('require("assert/strict") returns the strict variant where .equal is strict and .deepEqual is deepStrictEqual', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const strict = require('assert/strict');
       let looseEqThrew = false;
       try { strict.equal(1, '1'); } catch (e) { looseEqThrew = e.code === 'ERR_ASSERTION'; }
       let looseDeepThrew = false;
       try { strict.deepEqual({ a: 1 }, { a: '1' }); } catch (e) { looseDeepThrew = e.code === 'ERR_ASSERTION'; }
       console.log(looseEqThrew, looseDeepThrew, strict.strict === strict);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true true true');
  });

  it('a node_modules package that internally requires assert loads and runs without "module not available"', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/usesassert/package.json': JSON.stringify({
          name: 'usesassert',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usesassert/index.js':
          "const assert = require('assert'); module.exports = (v) => { assert.ok(v, 'must be truthy'); return 'ok'; };",
      },
    });
    const out = await runCode("const u = require('usesassert'); console.log(u(1));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('ok');
  });
});

describe('NS3: util built-in is served by the nodeUtil shim', () => {
  it('require("util") / require("node:util") return the SAME shim with format/inspect/inherits/promisify', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const util = require('util');
       const aliased = require('node:util');
       const fmt = util.format('%s=%d json=%j', 'x', 7, { a: 1 });
       const ins = util.inspect({ a: 1, b: [2, 3] });
       function Base() {}
       Base.prototype.hi = function () { return 'hi'; };
       function Child() {}
       util.inherits(Child, Base);
       const childHasHi = new Child().hi() === 'hi' && Child.super_ === Base;
       const readBack = util.promisify((v, cb) => cb(null, v * 2));
       const doubled = await readBack(21);
       console.log(fmt, '|', ins, '|', childHasHi, '|', doubled, '|', aliased === util);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stdout.trim()).toBe('x=7 json={"a":1} | { a: 1, b: [ 2, 3 ] } | true | 42 | true');
  });

  it('a node_modules package that internally requires util loads and runs', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/usesutil/package.json': JSON.stringify({
          name: 'usesutil',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usesutil/index.js':
          "const util = require('util'); module.exports = (o) => util.format('%o', o);",
      },
    });
    const out = await runCode("const u = require('usesutil'); console.log(u({ k: 'v' }));", ctx);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stdout.trim()).toBe("{ k: 'v' }");
  });
});

describe('NS3: crypto.createHash is served by the pure-JS hasher bridge', () => {
  it('computes md5 / sha1 / sha256 hex digests matching known vectors', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const crypto = require('crypto');
       const md5 = crypto.createHash('md5').update('abc').digest('hex');
       const sha1 = crypto.createHash('sha1').update('abc').digest('hex');
       const sha256 = crypto.createHash('sha256').update('abc').digest('hex');
       console.log(md5);
       console.log(sha1);
       console.log(sha256);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    const lines = out.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(lines[1]).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(lines[2]).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('supports incremental update calls and a default Buffer digest', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const crypto = require('crypto');
       const h = crypto.createHash('sha256');
       h.update('a'); h.update('b'); h.update('c');
       const buf = h.digest();
       console.log(Buffer.isBuffer(buf), buf.length, buf.toString('hex').slice(0, 8));`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true 32 ba7816bf');
  });
});

describe('NS3: zlib built-in is served by the pako-backed shim', () => {
  it('round-trips gzip/gunzip and deflate/inflate (sync) preserving the payload', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const zlib = require('zlib');
       const aliased = require('node:zlib');
       const text = 'hello hello hello zlib world';
       const gz = zlib.gzipSync(text);
       const back = zlib.gunzipSync(gz).toString();
       const df = zlib.deflateSync(text);
       const inf = zlib.inflateSync(df).toString();
       console.log(Buffer.isBuffer(gz), back === text, inf === text, aliased === zlib);`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.stdout.trim()).toBe('true true true true');
  });

  it('round-trips the async callback form of gzip/gunzip', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      `const zlib = require('zlib');
       const text = 'async zlib payload';
       await new Promise((resolve, reject) => {
         zlib.gzip(text, (err, gz) => {
           if (err) return reject(err);
           zlib.gunzip(gz, (err2, out) => {
             if (err2) return reject(err2);
             console.log(out.toString() === text);
             resolve();
           });
         });
       });`,
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('true');
  });
});
