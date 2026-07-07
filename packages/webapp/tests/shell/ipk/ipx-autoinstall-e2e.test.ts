/**
 * Real-shell e2e for the `ipx`/`npx` npx-like auto-install (M6): drives the
 * production realm seam over a real AlmostBashShell + fake-indexeddb VFS with a
 * mocked registry serving synthesized `.tgz` fixtures. Proves:
 *  - VAL-IPX-003: an uninstalled package auto-installs (full transitive tree
 *    materialized) and then runs.
 *  - VAL-IPX-004: an already-installed package runs WITHOUT reinstalling (no
 *    registry fetch, no install activity).
 *  - VAL-IPX-005: `npx` alias parity for both the installed-run and the
 *    auto-install-then-run paths.
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
  files: Record<string, string>;
  dependencies?: Record<string, string>;
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
    packuments[p.name] = {
      name: p.name,
      'dist-tags': { latest: p.version },
      versions: {
        [p.version]: {
          name: p.name,
          version: p.version,
          dist: { tarball: url },
          ...(p.dependencies ? { dependencies: p.dependencies } : {}),
        },
      },
    };
  }
  return { packuments, tarballs };
}

const sharedRegistry: { current: Registry } = { current: { packuments: {}, tarballs: {} } };
const fetchCounter = { packument: 0, tarball: 0 };

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    const reg = sharedRegistry.current;
    if (reg.tarballs[url]) {
      fetchCounter.tarball++;
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
        fetchCounter.packument++;
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
  const fs = await VirtualFS.create({ dbName: `test-ipx-auto-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

function pkgJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ version: '1.0.0', ...extra });
}

/** Leaf dependency required by the bin — proves the full tree is materialized. */
const autodepPkg: SyntheticPackage = {
  name: 'autodep',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'autodep', main: 'index.js' }),
    'index.js': 'module.exports = "dep-ok";\n',
  },
};

/** String-`bin` CJS package whose bin requires a transitive dependency. */
const autocowPkg: SyntheticPackage = {
  name: 'autocow',
  version: '1.0.0',
  dependencies: { autodep: '^1.0.0' },
  files: {
    'package.json': pkgJson({
      name: 'autocow',
      bin: './cli.js',
      dependencies: { autodep: '^1.0.0' },
    }),
    'cli.js':
      '#!/usr/bin/env node\nconsole.log("COW:" + process.argv.slice(2).join("|") + ":" + require("autodep"));\n',
  },
};

describe('ipx/npx npx-like auto-install over the real shell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
    fetchCounter.packument = 0;
    fetchCounter.tarball = 0;
  });

  it('VAL-IPX-003: an uninstalled package auto-installs (full tree) then runs', async () => {
    sharedRegistry.current = buildRegistry([autocowPkg, autodepPkg]);
    const { shell, fs } = await newShell();
    expect(await fs.exists('/work/node_modules/autocow')).toBe(false);

    const run = await shell.executeCommand('ipx autocow auto');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    // The bin ran AND its transitive dependency resolved.
    expect(run.stdout).toContain('COW:auto:dep-ok');
    // The package + its full transitive tree are materialized on the VFS.
    expect(await fs.exists('/work/node_modules/autocow/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/autodep/package.json')).toBe(true);
    // Install activity is observable (it preceded the bin run).
    expect(run.stderr).toContain('autocow');
    expect(fetchCounter.tarball).toBeGreaterThan(0);
    await fs.dispose();
  });

  it('VAL-IPX-004: an already-installed package runs WITHOUT reinstalling', async () => {
    sharedRegistry.current = buildRegistry([autocowPkg, autodepPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install autocow')).exitCode).toBe(0);

    const tarballsBefore = fetchCounter.tarball;
    expect(tarballsBefore).toBeGreaterThan(0);

    const run = await shell.executeCommand('ipx autocow again');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('COW:again:dep-ok');
    // No reinstall: no new tarball fetch and no install/progress line.
    expect(fetchCounter.tarball).toBe(tarballsBefore);
    expect(run.stderr).not.toContain('installed');
    await fs.dispose();
  });

  it('VAL-IPX-005: `npx` alias parity — installed run matches ipx', async () => {
    sharedRegistry.current = buildRegistry([autocowPkg, autodepPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install autocow')).exitCode).toBe(0);

    const viaIpx = await shell.executeCommand('ipx autocow viax');
    const viaNpx = await shell.executeCommand('npx autocow viax');
    expect(viaNpx.exitCode).toBe(viaIpx.exitCode);
    expect(viaNpx.stdout).toBe(viaIpx.stdout);
    expect(viaNpx.stdout).toContain('COW:viax:dep-ok');
    expect(viaNpx.stderr).toBe(viaIpx.stderr);
    await fs.dispose();
  });

  it('VAL-IPX-005: `npx` alias parity — auto-install-then-run matches ipx', async () => {
    sharedRegistry.current = buildRegistry([autocowPkg, autodepPkg]);
    const { shell, fs } = await newShell();
    expect(await fs.exists('/work/node_modules/autocow')).toBe(false);

    const run = await shell.executeCommand('npx autocow viaNpx');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('COW:viaNpx:dep-ok');
    expect(await fs.exists('/work/node_modules/autocow/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/autodep/package.json')).toBe(true);
    expect(run.stderr).toContain('autocow');
    await fs.dispose();
  });

  it('does not reinstall a package that is installed but exposes no matching bin', async () => {
    // `autodep` has no bin; it is installed but `ipx autodep` cannot resolve a
    // bin — it must NOT trigger a (pointless) network reinstall.
    sharedRegistry.current = buildRegistry([autodepPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install autodep')).exitCode).toBe(0);

    const tarballsBefore = fetchCounter.tarball;
    const run = await shell.executeCommand('ipx autodep');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('autodep');
    expect(fetchCounter.tarball).toBe(tarballsBefore);
    await fs.dispose();
  });
});
