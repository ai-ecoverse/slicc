/**
 * Bare Node built-ins through the realm require shim and the host-side graph
 * walker (m4-fix-graph-walker-bare-builtins).
 *
 * A real npm package frequently does `require('crypto')` / `require('stream')`
 * / `require('http')` internally. The host-side graph walker must treat EVERY
 * bare Node built-in (and its `node:` form) as graph-external — never routing
 * it through node_modules resolution — so the package's graph builds. The
 * realm require shim then SERVES the available built-ins (fs/path/process/
 * buffer) and HARD-FAILS the rest with the browser-unavailable message (NOT a
 * misleading "Cannot find module 'x' (run: ipk install x)").
 *
 * Drives the same in-process `runJsRealm` engine the worker/iframe floats use,
 * so behavior parity is by construction.
 */

import { describe, expect, it } from 'vitest';
import { makeCtx, runCode } from './cjs-realm-harness.js';

describe('m4: nested package require of a browser-unavailable built-in', () => {
  it('a package that internally requires crypto hard-fails with the built-in-unavailable message (not Cannot find module)', async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/usescrypto/package.json': JSON.stringify({
          name: 'usescrypto',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/usescrypto/index.js':
          "const crypto = require('crypto'); module.exports = () => crypto.randomBytes(8);",
      },
    });
    const out = await runCode("const u = require('usescrypto'); u();", ctx);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain('not available in the browser');
    expect(out.stderr).toContain('crypto');
    // The bug: the graph walker used to route bare builtins into node_modules,
    // surfacing the install-hint instead of the built-in-unavailable error.
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stderr).not.toContain('ipk install');
  });

  it.each([
    'stream',
    'http',
    'zlib',
    'os',
    'util',
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

  it('a package that internally requires crypto LOADS fine until the built-in is actually requested', async () => {
    // Importing the package must not fail at graph-build time — only the actual
    // require('crypto') at call time hard-fails. A lazily-guarded path that
    // never touches crypto runs clean.
    const ctx = makeCtx({
      files: {
        '/workspace/node_modules/lazycrypto/package.json': JSON.stringify({
          name: 'lazycrypto',
          version: '1.0.0',
          main: 'index.js',
        }),
        '/workspace/node_modules/lazycrypto/index.js':
          "module.exports = { hash: () => require('crypto').createHash('sha256'), tag: 'loaded' };",
      },
    });
    const out = await runCode("const m = require('lazycrypto'); console.log(m.tag);", ctx);
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

  it('require("node:crypto") at top level still hard-fails with the unavailable message', async () => {
    const ctx = makeCtx();
    const out = await runCode(
      "try { require('node:crypto'); console.log('UNEXPECTED'); } catch (e) { console.log(e.message); }",
      ctx
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('not available in the browser');
    expect(out.stdout).toContain('crypto');
    expect(out.stdout).not.toContain('Cannot find module');
  });
});
