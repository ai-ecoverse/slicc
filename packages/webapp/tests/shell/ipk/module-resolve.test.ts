/**
 * Require/ipx-time Node module resolution tests (architecture 4.1 #2, §5).
 *
 * Exercises every branch of `resolve()` against a synthesized in-memory
 * node_modules tree: scheme handling (node:/sliccy:/bare built-ins), relative
 * and absolute path resolution (exact, extension, json, index, file-over-dir
 * precedence), the nearest-node_modules walk (ancestor + nearest-wins),
 * package.json entry selection (exports conditions, main/module, index
 * fallback), scoped packages, deep subpaths, module-kind detection, and the
 * exact uninstalled-package error string.
 */
import { describe, expect, it } from 'vitest';
import { normalizePath, splitPath } from '../../../src/fs/path-utils.js';
import {
  createVfsModuleReader,
  detectModuleKind,
  type ModuleReader,
  resolve,
} from '../../../src/shell/ipk/resolver.js';

/** Build a ModuleReader over a flat `{ path: contents }` map. */
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

describe('resolve() — schemes', () => {
  const reader = makeReader({});

  it('resolves a node: specifier to a builtin', async () => {
    const r = await resolve('node:path', '/app', reader);
    expect(r).toEqual({ type: 'builtin', specifier: 'node:path', name: 'path' });
  });

  it('resolves bare Node built-ins (fs/path/process/buffer) to builtins', async () => {
    for (const name of ['fs', 'path', 'process', 'buffer']) {
      const r = await resolve(name, '/app', reader);
      expect(r).toEqual({ type: 'builtin', specifier: name, name });
    }
  });

  it('resolves the complete set of bare Node built-ins to builtins (not node_modules)', async () => {
    // The browser-unavailable built-ins must still resolve as graph-external
    // builtins so they are never routed through node_modules resolution (the
    // realm require shim guards them at require time). Regression for a real
    // npm package that internally does require('crypto') / require('stream').
    for (const name of [
      'crypto',
      'stream',
      'os',
      'http',
      'https',
      'zlib',
      'util',
      'events',
      'net',
      'tls',
      'assert',
      'url',
      'querystring',
    ]) {
      const r = await resolve(name, '/app', reader);
      expect(r).toEqual({ type: 'builtin', specifier: name, name });
    }
  });

  it('resolves node:-prefixed built-ins across the complete set', async () => {
    for (const name of ['crypto', 'stream', 'http', 'zlib', 'util', 'events']) {
      const r = await resolve(`node:${name}`, '/app', reader);
      expect(r).toEqual({ type: 'builtin', specifier: `node:${name}`, name });
    }
  });

  it('prefers the built-in over a same-named installed package (built-ins win)', async () => {
    const shadowing = makeReader({
      '/app/node_modules/crypto/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/crypto/index.js': "module.exports = 'should-not-resolve';",
    });
    const r = await resolve('crypto', '/app', shadowing);
    expect(r).toEqual({ type: 'builtin', specifier: 'crypto', name: 'crypto' });
  });

  it('resolves a sliccy: specifier to a capability marker', async () => {
    const r = await resolve('sliccy:exec', '/app', reader);
    expect(r).toEqual({ type: 'sliccy', specifier: 'sliccy:exec', name: 'exec' });
  });

  it('throws on an empty sliccy: name (not routed to node_modules)', async () => {
    await expect(resolve('sliccy:', '/app', reader)).rejects.toThrow(/empty sliccy: module name/);
  });
});

