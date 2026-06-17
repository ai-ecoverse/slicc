/**
 * Real-shell e2e for the CJS require hard-switch (cjs-require-rewire-core):
 * `ipk install` a package over a real AlmostBashShell + fake-indexeddb VFS,
 * then `node` `require()` it through the production realm seam. Proves that
 * `require()` resolves from the installed `node_modules` graph (VAL-CROSS-001),
 * transitive deps deep-require transparently (VAL-CROSS-002), and a missing
 * bare module hard-errors with the install hint and triggers NO esm.sh/jsdelivr
 * CDN download (VAL-CROSS-011 / VAL-REQUIRE-013).
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
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
}
function buildTarball(pkg: SyntheticPackage): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: pkg.name, version: pkg.version, main: 'index.js' }),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  return gzipSync(
    buildTar(
      Object.entries(files).map(([path, content]) => ({
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
    packuments[p.name] = {
      name: p.name,
      'dist-tags': { latest: p.version },
      versions: {
        [p.version]: {
          name: p.name,
          version: p.version,
          main: 'index.js',
          dist: { tarball: url },
          ...(p.dependencies ? { dependencies: p.dependencies } : {}),
        },
      },
    };
  }
  return { packuments, tarballs };
}

const sharedRegistry: { current: Registry } = { current: { packuments: {}, tarballs: {} } };
const requestedUrls: string[] = [];

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    requestedUrls.push(url);
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
  const fs = await VirtualFS.create({ dbName: `test-ipk-require-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

describe('CJS require hard-switch e2e: ipk install → node require over the real shell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
    requestedUrls.length = 0;
  });

  it('VAL-CROSS-001: install a no-dep package, then require it returns module.exports verbatim', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);

    await fs.writeFile('/work/run.js', "console.log(require('is-number'));");
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('is-number@7.0.0');
    expect(run.stderr).not.toContain('Cannot find module');
    await fs.dispose();
  });

  it('VAL-CROSS-002: install a transitive tree, then a deep require resolves the nested dep', async () => {
    sharedRegistry.current = buildRegistry([
      {
        name: 'top',
        version: '1.0.0',
        dependencies: { leaf: '^1.0.0' },
        files: { 'index.js': "module.exports = 'top:' + require('leaf');\n" },
      },
      {
        name: 'leaf',
        version: '1.0.0',
        files: { 'index.js': "module.exports = 'leaf-loaded';\n" },
      },
    ]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install top')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/leaf/package.json')).toBe(true);

    await fs.writeFile(
      '/work/run.js',
      "console.log(require('top')); console.log(require('leaf'));"
    );
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toBe('top:leaf-loaded');
    expect(lines[1]).toBe('leaf-loaded');
    await fs.dispose();
  });

  it('package-dir self-main "." resolves to index.js through the real realm seam', async () => {
    sharedRegistry.current = buildRegistry([
      {
        name: 'selfidx',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({ name: 'selfidx', version: '1.0.0', main: '.' }),
          'index.js': "module.exports = 'self-index-ok';\n",
        },
      },
    ]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install selfidx')).exitCode).toBe(0);

    await fs.writeFile('/work/run.js', "console.log(require('selfidx'));");
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('self-index-ok');
    await fs.dispose();
  }, 15000);

  it('package-dir self-main "." with no index.* hard-errors (no hang/stack overflow)', async () => {
    const url = 'https://registry.npmjs.org/noidx/-/noidx-1.0.0.tgz';
    const tarball = gzipSync(
      buildTar([
        {
          name: 'package/package.json',
          data: bytes(JSON.stringify({ name: 'noidx', version: '1.0.0', main: '.' })),
        },
      ])
    );
    sharedRegistry.current = {
      packuments: {
        noidx: {
          name: 'noidx',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': { name: 'noidx', version: '1.0.0', dist: { tarball: url } },
          },
        },
      },
      tarballs: { [url]: tarball },
    };
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install noidx')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/noidx/index.js')).toBe(false);

    await fs.writeFile('/work/run.js', "require('noidx');");
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("Cannot find module 'noidx'");
    await fs.dispose();
  }, 15000);

  it('VAL-CROSS-011 / VAL-REQUIRE-013: a missing module hard-errors with the install hint and NO CDN download', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);
    const urlsBefore = requestedUrls.length;

    await fs.writeFile('/work/run.js', "require('not-installed-xyz');");
    const run = await shell.executeCommand('node run.js');
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain(
      "Cannot find module 'not-installed-xyz' (run: ipk install not-installed-xyz)"
    );

    // The hard switch performs NO network fetch during require: nothing new was
    // requested, and certainly no esm.sh / jsdelivr / /npm/ CDN URL.
    const newUrls = requestedUrls.slice(urlsBefore);
    expect(newUrls).toEqual([]);
    expect(requestedUrls.some((u) => /esm\.sh|jsdelivr|\/npm\//.test(u))).toBe(false);
    await fs.dispose();
  });
});
