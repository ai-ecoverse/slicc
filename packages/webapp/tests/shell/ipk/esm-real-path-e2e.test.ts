/**
 * Real-path ESM e2e (esm-parity-and-real-e2e, M5): drive a real AlmostBashShell
 * over a fake-indexeddb VFS with a mocked `createProxiedFetch` serving
 * synthesized `.tgz` fixtures shaped like the contract's real registry packages
 * (`nanoid` ESM-only, `uuid` dual CJS/ESM, `escape-string-regexp` ESM-only,
 * `is-number` CJS). This exercises the FULL real path — `ipk install` +
 * gunzip/untar + host-side ESM->CJS transpile + the uniform CJS graph the realm
 * evaluates — programmatically (the `[REAL REGISTRY]` network round-trip is
 * confirmed separately by the browser validator).
 *
 *  - VAL-ESM-016: install + import an ESM-only package (`nanoid`) via dynamic +
 *    static import, and a dual package (`uuid`) resolving the require condition
 *    for `require` and the import condition for `import`.
 *  - VAL-CROSS-003: install an ESM-only package (`escape-string-regexp`), then a
 *    dynamic `import().then` and a static-import script file both transpile and
 *    resolve from node_modules.
 *  - VAL-CROSS-004: a CJS `require` and an ESM `import` coexist with correct
 *    interop in a SINGLE realm evaluation.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function writeString(view: Uint8Array, offset: number, len: number, value: string): void {
  for (let i = 0; i < len; i++) view[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
}
function writeOctal(view: Uint8Array, offset: number, len: number, value: number): void {
  writeString(view, offset, len - 1, value.toString(8).padStart(len - 1, '0'));
  view[offset + len - 1] = 0;
}
function buildHeader(name: string, dataLen: number): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, dataLen);
  writeOctal(header, 136, 12, 0);
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  writeString(header, 148, 6, sum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}
function buildTar(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    chunks.push(buildHeader(e.name, e.data.length));
    chunks.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

interface SyntheticPackage {
  name: string;
  version: string;
  files: Record<string, string>;
}
function buildTarball(pkg: SyntheticPackage): Uint8Array {
  return gzipSync(
    buildTar(
      Object.entries(pkg.files).map(([path, content]) => ({
        name: `package/${path}`,
        data: bytes(content),
      }))
    )
  );
}
function tarballBasename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${base}-${version}.tgz`;
}

interface Registry {
  packuments: Record<string, unknown>;
  tarballs: Record<string, Uint8Array>;
}
function buildRegistry(packages: SyntheticPackage[]): Registry {
  const packuments: Record<string, unknown> = {};
  const tarballs: Record<string, Uint8Array> = {};
  for (const p of packages) {
    const url = `https://registry.npmjs.org/${p.name}/-/${tarballBasename(p.name, p.version)}`;
    tarballs[url] = buildTarball(p);
    const manifest = JSON.parse(p.files['package.json']) as Record<string, unknown>;
    packuments[p.name] = {
      name: p.name,
      'dist-tags': { latest: p.version },
      versions: {
        [p.version]: { ...manifest, name: p.name, version: p.version, dist: { tarball: url } },
      },
    };
  }
  return { packuments, tarballs };
}

const sharedRegistry: { current: Registry } = { current: { packuments: {}, tarballs: {} } };

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    const reg = sharedRegistry.current;
    if (reg.tarballs[url]) {
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/octet-stream' },
        body: reg.tarballs[url],
        url,
      };
    }
    for (const name of Object.keys(reg.packuments)) {
      if (url.endsWith(`/${name}`)) {
        return {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: bytes(JSON.stringify(reg.packuments[name])),
          url,
        };
      }
    }
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes('not found'), url };
  }) as unknown as SecureFetch;
  return { ...actual, createProxiedFetch: () => mockFetch };
});

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({ dbName: `test-esm-real-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

// --- Fixtures shaped like the real registry packages the contract names ----

/** ESM-only, named exports (`nanoid`, `customAlphabet`), no default — like real nanoid. */
const nanoidPkg: SyntheticPackage = {
  name: 'nanoid',
  version: '5.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'nanoid',
      version: '5.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'index.js': [
      'const ALPHABET = "useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";',
      'export function nanoid(size = 21) {',
      '  let id = "";',
      '  for (let i = 0; i < size; i++) id += ALPHABET[(i * 7 + 3) % ALPHABET.length];',
      '  return id;',
      '}',
      'export function customAlphabet(alphabet, size = 21) {',
      '  return () => {',
      '    let id = "";',
      '    for (let i = 0; i < size; i++) id += alphabet[i % alphabet.length];',
      '    return id;',
      '  };',
      '}',
    ].join('\n'),
  },
};

