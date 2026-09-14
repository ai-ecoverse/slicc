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

  it('ignores require() tokens inside strings, templates, and comments', () => {
    const src = [
      'const usage = "require(\'in-string\')";',
      "const t = `require('in-template')`;",
      "// require('in-line-comment')",
      "/* require('in-block-comment') */",
      "const real = require('real-dep');",
    ].join('\n');
    expect(extractRequireSpecifiers(src)).toEqual(['real-dep']);
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

  it('defers an unresolvable nested require to edgeErrors instead of sinking the graph', async () => {
    const reader = makeReader({
      '/app/index.js': "module.exports = require('not-installed');",
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['./index.js'],
      fromDir: '/app',
      reader,
    });

    expect(graph.files.map((f) => f.path)).toEqual(['/app/index.js']);
    expect(graph.edges['/app/index.js']).toEqual({});
    expect(graph.edgeErrors['/app/index.js']['not-installed']).toBe(
      "Cannot find module 'not-installed' (run: ipk install not-installed)"
    );
  });

  it('keeps a package usable when only an OPTIONAL nested require is missing', async () => {
    const reader = makeReader({
      '/app/node_modules/withoptional/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/withoptional/index.js': `
        let color = null;
        try { color = require('supports-color'); } catch {}
        module.exports = { color, ok: true };
      `,
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['withoptional'],
      fromDir: '/app',
      reader,
    });
    expect(graph.entryMap.withoptional).toBe('/app/node_modules/withoptional/index.js');
    expect(graph.edgeErrors['/app/node_modules/withoptional/index.js']['supports-color']).toContain(
      "Cannot find module 'supports-color'"
    );
  });

  it('records no edgeErrors entry for a file whose specifiers all resolve', async () => {
    const reader = makeReader({
      '/app/index.js': "module.exports = require('./dep.js');",
      '/app/dep.js': 'module.exports = 1;',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['./index.js'],
      fromDir: '/app',
      reader,
    });
    expect(graph.edgeErrors).toEqual({});
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

  it('strips a leading shebang from CJS module source before evaluation (Wave 15 / fix B1)', async () => {
    const reader = makeReader({
      '/app/node_modules/binmod/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/binmod/index.js': '#!/usr/bin/env node\nmodule.exports = "ok";\n',
    });
    const graph = await buildModuleGraph({
      entrySpecifiers: ['binmod'],
      fromDir: '/app',
      reader,
    });
    const mod = graph.files.find((f) => f.path === '/app/node_modules/binmod/index.js');
    expect(mod).toBeDefined();

    expect(mod?.source.startsWith('#!')).toBe(true);
    expect(mod?.cjsSource.startsWith('#!')).toBe(false);
    expect(mod?.cjsSource).toContain('module.exports = "ok";');

    const evaluated = new Function('module', `${mod?.cjsSource}; return module.exports;`)({
      exports: {},
    });
    expect(evaluated).toBe('ok');
  });

  it('strips a leading shebang from ESM source before passing it to the transpile hook', async () => {
    const reader = makeReader({
      '/app/node_modules/esm-bin/package.json': JSON.stringify({
        type: 'module',
        main: 'index.js',
      }),
      '/app/node_modules/esm-bin/index.js': '#!/usr/bin/env node\nexport default 42;\n',
    });
    let seenSource = '';
    const graph = await buildModuleGraph({
      entrySpecifiers: ['esm-bin'],
      fromDir: '/app',
      reader,
      transpile: ({ source }) => {
        seenSource = source;
        return `/*cjs*/ ${source.replace('export default', 'module.exports =')}`;
      },
    });

    expect(seenSource.startsWith('#!')).toBe(false);
    expect(seenSource).toContain('export default 42;');
    const mod = graph.files[0];
    expect(mod.kind).toBe('esm');
    expect(mod.cjsSource).toContain('module.exports = 42;');
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