describe('resolve() — relative & absolute paths', () => {
  it('resolves an exact relative file', async () => {
    const reader = makeReader({ '/app/local.js': 'x' });
    const r = await resolve('./local.js', '/app', reader);
    expect(r.type).toBe('file');
    if (r.type === 'file') expect(r.path).toBe('/app/local.js');
  });

  it('resolves an extensionless relative file via .js', async () => {
    const reader = makeReader({ '/app/local.js': 'x' });
    const r = await resolve('./local', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/local.js');
  });

  it('resolves .cjs when only the .cjs file exists', async () => {
    const reader = makeReader({ '/app/local.cjs': 'x' });
    const r = await resolve('./local', '/app', reader);
    if (r.type === 'file') {
      expect(r.path).toBe('/app/local.cjs');
      expect(r.moduleKind).toBe('cjs');
    }
  });

  it('resolves a .json file and detects the json kind', async () => {
    const reader = makeReader({ '/app/data.json': '{"answer":42}' });
    const r = await resolve('./data', '/app', reader);
    if (r.type === 'file') {
      expect(r.path).toBe('/app/data.json');
      expect(r.moduleKind).toBe('json');
    }
  });

  it('resolves a directory to its index.js', async () => {
    const reader = makeReader({ '/app/dir/index.js': 'x' });
    const r = await resolve('./dir', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/dir/index.js');
  });

  it('prefers a file over a same-named directory (file-over-directory)', async () => {
    const reader = makeReader({ '/app/x.js': 'file', '/app/x/index.js': 'dir' });
    const r = await resolve('./x', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/x.js');
  });

  it('resolves a parent-relative path', async () => {
    const reader = makeReader({ '/app/x.js': 'x' });
    const r = await resolve('../x.js', '/app/sub', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/x.js');
  });

  it('resolves a VFS-absolute path', async () => {
    const reader = makeReader({ '/workspace/dir/x.js': 'x' });
    const r = await resolve('/workspace/dir/x.js', '/elsewhere', reader);
    if (r.type === 'file') expect(r.path).toBe('/workspace/dir/x.js');
  });

  it('throws without the install hint for a missing relative path', async () => {
    const reader = makeReader({});
    await expect(resolve('./nope.js', '/app', reader)).rejects.toThrow(
      "Cannot find module './nope.js'"
    );
    await expect(resolve('./nope.js', '/app', reader)).rejects.not.toThrow(/ipk install/);
  });
});

describe('resolve() — bare packages', () => {
  it('resolves a package main entry', async () => {
    const reader = makeReader({
      '/app/node_modules/withmain/package.json': JSON.stringify({ main: 'lib/entry.js' }),
      '/app/node_modules/withmain/lib/entry.js': 'x',
      '/app/node_modules/withmain/index.js': 'decoy',
    });
    const r = await resolve('withmain', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/withmain/lib/entry.js');
  });

  it('falls back to index.js when no main/exports declared', async () => {
    const reader = makeReader({
      '/app/node_modules/noentry/package.json': JSON.stringify({ name: 'noentry' }),
      '/app/node_modules/noentry/index.js': 'x',
    });
    const r = await resolve('noentry', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/noentry/index.js');
  });

  it('honors exports require over import/default', async () => {
    const reader = makeReader({
      '/app/node_modules/dual/package.json': JSON.stringify({
        exports: { '.': { require: './cjs.js', import: './esm.js', default: './fallback.js' } },
      }),
      '/app/node_modules/dual/cjs.js': 'x',
      '/app/node_modules/dual/esm.js': 'x',
      '/app/node_modules/dual/fallback.js': 'x',
    });
    const r = await resolve('dual', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/dual/cjs.js');
  });

  it('falls back to the exports default condition', async () => {
    const reader = makeReader({
      '/app/node_modules/defonly/package.json': JSON.stringify({
        exports: { '.': { default: './d.js' } },
      }),
      '/app/node_modules/defonly/d.js': 'x',
    });
    const r = await resolve('defonly', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/defonly/d.js');
  });

  it('resolves an exports subpath map for a deep specifier', async () => {
    const reader = makeReader({
      '/app/node_modules/feat/package.json': JSON.stringify({
        exports: { './feature': { require: './feature-cjs.js' } },
      }),
      '/app/node_modules/feat/feature-cjs.js': 'x',
    });
    const r = await resolve('feat/feature', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/feat/feature-cjs.js');
  });

  it('resolves a deep subpath file directly (independent of main)', async () => {
    const reader = makeReader({
      '/app/node_modules/multi/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/multi/index.js': 'x',
      '/app/node_modules/multi/lib/greet.js': 'x',
    });
    const r = await resolve('multi/lib/greet.js', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/multi/lib/greet.js');
  });

  it('resolves a scoped package from its nested @scope directory', async () => {
    const reader = makeReader({
      '/app/node_modules/@acme/util/package.json': JSON.stringify({ main: 'main.js' }),
      '/app/node_modules/@acme/util/main.js': 'x',
    });
    const r = await resolve('@acme/util', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/@acme/util/main.js');
  });

  it('walks up to an ancestor node_modules', async () => {
    const reader = makeReader({
      '/app/node_modules/is-number/package.json': JSON.stringify({ main: 'index.js' }),
      '/app/node_modules/is-number/index.js': 'x',
    });
    const r = await resolve('is-number', '/app/a/b', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/is-number/index.js');
  });

  it('prefers the nearest copy over an ancestor copy', async () => {
    const reader = makeReader({
      '/app/node_modules/dep/package.json': JSON.stringify({ main: 'far.js' }),
      '/app/node_modules/dep/far.js': 'far',
      '/app/a/node_modules/dep/package.json': JSON.stringify({ main: 'near.js' }),
      '/app/a/node_modules/dep/near.js': 'near',
    });
    const r = await resolve('dep', '/app/a/b', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/a/node_modules/dep/near.js');
  });

  it('throws the exact install-hint error for an uninstalled bare package', async () => {
    const reader = makeReader({});
    await expect(resolve('not-installed', '/app', reader)).rejects.toThrow(
      "Cannot find module 'not-installed' (run: ipk install not-installed)"
    );
  });

  it('names the package (not the subpath) in the install hint', async () => {
    const reader = makeReader({});
    await expect(resolve('pkg/sub.js', '/app', reader)).rejects.toThrow(
      "Cannot find module 'pkg/sub.js' (run: ipk install pkg)"
    );
  });

  it('throws without the install hint when an installed package has a broken main', async () => {
    const reader = makeReader({
      '/app/node_modules/broken/package.json': JSON.stringify({ main: './nope.js' }),
    });
    const err = await resolve('broken', '/app', reader).catch((e) => e as Error);
    expect(err.message).toMatch(/missing/);
    expect(err.message).not.toMatch(/ipk install/);
  });

  it('throws a clear error for malformed package.json', async () => {
    const reader = makeReader({
      '/app/node_modules/bad/package.json': '{ not json',
    });
    await expect(resolve('bad', '/app', reader)).rejects.toThrow(/Invalid package.json/);
  });
});

describe('resolve() — package-dir self-referencing main/module', () => {
  it('resolves main "." to the package index.js without recursing', async () => {
    const reader = makeReader({
      '/app/node_modules/selfmain/package.json': JSON.stringify({ main: '.' }),
      '/app/node_modules/selfmain/index.js': 'x',
    });
    const r = await resolve('selfmain', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/selfmain/index.js');
  });

  it('resolves main "./" to the package index.js without recursing', async () => {
    const reader = makeReader({
      '/app/node_modules/slashmain/package.json': JSON.stringify({ main: './' }),
      '/app/node_modules/slashmain/index.js': 'x',
    });
    const r = await resolve('slashmain', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/slashmain/index.js');
  });

  it('honors index file-over-directory precedence (index.js before index/)', async () => {
    const reader = makeReader({
      '/app/node_modules/selfidx/package.json': JSON.stringify({ main: '.' }),
      '/app/node_modules/selfidx/index.js': 'file',
      '/app/node_modules/selfidx/index/inner.js': 'dir',
    });
    const r = await resolve('selfidx', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/selfidx/index.js');
  });

  it('resolves module "." (no main) to the package index.cjs', async () => {
    const reader = makeReader({
      '/app/node_modules/modself/package.json': JSON.stringify({ module: '.' }),
      '/app/node_modules/modself/index.cjs': 'x',
    });
    const r = await resolve('modself', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/modself/index.cjs');
  });

  it('throws "Cannot find module" (no hang) when main "." has no index.*', async () => {
    const reader = makeReader({
      '/app/node_modules/noidx/package.json': JSON.stringify({ main: '.' }),
    });
    const err = await resolve('noidx', '/app', reader).catch((e) => e as Error);
    expect(err.message).toBe("Cannot find module 'noidx'");
    expect(err.message).not.toMatch(/ipk install/);
  }, 3000);

  it('resolves a relative dir whose main "." points back to itself', async () => {
    const reader = makeReader({
      '/app/pkg/package.json': JSON.stringify({ main: '.' }),
      '/app/pkg/index.js': 'x',
    });
    const r = await resolve('./pkg', '/app', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/pkg/index.js');
  });

  it('throws (no hang) for a relative dir self-main with no index.*', async () => {
    const reader = makeReader({
      '/app/pkg/package.json': JSON.stringify({ main: './' }),
    });
    await expect(resolve('./pkg', '/app', reader)).rejects.toThrow("Cannot find module './pkg'");
  }, 3000);

  it('terminates (no hang) for a multi-directory normalization cycle', async () => {
    const reader = makeReader({
      '/app/node_modules/cyc/package.json': JSON.stringify({ main: './sub' }),
      '/app/node_modules/cyc/sub/package.json': JSON.stringify({ main: '../' }),
    });
    const err = await resolve('cyc', '/app', reader).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Cannot find module/);
  }, 3000);
});

describe('resolve() — package #imports', () => {
  it('resolves a plain-string #import through the nearest package scope', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#ansi-styles': './source/vendor/ansi-styles/index.js' },
        main: 'index.js',
      }),
      '/app/node_modules/pkg/index.js': "require('#ansi-styles');",
      '/app/node_modules/pkg/source/vendor/ansi-styles/index.js': 'module.exports = {};',
    });
    const r = await resolve('#ansi-styles', '/app/node_modules/pkg', reader);
    expect(r.type).toBe('file');
    if (r.type === 'file') {
      expect(r.path).toBe('/app/node_modules/pkg/source/vendor/ansi-styles/index.js');
    }
  });

  it('resolves a #import from a nested module dir by walking up to the package scope', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#ansi-styles': './source/vendor/ansi-styles/index.js' },
      }),
      '/app/node_modules/pkg/source/index.js': "require('#ansi-styles');",
      '/app/node_modules/pkg/source/vendor/ansi-styles/index.js': 'module.exports = {};',
    });
    const r = await resolve('#ansi-styles', '/app/node_modules/pkg/source', reader);
    if (r.type === 'file') {
      expect(r.path).toBe('/app/node_modules/pkg/source/vendor/ansi-styles/index.js');
    }
  });

  it('picks the browser/default variant of a conditions-object #import (drops node)', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: {
          '#supports-color': {
            node: './source/vendor/supports-color/index.js',
            default: './source/vendor/supports-color/browser.js',
          },
        },
      }),
      '/app/node_modules/pkg/source/vendor/supports-color/index.js': 'module.exports = "node";',
      '/app/node_modules/pkg/source/vendor/supports-color/browser.js':
        'module.exports = "browser";',
    });
    const r = await resolve('#supports-color', '/app/node_modules/pkg', reader);
    if (r.type === 'file') {
      expect(r.path).toBe('/app/node_modules/pkg/source/vendor/supports-color/browser.js');
    }
  });

  it('prefers an explicit browser condition over default for a #import', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: {
          '#env': { browser: './browser.js', node: './node.js', default: './default.js' },
        },
      }),
      '/app/node_modules/pkg/browser.js': 'module.exports = "browser";',
      '/app/node_modules/pkg/node.js': 'module.exports = "node";',
      '/app/node_modules/pkg/default.js': 'module.exports = "default";',
    });
    const r = await resolve('#env', '/app/node_modules/pkg', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/pkg/browser.js');
  });

  it('honors require vs import access kind inside #imports conditions', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#dual': { import: './esm.js', require: './cjs.js', default: './def.js' } },
      }),
      '/app/node_modules/pkg/esm.js': 'export default 1;',
      '/app/node_modules/pkg/cjs.js': 'module.exports = 1;',
      '/app/node_modules/pkg/def.js': 'module.exports = 1;',
    });
    const req = await resolve('#dual', '/app/node_modules/pkg', reader, {
      conditions: ['node', 'require', 'default'],
    });
    if (req.type === 'file') expect(req.path).toBe('/app/node_modules/pkg/cjs.js');
    const imp = await resolve('#dual', '/app/node_modules/pkg', reader, {
      conditions: ['node', 'import', 'default'],
    });
    if (imp.type === 'file') expect(imp.path).toBe('/app/node_modules/pkg/esm.js');
  });

  it('resolves a single-* pattern #import key', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#internal/*': './src/internal/*.js' },
      }),
      '/app/node_modules/pkg/src/internal/util.js': 'module.exports = {};',
    });
    const r = await resolve('#internal/util', '/app/node_modules/pkg', reader);
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/pkg/src/internal/util.js');
  });

  it('stops at the first enclosing package.json and does not escape into a parent package', async () => {
    const reader = makeReader({
      '/app/node_modules/parent/package.json': JSON.stringify({
        name: 'parent',
        imports: { '#shared': './parent-shared.js' },
      }),
      '/app/node_modules/parent/parent-shared.js': 'module.exports = "parent";',
      '/app/node_modules/parent/node_modules/child/package.json': JSON.stringify({
        name: 'child',
      }),
      '/app/node_modules/parent/node_modules/child/index.js': "require('#shared');",
    });
    // The child scope has no #shared, so resolution must NOT escape to parent's.
    await expect(
      resolve('#shared', '/app/node_modules/parent/node_modules/child', reader)
    ).rejects.toThrow("Cannot find module '#shared'");
  });

  it('throws without an ipk-install hint when a #import is not declared', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', imports: {} }),
      '/app/node_modules/pkg/index.js': 'x',
    });
    const err = await resolve('#missing', '/app/node_modules/pkg', reader).catch((e) => e as Error);
    expect(err.message).toBe("Cannot find module '#missing'");
    expect(err.message).not.toMatch(/ipk install/);
  });

  it('throws when there is no enclosing package scope', async () => {
    const reader = makeReader({ '/app/index.js': "require('#x');" });
    await expect(resolve('#x', '/app', reader)).rejects.toThrow("Cannot find module '#x'");
  });

  it('rejects a bare "#" specifier', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#': './a.js' },
      }),
      '/app/node_modules/pkg/a.js': 'x',
    });
    const err = await resolve('#', '/app/node_modules/pkg', reader).catch((e) => e as Error);
    expect(err.message).toBe("Cannot find module '#'");
    expect(err.message).not.toMatch(/ipk install/);
  });

  it('rejects a "#/"-prefixed specifier', async () => {
    const reader = makeReader({
      '/app/node_modules/pkg/package.json': JSON.stringify({
        name: 'pkg',
        imports: { '#/foo': './a.js' },
      }),
      '/app/node_modules/pkg/a.js': 'x',
    });
    const err = await resolve('#/foo', '/app/node_modules/pkg', reader).catch((e) => e as Error);
    expect(err.message).toBe("Cannot find module '#/foo'");
    expect(err.message).not.toMatch(/ipk install/);
  });
});