/** Dual CJS/ESM via `exports` conditions, both exposing `v4` — like real uuid. */
const uuidV4Body = [
  'function v4() {',
  '  const hex = "0123456789abcdef";',
  '  const pattern = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";',
  '  let out = "";',
  '  for (const ch of pattern) {',
  '    out += ch === "-" ? "-" : hex[Math.floor(Math.random() * 16)];',
  '  }',
  '  return out;',
  '}',
].join('\n');
const uuidPkg: SyntheticPackage = {
  name: 'uuid',
  version: '9.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'uuid',
      version: '9.0.0',
      exports: { '.': { import: './esm.js', require: './cjs.js' } },
    }),
    'esm.js': [uuidV4Body, 'export { v4 };', 'export default { v4 };'].join('\n'),
    'cjs.js': [uuidV4Body, 'module.exports = { v4 };'].join('\n'),
  },
};

/** ESM-only with a default export — the real escape-string-regexp source. */
const escapeStringRegexpPkg: SyntheticPackage = {
  name: 'escape-string-regexp',
  version: '5.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'escape-string-regexp',
      version: '5.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'index.js': String.raw`export default function escapeStringRegexp(string) {
  return string.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d');
}`,
  },
};

/** No-dep CJS callable — like real is-number. */
const isNumberPkg: SyntheticPackage = {
  name: 'is-number',
  version: '7.0.0',
  files: {
    'package.json': JSON.stringify({ name: 'is-number', version: '7.0.0', main: 'index.js' }),
    'index.js':
      'module.exports = function isNumber(n) { return typeof n === "number" && n - n === 0; };\n',
  },
};

/**
 * ESM-only, named `randomFillSync` import from `node:crypto` — mirrors the real
 * nanoid@5 node entry, which fails without the Web Crypto-backed crypto bridge.
 */
const cryptoNanoidPkg: SyntheticPackage = {
  name: 'crypto-nanoid',
  version: '5.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'crypto-nanoid',
      version: '5.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'index.js': [
      "import { randomFillSync } from 'node:crypto';",
      "const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';",
      'export function nanoid(size = 21) {',
      '  const bytes = new Uint8Array(size);',
      '  randomFillSync(bytes);',
      '  let id = "";',
      '  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63];',
      '  return id;',
      '}',
    ].join('\n'),
  },
};

/**
 * Dual CJS/ESM via `exports` conditions, both calling `crypto.randomUUID()` —
 * mirrors the real uuid@9 native path (default `import crypto from 'crypto'`
 * in ESM, `require('crypto')` in CJS).
 */
const cryptoUuidPkg: SyntheticPackage = {
  name: 'crypto-uuid',
  version: '9.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'crypto-uuid',
      version: '9.0.0',
      exports: { '.': { import: './esm.js', require: './cjs.js' } },
    }),
    'esm.js': [
      "import crypto from 'crypto';",
      'export function v4() { return crypto.randomUUID(); }',
      'export default { v4 };',
    ].join('\n'),
    'cjs.js': [
      "const crypto = require('crypto');",
      'function v4() { return crypto.randomUUID(); }',
      'module.exports = { v4 };',
    ].join('\n'),
  },
};

/**
 * Minimal `imports` (`#`-specifier) shape: a plain-string `#x` and a
 * conditions-object `#y` whose `node` variant top-level-imports a
 * browser-unavailable built-in. The browser/default variant must be picked so
 * the graph builds without touching node:os.
 */
