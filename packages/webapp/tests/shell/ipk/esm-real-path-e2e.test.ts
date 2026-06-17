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
});
