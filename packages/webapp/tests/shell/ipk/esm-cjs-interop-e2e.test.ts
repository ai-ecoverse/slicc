/**
 * Real-shell e2e for CJS<->ESM interop (esm-cjs-interop, M5): `ipk install`
 * synthesized ESM / CJS fixture tarballs over a real AlmostBashShell +
 * fake-indexeddb VFS, then drive `node` / `node <script>` through the
 * production realm seam (host transpile + uniform CJS graph). Proves the
 * interop both directions and the dynamic-import-of-CJS case end-to-end:
 *  - VAL-ESM-007: CJS require() of an ESM package -> namespace with
 *    default + named + __esModule, no double-wrap.
 *  - VAL-ESM-008: ESM import of a CJS package binds module.exports as
 *    default + named; require() of an ESM package returns synchronously.
 *  - VAL-ESM-018: dynamic import() of a CJS package exposes module.exports on
 *    .default (and named where present), no double-wrap.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** just-bash does not re-export SecureFetchOptions from its root entry. */
type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

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
  /** Full file set (package.json + entry source) for the package. */
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
  const fs = await VirtualFS.create({ dbName: `test-esm-interop-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

/** ESM package with two named bindings and a default export. */
const esmNsPkg: SyntheticPackage = {
  name: 'esm-ns',
  version: '1.0.0',
  files: {
    'package.json': JSON.stringify({
      name: 'esm-ns',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    }),
    'index.js': [
      "export function greet() { return 'hi'; }",
      'export const value = 42;',
      "export default function def() { return 'def'; }",
    ].join('\n'),
  },
};

/** CJS package whose module.exports is a plain object of named functions. */
const cjsLodashPkg: SyntheticPackage = {
  name: 'cjs-lodash',
  version: '1.0.0',
  files: {
    'package.json': JSON.stringify({ name: 'cjs-lodash', version: '1.0.0', main: 'index.js' }),
    'index.js': 'module.exports = { merge: () => "merged", map: () => "mapped" };\n',
  },
};

/** CJS package whose module.exports is a callable with a named property. */
const cjsNumberPkg: SyntheticPackage = {
  name: 'num-pkg',
  version: '1.0.0',
  files: {
    'package.json': JSON.stringify({ name: 'num-pkg', version: '1.0.0', main: 'index.js' }),
    'index.js': [
      'function isNumber(n) { return typeof n === "number"; }',
      "isNumber.tag = 'num-named';",
      'module.exports = isNumber;',
    ].join('\n'),
  },
};

describe('CJS<->ESM interop e2e: ipk install → node require/import over the real shell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
  });

  it('VAL-ESM-007: CJS require() of an installed ESM package yields a namespace (default+named+__esModule)', async () => {
    sharedRegistry.current = buildRegistry([esmNsPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install esm-ns')).exitCode).toBe(0);

    await fs.writeFile(
      '/work/run.js',
      "const m = require('esm-ns'); console.log(m.__esModule === true, typeof m.greet, typeof m.default, m.default(), m.greet(), m.value);"
    );
    const run = await shell.executeCommand('node run.js');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('true function function def hi 42');
    await fs.dispose();
  });

  it('VAL-ESM-008: ESM import of a CJS package binds module.exports (default+named); require of ESM is synchronous', async () => {
    sharedRegistry.current = buildRegistry([cjsLodashPkg, esmNsPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install cjs-lodash')).exitCode).toBe(0);
    expect((await shell.executeCommand('ipk install esm-ns')).exitCode).toBe(0);

    // ESM import of a CJS module: default binds the whole exports; named resolves.
    await fs.writeFile(
      '/work/imp.js',
      "import _, { merge } from 'cjs-lodash'; console.log(typeof _.merge, typeof _.map, merge());"
    );
    const imp = await shell.executeCommand('node imp.js');
    expect(imp.stderr).not.toContain('Cannot find module');
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout.trim()).toBe('function function merged');

    // require() of an ESM package returns synchronously (not a Promise).
    await fs.writeFile(
      '/work/req.js',
      "const m = require('esm-ns'); console.log(typeof (m.default ?? m), m instanceof Promise);"
    );
    const req = await shell.executeCommand('node req.js');
    expect(req.exitCode).toBe(0);
    expect(req.stdout.trim()).toBe('function false');
    await fs.dispose();
  });

  it('VAL-ESM-018: dynamic import() of an installed CJS package exposes module.exports on .default (and named)', async () => {
    sharedRegistry.current = buildRegistry([cjsNumberPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install num-pkg')).exitCode).toBe(0);

    await fs.writeFile(
      '/work/dyn.js',
      "import('num-pkg').then(m => console.log(typeof m.default, m.default(9), m.default('x'), 'tag' in m, m.tag));"
    );
    const dyn = await shell.executeCommand('node dyn.js');
    expect(dyn.stderr).not.toContain('Cannot find module');
    expect(dyn.exitCode).toBe(0);
    expect(dyn.stdout.trim()).toBe('function true false true num-named');
    await fs.dispose();
  });
});
