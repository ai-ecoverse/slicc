/**
 * Real-shell e2e for `ipx` error and usage handling (M6): drives the
 * production realm seam over a real AlmostBashShell + fake-indexeddb VFS with
 * a mocked registry serving synthesized `.tgz` fixtures. Proves:
 *  - VAL-IPX-009: an unresolvable package produces a clear error, non-zero
 *    exit, and runs nothing (no stdout, no on-disk pollution).
 *  - VAL-IPX-010: an installed-but-no-bin package and an unmatched bin name
 *    each produce a clear error and non-zero exit, without a pointless
 *    reinstall.
 *  - VAL-IPX-011: `ipx` with no arguments shows concise usage and the shell
 *    stays responsive.
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
  const fs = await VirtualFS.create({ dbName: `test-ipx-err-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

function pkgJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ version: '1.0.0', ...extra });
}

/** A library package with a `main` entry but no `bin` field. */
const noBinPkg: SyntheticPackage = {
  name: 'nobin',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'nobin', main: 'index.js' }),
    'index.js': 'module.exports = "i am a library";\n',
  },
};

/** A normal string-`bin` package for contrast. */
const sayPkg: SyntheticPackage = {
  name: 'say',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'say', bin: './cli.js' }),
    'cli.js': '#!/usr/bin/env node\nconsole.log("SAY:" + process.argv.slice(2).join("|"));\n',
  },
};

describe('ipx error and usage handling', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
    fetchCounter.packument = 0;
    fetchCounter.tarball = 0;
  });

  it('VAL-IPX-011: `ipx` with no args shows usage and stays responsive', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx');
    expect(run.stdout).toContain('Usage:');
    expect(run.stdout).toContain('ipx <pkg-or-bin>');
    expect(run.exitCode).not.toBe(0);
    // A follow-up command still runs, proving the shell did not crash or hang.
    const after = await shell.executeCommand('echo still-here');
    expect(after.stdout.trim()).toBe('still-here');
    await fs.dispose();
  });

  it('VAL-IPX-011: `ipx --help` shows usage and exits 0', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx --help');
    expect(run.stdout).toContain('Usage:');
    expect(run.exitCode).toBe(0);
    await fs.dispose();
  });

  it('VAL-IPX-009: an unresolvable package errors clearly, exits non-zero, and runs nothing', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx slicc-nope-xyz-does-not-exist');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('slicc-nope-xyz-does-not-exist');
    // A clear "not found" / "could not resolve" message is shown, not a stack trace.
    expect(run.stderr).toMatch(/not found|could not resolve|failed to install/i);
    // Nothing was installed and no bin ran.
    expect(await fs.exists('/work/node_modules/slicc-nope-xyz-does-not-exist')).toBe(false);
    await fs.dispose();
  });

  it('VAL-IPX-010: an installed library with no `bin` reports a clear no-bin error', async () => {
    sharedRegistry.current = buildRegistry([noBinPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install nobin')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/nobin/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/.bin/nobin')).toBe(false);

    const tarballsBefore = fetchCounter.tarball;
    const run = await shell.executeCommand('ipx nobin');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nobin');
    expect(run.stderr).toMatch(/no executable bin|does not expose.*bin|exposes no.*bin/i);
    // A package that is already installed must NOT be re-fetched.
    expect(fetchCounter.tarball).toBe(tarballsBefore);
    await fs.dispose();
  });

  it('VAL-IPX-010: an unmatched bin name that is not a package errors clearly with non-zero exit', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx not-a-bin-or-package-xyz');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('not-a-bin-or-package-xyz');
    expect(run.stderr).toMatch(/not found|could not resolve|failed to install/i);
    await fs.dispose();
  });

  it('VAL-IPX-010: auto-installing a package that exists but has no bin still errors clearly', async () => {
    sharedRegistry.current = buildRegistry([noBinPkg]);
    const { shell, fs } = await newShell();
    expect(await fs.exists('/work/node_modules/nobin')).toBe(false);

    const run = await shell.executeCommand('ipx nobin');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    // The package is installed on disk, but the command still cannot run it.
    expect(await fs.exists('/work/node_modules/nobin/package.json')).toBe(true);
    expect(run.stderr).toContain('nobin');
    expect(run.stderr).toMatch(/no executable bin|does not expose.*bin|exposes no.*bin/i);
    await fs.dispose();
  });

  it('VAL-IPX-009/010: the `npx` alias mirrors `ipx` error messages', async () => {
    const { shell, fs } = await newShell();
    const ipxRun = await shell.executeCommand('ipx totally-unknown-alias-xyz');
    const npxRun = await shell.executeCommand('npx totally-unknown-alias-xyz');
    expect(ipxRun.exitCode).not.toBe(0);
    expect(npxRun.exitCode).toBe(ipxRun.exitCode);
    expect(npxRun.stdout).toBe(ipxRun.stdout);
    expect(npxRun.stderr).toBe(ipxRun.stderr.replace(/^ipx:/m, 'npx:'));
    await fs.dispose();
  });
});