const importsShapePkg: SyntheticPackage = {
  name: 'imports-shape',
  version: '1.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'imports-shape',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
      imports: { '#x': './a.js', '#y': { node: './n.js', default: './b.js' } },
    }),
    'index.js': ["import x from '#x';", "import y from '#y';", 'export default { x, y };'].join(
      '\n'
    ),
    'a.js': 'export default "a-resolved";',
    'n.js': ["import os from 'node:os';", 'export default os.platform();'].join('\n'),
    'b.js': 'export default "b-browser";',
  },
};

/**
 * chalk@5-shaped: ESM, a string `#ansi-styles` import and a conditions-object
 * `#supports-color` whose node variant pulls in `node:os`/`node:tty` (both
 * browser-unavailable). The browser/default variant must be selected so the
 * graph builds and chalk runs.
 */
const chalkPkg: SyntheticPackage = {
  name: 'chalk',
  version: '5.3.0',
  files: {
    'package.json': JSON.stringify({
      name: 'chalk',
      version: '5.3.0',
      type: 'module',
      main: './source/index.js',
      exports: { '.': './source/index.js' },
      imports: {
        '#ansi-styles': './source/vendor/ansi-styles/index.js',
        '#supports-color': {
          node: './source/vendor/supports-color/index.js',
          default: './source/vendor/supports-color/browser.js',
        },
      },
    }),
    'source/index.js': [
      "import ansiStyles from '#ansi-styles';",
      "import supportsColor from '#supports-color';",
      'const chalk = (s) => `${ansiStyles.open}${s}${ansiStyles.close}`;',
      'chalk.level = supportsColor ? supportsColor.level : 0;',
      'export default chalk;',
    ].join('\n'),
    'source/vendor/ansi-styles/index.js':
      "export default { open: '\\u001b[31m', close: '\\u001b[39m' };",
    'source/vendor/supports-color/index.js': [
      "import os from 'node:os';",
      "import tty from 'node:tty';",
      'export default { level: tty.isatty(1) ? 1 : 0, platform: os.platform() };',
    ].join('\n'),
    'source/vendor/supports-color/browser.js':
      'export default { level: globalThis.navigator ? 1 : 0 };',
  },
};

/**
 * Faithful uuid@9-shaped fixture modeling the real wrapper->Babel-CJS
 * indirection that the synthetic `uuidPkg` above did NOT capture: the
 * `node.import` entry is `wrapper.mjs` doing `import uuid from './dist/index.js'`,
 * and `dist/index.js` is a Babel-compiled CJS module that sets `__esModule:true`
 * via `Object.defineProperty` and exposes named getters (v1/v4) but has NO own
 * `default` property. Real Node binds `import def from 'cjs'` to the WHOLE
 * `module.exports` regardless of `__esModule`; the realm require shim must
 * synthesize that default so `uuid.v4` is callable.
 */
