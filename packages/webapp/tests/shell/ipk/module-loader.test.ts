/**
 * Host-side CJS module-graph builder tests (architecture 4.1 #2, 4.4, §5).
 *
 * Drives `buildModuleGraph` over a synthesized in-memory node_modules tree and
 * asserts: ordered (dependency-first) graphs, recursive nested-require edges,
 * entryMap wiring, JSON normalization, scheme/builtin edges skipped, cycle
 * termination, propagation of the resolver install-hint error, and the ESM
 * transpile-hook seam.
 */
import { describe, expect, it } from 'vitest';
import { normalizePath, splitPath } from '../../../src/fs/path-utils.js';
import {
  buildModuleGraph,
  extractRequireSpecifiers,
} from '../../../src/shell/ipk/module-loader.js';
import type { ModuleReader } from '../../../src/shell/ipk/resolver.js';

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
    exists: async (path) => {
      const p = normalizePath(path);
      return fileSet.has(p) || dirs.has(p);
    },
    isDirectory: async (path) => dirs.has(normalizePath(path)),
    readFile: async (path) => {
      const p = normalizePath(path);
      if (!(p in norm)) throw new Error(`ENOENT: ${p}`);
      return norm[p];
    },
  };
}

describe('extractRequireSpecifiers()', () => {
  it('extracts unique require() specifiers across quote styles', () => {
    const src = "require('a'); require(\"b\"); require(`c`); require('a');";
    expect(extractRequireSpecifiers(src).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('buildModuleGraph()', () => {
  it('resolves an entry and follows an intra-package relative require', async () => {
    const reader = makeReader({
      '/app/node_modules/multi/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/multi/index.js': "module.exports = require('./lib/greet.js');",
      '/app/node_modules/multi/lib/greet.js': 'module.exports = (n) => `hello ${n}`;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['multi'],
      fromDir: '/app',
      reader,
    });
    expect(graph.entryMap.multi).toBe('/app/node_modules/multi/index.js');
    const paths = graph.files.map((f) => f.path);
    // Dependency-first: greet.js (leaf) before index.js (entry).
    expect(paths).toEqual([
      '/app/node_modules/multi/lib/greet.js',
      '/app/node_modules/multi/index.js',
    ]);
  });

  it('follows a transitive require chain across packages in dependency order', async () => {
    const reader = makeReader({
      '/app/node_modules/a/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/a/index.js': "module.exports = require('b');",
      '/app/node_modules/b/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/b/index.js': "module.exports = require('c');",
      '/app/node_modules/c/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/c/index.js': 'module.exports = 3;',
    });
    const graph = await buildModuleGraph({ entrySpecifiers: ['a'], fromDir: '/app', reader });
    expect(graph.files.map((f) => f.path)).toEqual([
      '/app/node_modules/c/index.js',
      '/app/node_modules/b/index.js',
      '/app/node_modules/a/index.js',
    ]);
  });

  it('normalizes a JSON module to a CJS module.exports form', async () => {
    const reader = makeReader({
      '/app/index.js': "module.exports = require('./data.json');",
      '/app/data.json': '{"answer":42}',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['./index.js'],
      fromDir: '/app',
      reader,
    });
    const json = graph.files.find((f) => f.path === '/app/data.json');
    expect(json?.kind).toBe('json');
    expect(json?.cjsSource).toContain('module.exports = JSON.parse(');
    // The wrapped source must round-trip to the original object.
    const exported = new Function('module', `${json?.cjsSource}; return module.exports;`)({
      exports: {},
    });
    expect(exported).toEqual({ answer: 42 });
  });

  it('skips node:/sliccy:/bare-builtin require edges (not part of the file graph)', async () => {
    const reader = makeReader({
      '/app/index.js':
        "const fs = require('fs'); const path = require('node:path'); const { exec } = require('sliccy:exec'); module.exports = 1;",
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['./index.js'],
      fromDir: '/app',
      reader,
    });
    expect(graph.files.map((f) => f.path)).toEqual(['/app/index.js']);
  });

  it('treats a nested package require of any bare Node built-in as a graph-external edge', async () => {
    // A real npm package that internally does require('crypto') / require('stream') /
    // require('http') / require('zlib') must build as a builtin edge (no
    // "Cannot find module" / node_modules miss). The realm shim guards them at
    // require time; the graph walker only owns node_modules resolution.
    const reader = makeReader({
      '/app/node_modules/needsbuiltins/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/needsbuiltins/index.js': `
        const crypto = require('crypto');
        const stream = require('stream');
        const http = require('http');
        const zlib = require('zlib');
        const util = require('util');
        const events = require('events');
        const os = require('node:os');
        module.exports = { crypto, stream, http, zlib, util, events, os };
      `,
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['needsbuiltins'],
      fromDir: '/app',
      reader,
    });
    // Only the package file is in the graph — no builtin became a file edge.
    expect(graph.files.map((f) => f.path)).toEqual(['/app/node_modules/needsbuiltins/index.js']);
    expect(graph.edges['/app/node_modules/needsbuiltins/index.js']).toEqual({});
  });

  it('terminates on a require cycle, visiting each file once', async () => {
    const reader = makeReader({
      '/app/a.js': "exports.name = 'a'; exports.b = require('./b.js');",
      '/app/b.js': "exports.name = 'b'; exports.a = require('./a.js');",
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['./a.js'],
      fromDir: '/app',
      reader,
    });
    const paths = graph.files.map((f) => f.path).sort();
    expect(paths).toEqual(['/app/a.js', '/app/b.js']);
  });

  it('propagates the resolver install-hint error for an unresolvable nested require', async () => {
    const reader = makeReader({
      '/app/index.js': "module.exports = require('not-installed');",
    });
    await expect(
      buildModuleGraph({ entrySpecifiers: ['./index.js'], fromDir: '/app', reader })
    ).rejects.toThrow("Cannot find module 'not-installed' (run: ipk install not-installed)");
  });

  it('throws a clear error for an ESM module when no transpile hook is given', async () => {
    const reader = makeReader({
      '/app/node_modules/esm-pkg/package.json': JSON.stringify({
        type: 'module',
        main: 'index.js',
      }),
      '/app/node_modules/esm-pkg/index.js': 'export default 1;',
    });
    await expect(
      buildModuleGraph({ entrySpecifiers: ['esm-pkg'], fromDir: '/app', reader })
    ).rejects.toThrow(/no transpile hook/);
  });

  it('uses the transpile hook to convert ESM source to CJS', async () => {
    const reader = makeReader({
      '/app/node_modules/esm-pkg/package.json': JSON.stringify({
        type: 'module',
        main: 'index.js',
      }),
      '/app/node_modules/esm-pkg/index.js': 'export default 1;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['esm-pkg'],
      fromDir: '/app',
      reader,
      transpile: ({ source }) => `/*cjs*/ ${source.replace('export default', 'module.exports =')}`,
    });
    const mod = graph.files[0];
    expect(mod.kind).toBe('esm');
    expect(mod.cjsSource).toContain('module.exports = 1;');
  });

  it('passes import-time conditions through to resolution', async () => {
    const reader = makeReader({
      '/app/node_modules/dual/package.json': JSON.stringify({
        exports: { '.': { require: './cjs.js', import: './esm.js' } },
      }),
      '/app/node_modules/dual/cjs.js': 'module.exports = 1;',
      '/app/node_modules/dual/esm.js': 'module.exports = 2;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['dual'],
      fromDir: '/app',
      reader,
      conditions: ['node', 'import', 'default'],
    });
    expect(graph.entryMap.dual).toBe('/app/node_modules/dual/esm.js');
  });
});