describe('resolve() — import-time conditions', () => {
  it('selects the import condition when conditions prioritize import', async () => {
    const reader = makeReader({
      '/app/node_modules/dual/package.json': JSON.stringify({
        exports: { '.': { require: './cjs.js', import: './esm.js' } },
      }),
      '/app/node_modules/dual/cjs.js': 'x',
      '/app/node_modules/dual/esm.js': 'x',
    });
    const r = await resolve('dual', '/app', reader, { conditions: ['node', 'import', 'default'] });
    if (r.type === 'file') expect(r.path).toBe('/app/node_modules/dual/esm.js');
  });
});

describe('detectModuleKind()', () => {
  it('detects esm via the .mjs extension regardless of package type', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ type: 'commonjs' }),
      '/app/node_modules/p/index.mjs': 'x',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.mjs')).toBe('esm');
  });

  it('detects esm for a .js entry under "type":"module"', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ type: 'module' }),
      '/app/node_modules/p/index.js': 'x',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.js')).toBe('esm');
  });

  it('defaults a .js entry with no package type to cjs', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ name: 'p' }),
      '/app/node_modules/p/index.js': 'x',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.js')).toBe('cjs');
  });

  it('keeps a .cjs entry cjs even under "type":"module"', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ type: 'module' }),
      '/app/node_modules/p/index.cjs': 'module.exports = 1;',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.cjs')).toBe('cjs');
  });

  it('treats an explicit "type":"commonjs" .js entry as cjs without syntax sniffing', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ type: 'commonjs' }),
      '/app/node_modules/p/index.js': 'export default 1;',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.js')).toBe('cjs');
  });

  it('detects esm by syntax for a no-type .js entry containing export statements', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ name: 'p' }),
      '/app/node_modules/p/index.js': "import dep from 'dep';\nexport default dep;",
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.js')).toBe('esm');
  });

  it('leaves a no-type .js entry that only uses module.exports as cjs', async () => {
    const reader = makeReader({
      '/app/node_modules/p/package.json': JSON.stringify({ name: 'p' }),
      '/app/node_modules/p/index.js': 'module.exports = function () { return 1; };',
    });
    expect(await detectModuleKind(reader, '/app/node_modules/p/index.js')).toBe('cjs');
  });

  it('detects esm by syntax for a .js entry with no package.json at all', async () => {
    const reader = makeReader({ '/work/script.js': 'export const x = 1;' });
    expect(await detectModuleKind(reader, '/work/script.js')).toBe('esm');
  });
});

describe('createVfsModuleReader()', () => {
  it('adapts a VirtualFS-like surface, decoding binary reads to text', async () => {
    const reader = createVfsModuleReader({
      exists: async (p) => p === '/app/index.js' || p === '/app',
      stat: async (p) => ({ type: p === '/app' ? 'directory' : 'file' }),
      readFile: async () => new TextEncoder().encode('module.exports = 1;'),
    });
    expect(await reader.exists('/app/index.js')).toBe(true);
    expect(await reader.isDirectory('/app')).toBe(true);
    expect(await reader.isDirectory('/app/index.js')).toBe(false);
    expect(await reader.readFile('/app/index.js')).toBe('module.exports = 1;');
  });

  it('reports isDirectory false when stat throws (missing path)', async () => {
    const reader = createVfsModuleReader({
      exists: async () => false,
      stat: async () => {
        throw new Error('ENOENT');
      },
      readFile: async () => '',
    });
    expect(await reader.isDirectory('/missing')).toBe(false);
  });
});