const realUuidV4Body = [
  'function v4() {',
  '  const hex = "0123456789abcdef";',
  '  const pattern = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";',
  '  let out = "";',
  '  for (const ch of pattern) {',
  '    out += ch === "-" ? "-" : hex[Math.floor(Math.random() * 16)];',
  '  }',
  '  return out;',
  '}',
].join('\n');
const realUuidPkg: SyntheticPackage = {
  name: 'uuid',
  version: '9.0.1',
  files: {
    'package.json': JSON.stringify({
      name: 'uuid',
      version: '9.0.1',
      exports: {
        '.': { node: { import: './wrapper.mjs', require: './dist/index.js' } },
      },
    }),
    'wrapper.mjs': [
      "import uuid from './dist/index.js';",
      'export const v1 = uuid.v1;',
      'export const v4 = uuid.v4;',
      'export default uuid;',
    ].join('\n'),
    'dist/index.js': [
      '"use strict";',
      'Object.defineProperty(exports, "__esModule", { value: true });',
      'Object.defineProperty(exports, "v1", { enumerable: true, get: function () { return v1; } });',
      'Object.defineProperty(exports, "v4", { enumerable: true, get: function () { return v4; } });',
      'function v1() {',
      '  const hex = "0123456789abcdef";',
      '  let out = "";',
      '  for (let i = 0; i < 36; i++) {',
      '    out += i === 8 || i === 13 || i === 18 || i === 23 ? "-" : hex[Math.floor(Math.random() * 16)];',
      '  }',
      '  return out;',
      '}',
      realUuidV4Body,
    ].join('\n'),
  },
};

