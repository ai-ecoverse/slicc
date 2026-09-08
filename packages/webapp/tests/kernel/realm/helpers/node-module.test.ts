/**
 * Direct unit tests for the realm's partial `node:module` shim: filename
 * coercion, `isBuiltin`, `_nodeModulePaths`, and relative-path candidates.
 * End-to-end `require('module')` / `createRequire` coverage lives in
 * `cjs-require-bare-builtins.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  createNodeModule,
  filenameToPath,
  isBuiltinName,
  nodeModulePaths,
  pickBarePackage,
  pickExistingCandidate,
  resolveFileCandidates,
} from '../../../../src/kernel/realm/helpers/node-module.js';

describe('isBuiltinName', () => {
  it('accepts bare and node:-prefixed built-ins', () => {
    expect(isBuiltinName('fs')).toBe(true);
    expect(isBuiltinName('node:fs')).toBe(true);
    expect(isBuiltinName('module')).toBe(true);
  });

  it('rejects packages and non-strings', () => {
    expect(isBuiltinName('stylelint')).toBe(false);
    expect(isBuiltinName('node:stylelint')).toBe(false);
    expect(isBuiltinName(1)).toBe(false);
    expect(isBuiltinName(undefined)).toBe(false);
  });
});

describe('BUILTIN_MODULES', () => {
  it('lists unprefixed Node built-ins including module', () => {
    expect(BUILTIN_MODULES).toContain('fs');
    expect(BUILTIN_MODULES).toContain('module');
    expect(BUILTIN_MODULES).not.toContain('node:fs');
  });
});

describe('nodeModulePaths', () => {
  it('walks POSIX ancestors', () => {
    expect(nodeModulePaths('/workspace/pkg/lib')).toEqual([
      '/workspace/pkg/lib/node_modules',
      '/workspace/pkg/node_modules',
      '/workspace/node_modules',
      '/node_modules',
    ]);
  });

  it('skips a directory that is itself named node_modules', () => {
    expect(nodeModulePaths('/workspace/node_modules/pkg')).toEqual([
      '/workspace/node_modules/pkg/node_modules',
      '/workspace/node_modules',
      '/node_modules',
    ]);
  });

  it('handles the filesystem root', () => {
    expect(nodeModulePaths('/')).toEqual(['/node_modules']);
  });
});

describe('filenameToPath', () => {
  it('accepts absolute paths, file: strings, and URL objects', () => {
    expect(filenameToPath('/workspace/a.js')).toBe('/workspace/a.js');
    expect(filenameToPath('file:///workspace/a.js')).toBe('/workspace/a.js');
    expect(filenameToPath(new URL('file:///workspace/hello%20world.js'))).toBe(
      '/workspace/hello world.js'
    );
  });

  it('rejects relative paths and non-file URLs', () => {
    expect(() => filenameToPath('relative.js')).toThrow(/absolute path string/);
    expect(() => filenameToPath(new URL('https://example.com/x.js'))).toThrow(/not a file URL/);
  });
});

describe('resolveFileCandidates / pickExistingCandidate', () => {
  it('probes extensions for extension-less specifiers', () => {
    expect(resolveFileCandidates('/workspace/pkg', './helper')).toEqual([
      '/workspace/pkg/helper',
      '/workspace/pkg/helper.js',
      '/workspace/pkg/helper.json',
      '/workspace/pkg/helper.cjs',
      '/workspace/pkg/helper/index.js',
      '/workspace/pkg/helper/index.json',
    ]);
  });

  it('does not re-probe an already-extended specifier', () => {
    expect(resolveFileCandidates('/workspace/pkg', './helper.js')).toEqual([
      '/workspace/pkg/helper.js',
    ]);
  });

  it('picks the first candidate that exists', () => {
    const files = new Set(['/workspace/pkg/helper.js']);
    expect(pickExistingCandidate('/workspace/pkg', './helper', (p) => files.has(p))).toBe(
      '/workspace/pkg/helper.js'
    );
    expect(
      pickExistingCandidate('/workspace/pkg', './missing', (p) => files.has(p))
    ).toBeUndefined();
  });
});

describe('pickBarePackage', () => {
  it('walks nearest node_modules and prefers the closer copy', () => {
    const files = new Set([
      '/workspace/node_modules/foo/index.js',
      '/workspace/a/node_modules/foo/index.js',
    ]);
    expect(pickBarePackage('/workspace/a/lib', 'foo', (p) => files.has(p))).toBe(
      '/workspace/a/node_modules/foo/index.js'
    );
    expect(pickBarePackage('/workspace/other', 'foo', (p) => files.has(p))).toBe(
      '/workspace/node_modules/foo/index.js'
    );
  });

  it('resolves a scoped package and a deep subpath', () => {
    const files = new Set(['/workspace/node_modules/@scope/pkg/lib/main.js']);
    expect(pickBarePackage('/workspace', '@scope/pkg/lib/main.js', (p) => files.has(p))).toBe(
      '/workspace/node_modules/@scope/pkg/lib/main.js'
    );
  });

  it('returns undefined when the package is not in the graph', () => {
    expect(pickBarePackage('/workspace', 'missing', () => false)).toBeUndefined();
  });
});

describe('createNodeModule', () => {
  it('exposes createRequire, builtinModules, isBuiltin, and no findPnpApi', () => {
    const loaded: string[] = [];
    const api = createNodeModule({
      requireFrom: (fromPath, specifier) => {
        loaded.push(`${fromPath}::${specifier}`);
        return { fromPath, specifier };
      },
      resolveFrom: (fromPath, specifier) => `${fromPath}=>${specifier}`,
    });
    expect(api.createRequire).toBeTypeOf('function');
    expect(api.builtinModules).toContain('fs');
    expect(api.isBuiltin('fs')).toBe(true);
    expect(api.isBuiltin('stylelint')).toBe(false);
    expect((api as { findPnpApi?: unknown }).findPnpApi).toBeUndefined();
    expect('findPnpApi' in api).toBe(false);
    expect(api.Module).toBe(api);

    const req = api.createRequire('/workspace/pkg/index.js');
    expect(req('./helper.js')).toEqual({
      fromPath: '/workspace/pkg/index.js',
      specifier: './helper.js',
    });
    expect(req.resolve('./helper.js')).toBe('/workspace/pkg/index.js=>./helper.js');
    expect(req.resolve('foo', { paths: ['/workspace/other'] })).toBe(
      '/workspace/other/noop.js=>foo'
    );
    expect(loaded).toEqual(['/workspace/pkg/index.js::./helper.js']);
  });
});
