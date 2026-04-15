import { describe, it, expect } from 'vitest';
import { buildImportMap } from '../../src/shell/esm-import-map.js';

describe('buildImportMap', () => {
  it('maps Node built-ins to shim URLs', () => {
    const map = buildImportMap(['fs', 'process', 'buffer']);
    expect(map.imports['fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['node:fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['process']).toBe('/preview/__shims/process.js');
    expect(map.imports['node:process']).toBe('/preview/__shims/process.js');
    expect(map.imports['buffer']).toBe('/preview/__shims/buffer.js');
    expect(map.imports['node:buffer']).toBe('/preview/__shims/buffer.js');
  });

  it('maps unavailable builtins to error shim URLs', () => {
    const map = buildImportMap(['http', 'crypto']);
    expect(map.imports['http']).toBe('/preview/__shims/http.js');
    expect(map.imports['node:http']).toBe('/preview/__shims/http.js');
    expect(map.imports['crypto']).toBe('/preview/__shims/crypto.js');
  });

  it('maps npm packages to esm.sh', () => {
    const map = buildImportMap(['chalk', 'lodash']);
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
    expect(map.imports['lodash']).toBe('https://esm.sh/lodash');
  });

  it('maps scoped npm packages to esm.sh', () => {
    const map = buildImportMap(['@adobe/aio-sdk']);
    expect(map.imports['@adobe/aio-sdk']).toBe('https://esm.sh/@adobe/aio-sdk');
  });

  it('maps path to esm.sh/path-browserify', () => {
    const map = buildImportMap(['path']);
    expect(map.imports['path']).toBe('https://esm.sh/path-browserify');
    expect(map.imports['node:path']).toBe('https://esm.sh/path-browserify');
  });

  it('skips relative specifiers', () => {
    const map = buildImportMap(['./helpers.js', '../utils.js', 'chalk']);
    expect(map.imports['./helpers.js']).toBeUndefined();
    expect(map.imports['../utils.js']).toBeUndefined();
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
  });

  it('handles mixed specifiers', () => {
    const map = buildImportMap(['fs', 'chalk', './local.js', 'http']);
    expect(map.imports['fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['chalk']).toBe('https://esm.sh/chalk');
    expect(map.imports['./local.js']).toBeUndefined();
    expect(map.imports['http']).toBe('/preview/__shims/http.js');
  });

  it('returns empty imports for empty specifiers', () => {
    const map = buildImportMap([]);
    expect(Object.keys(map.imports)).toHaveLength(0);
  });

  it('handles node: prefixed specifiers that are also bare', () => {
    const map = buildImportMap(['node:fs']);
    expect(map.imports['fs']).toBe('/preview/__shims/fs.js');
    expect(map.imports['node:fs']).toBe('/preview/__shims/fs.js');
  });
});