describe('Real-path ESM e2e: ipk install → import over the production realm seam', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
  });

  it('VAL-ESM-016: install + dynamic and static import of an ESM-only package (nanoid)', async () => {
    sharedRegistry.current = buildRegistry([nanoidPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install nanoid')).exitCode).toBe(0);

    // Dynamic import resolves to a namespace exposing the named function.
    await fs.writeFile('/work/dyn.js', "import('nanoid').then(m => console.log(typeof m.nanoid));");
    const dyn = await shell.executeCommand('node dyn.js');
    expect(dyn.stderr).not.toContain('Cannot find module');
    expect(dyn.exitCode).toBe(0);
    expect(dyn.stdout.trim()).toBe('function');

    // Static named import in a .jsh script generates a non-empty id.
    await fs.writeFile(
      '/work/use.jsh',
      "import { nanoid } from 'nanoid';\nconsole.log(nanoid().length > 0);"
    );
    const stat = await shell.executeCommand('node use.jsh');
    expect(stat.stderr).not.toContain('Cannot find module');
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout.trim()).toBe('true');
    await fs.dispose();
  });

  it('VAL-ESM-016: a dual package (uuid) resolves require-condition for require and import-condition for import', async () => {
    sharedRegistry.current = buildRegistry([uuidPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install uuid')).exitCode).toBe(0);

    // require -> the `require` condition (cjs.js) -> v4 matches the uuid shape.
    await fs.writeFile(
      '/work/req.js',
      'console.log(/^[0-9a-f-]{36}$/.test(require("uuid").v4()));'
    );
    const req = await shell.executeCommand('node req.js');
    expect(req.stderr).not.toContain('Cannot find module');
    expect(req.exitCode).toBe(0);
    expect(req.stdout.trim()).toBe('true');

    // import -> the `import` condition (esm.js) -> v4 matches the uuid shape.
    await fs.writeFile(
      '/work/imp.jsh',
      "import { v4 } from 'uuid';\nconsole.log(/^[0-9a-f-]{36}$/.test(v4()));"
    );
    const imp = await shell.executeCommand('node imp.jsh');
    expect(imp.stderr).not.toContain('Cannot find module');
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout.trim()).toBe('true');
    await fs.dispose();
  });

  it('VAL-CROSS-003: install an ESM-only package, then dynamic + static-import-script both work', async () => {
    sharedRegistry.current = buildRegistry([escapeStringRegexpPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install escape-string-regexp')).exitCode).toBe(0);

    // Dynamic import of the default export.
    await fs.writeFile(
      '/work/dyn.js',
      "import('escape-string-regexp').then(m => console.log(m.default('a.b*c')));"
    );
    const dyn = await shell.executeCommand('node dyn.js');
    expect(dyn.stderr).not.toContain('Cannot find module');
    expect(dyn.exitCode).toBe(0);
    expect(dyn.stdout.trim()).toBe('a\\.b\\*c');

    // Static-import script file run via `node /work/esm.mjs`.
    await fs.writeFile(
      '/work/esm.mjs',
      "import esc from 'escape-string-regexp';\nconsole.log(esc('1+1=2'));"
    );
    const stat = await shell.executeCommand('node /work/esm.mjs');
    expect(stat.stderr).not.toContain('Cannot find module');
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout.trim()).toBe('1\\+1=2');
    await fs.dispose();
  });

  it('VAL-CROSS-004: a CJS require and an ESM import coexist with correct interop in one realm evaluation', async () => {
    sharedRegistry.current = buildRegistry([isNumberPkg, escapeStringRegexpPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);
    expect((await shell.executeCommand('ipk install escape-string-regexp')).exitCode).toBe(0);

    await fs.writeFile(
      '/work/mix.js',
      "const n = require('is-number'); import('escape-string-regexp').then(e => console.log(n(5), e.default('a*')));"
    );
    const mix = await shell.executeCommand('node mix.js');
    expect(mix.stderr).not.toContain('Cannot find module');
    expect(mix.exitCode).toBe(0);
    expect(mix.stdout.trim()).toBe('true a\\*');
    await fs.dispose();
  });

  it('VAL-ESM-016 (crypto regression): an ESM-only package importing randomFillSync from node:crypto produces a non-empty id', async () => {
    sharedRegistry.current = buildRegistry([cryptoNanoidPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install crypto-nanoid')).exitCode).toBe(0);

    // Dynamic import: the node:crypto-backed bridge fills the buffer.
    await fs.writeFile(
      '/work/dyn.js',
      "import('crypto-nanoid').then(m => console.log(typeof m.nanoid, m.nanoid().length));"
    );
    const dyn = await shell.executeCommand('node dyn.js');
    expect(dyn.stderr).not.toContain('Cannot find module');
    expect(dyn.stderr).not.toContain('not available in the browser');
    expect(dyn.exitCode).toBe(0);
    expect(dyn.stdout.trim()).toBe('function 21');

    // Static named import in a .jsh script generates a non-empty id.
    await fs.writeFile(
      '/work/use.jsh',
      "import { nanoid } from 'crypto-nanoid';\nconsole.log(nanoid().length > 0);"
    );
    const stat = await shell.executeCommand('node use.jsh');
    expect(stat.stderr).not.toContain('Cannot find module');
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout.trim()).toBe('true');
    await fs.dispose();
  });

  it('VAL-ESM-002 (package #imports): a plain-string #x resolves and a conditions-object #y picks the browser/default variant', async () => {
    sharedRegistry.current = buildRegistry([importsShapePkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install imports-shape')).exitCode).toBe(0);

    await fs.writeFile('/work/use.jsh', "import m from 'imports-shape';\nconsole.log(m.x, m.y);");
    const out = await shell.executeCommand('node use.jsh');
    expect(out.stderr).not.toContain('Cannot find module');
    expect(out.stderr).not.toContain('not available in the browser');
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('a-resolved b-browser');
    await fs.dispose();
  });

  it('VAL-ESM-001/002/008 (chalk #imports): import + require resolve #ansi-styles and the browser #supports-color variant without an unavailable-builtin error', async () => {
    sharedRegistry.current = buildRegistry([chalkPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install chalk')).exitCode).toBe(0);

    // Static import: chalk default is a function; #supports-color resolved its
    // browser variant, so node:os/node:tty are never pulled into the graph.
    await fs.writeFile(
      '/work/imp.jsh',
      "import chalk from 'chalk';\nconsole.log(typeof chalk, typeof chalk.level);"
    );
    const imp = await shell.executeCommand('node imp.jsh');
    expect(imp.stderr).not.toContain('Cannot find module');
    expect(imp.stderr).not.toContain('not available in the browser');
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout.trim()).toBe('function number');

    // require(): synchronous, default-interop exposes the chalk function.
    await fs.writeFile(
      '/work/req.js',
      "const m = require('chalk'); console.log(typeof (m.default ?? m));"
    );
    const req = await shell.executeCommand('node req.js');
    expect(req.stderr).not.toContain('Cannot find module');
    expect(req.stderr).not.toContain('not available in the browser');
    expect(req.exitCode).toBe(0);
    expect(req.stdout.trim()).toBe('function');
    await fs.dispose();
  });

  it('VAL-ESM-016 (crypto regression): a dual package calling crypto.randomUUID resolves v4 via require and import conditions', async () => {
    sharedRegistry.current = buildRegistry([cryptoUuidPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install crypto-uuid')).exitCode).toBe(0);

    // require -> the `require` condition (cjs.js) -> crypto.randomUUID() v4.
    await fs.writeFile(
      '/work/req.js',
      'console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(require("crypto-uuid").v4()));'
    );
    const req = await shell.executeCommand('node req.js');
    expect(req.stderr).not.toContain('Cannot find module');
    expect(req.stderr).not.toContain('not available in the browser');
    expect(req.exitCode).toBe(0);
    expect(req.stdout.trim()).toBe('true');

    // import -> the `import` condition (esm.js) -> crypto.randomUUID() v4.
    await fs.writeFile(
      '/work/imp.jsh',
      "import { v4 } from 'crypto-uuid';\nconsole.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v4()));"
    );
    const imp = await shell.executeCommand('node imp.jsh');
    expect(imp.stderr).not.toContain('Cannot find module');
    expect(imp.stderr).not.toContain('not available in the browser');
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout.trim()).toBe('true');
    await fs.dispose();
  });

  it('VAL-ESM-002 (real uuid@9 wrapper->Babel-CJS): named, default, dynamic import, and require all resolve', async () => {
    sharedRegistry.current = buildRegistry([realUuidPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install uuid')).exitCode).toBe(0);

    const uuidRe = '/^[0-9a-f-]{36}$/';

    // Named import via wrapper.mjs (node.import) -> uuid.v4 binding works only
    // when the realm synthesizes the missing `default` on the Babel-CJS module.
    await fs.writeFile(
      '/work/named.jsh',
      `import { v4 } from 'uuid';\nconsole.log(${uuidRe}.test(v4()));`
    );
    const named = await shell.executeCommand('node named.jsh');
    expect(named.stderr).not.toContain('Cannot find module');
    expect(named.stderr).not.toContain('Cannot read properties of undefined');
    expect(named.exitCode).toBe(0);
    expect(named.stdout.trim()).toBe('true');

    // Default import -> the whole module.exports (def.v4 callable).
    await fs.writeFile(
      '/work/def.jsh',
      `import def from 'uuid';\nconsole.log(${uuidRe}.test(def.v4()));`
    );
    const def = await shell.executeCommand('node def.jsh');
    expect(def.stderr).not.toContain('Cannot read properties of undefined');
    expect(def.exitCode).toBe(0);
    expect(def.stdout.trim()).toBe('true');

    // Dynamic import -> namespace exposes both named and default bindings.
    await fs.writeFile(
      '/work/dyn.js',
      `import('uuid').then(m => console.log(${uuidRe}.test(m.v4()), ${uuidRe}.test(m.default.v4())));`
    );
    const dyn = await shell.executeCommand('node dyn.js');
    expect(dyn.stderr).not.toContain('Cannot read properties of undefined');
    expect(dyn.exitCode).toBe(0);
    expect(dyn.stdout.trim()).toBe('true true');

    // require -> the `require` condition (dist/index.js) -> v4 callable.
    await fs.writeFile('/work/req.js', `console.log(${uuidRe}.test(require('uuid').v4()));`);
    const req = await shell.executeCommand('node req.js');
    expect(req.stderr).not.toContain('Cannot find module');
    expect(req.exitCode).toBe(0);
    expect(req.stdout.trim()).toBe('true');
    await fs.dispose();
  });
});
