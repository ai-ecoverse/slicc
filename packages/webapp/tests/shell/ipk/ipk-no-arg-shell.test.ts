/**
 * End-to-end shell integration for `ipk install` (no args) and full alias
 * parity for both named AND no-arg installs:
 *   - `ipk install`, `ipk i`, `i`, `npm install`, `npm i` all install from
 *     the cwd `package.json` (dependencies + devDependencies).
 *   - Idempotent re-runs are clean no-ops.
 *   - Empty deps is a quiet successful no-op (exit 0).
 *   - Missing package.json is a clear, non-zero error and creates nothing.
 *   - `node_modules` removal + no-arg install rebuilds from the manifest.
 *   - Parametrized npm-alias failure paths (invalid range, unsatisfiable
 *     version, corrupt tarball, network failure, unsupported subcommand)
 *     lock alias parity on error paths.
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
  for (let i = 0; i < len; i++) {
    view[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
  }
}
function writeOctal(view: Uint8Array, offset: number, len: number, value: number): void {
  const oct = value.toString(8);
  const padded = oct.padStart(len - 1, '0');
  writeString(view, offset, len - 1, padded);
  view[offset + len - 1] = 0;
}
function computeChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  return sum;
}
interface TarEntryInput {
  name: string;
  data: Uint8Array;
}
function buildHeader(entry: TarEntryInput): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = '0'.charCodeAt(0);
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  const sum = computeChecksum(header);
  writeString(header, 148, 6, sum.toString(8).padStart(6, '0'));
  header[154] = 0;
  header[155] = 0x20;
  return header;
}
function buildTar(entries: TarEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    chunks.push(buildHeader(e));
    chunks.push(e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  let total = 0;
  for (const c of chunks) total += c.length;
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
}
function buildTarball(pkg: SyntheticPackage): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: pkg.name, version: pkg.version, main: 'index.js' }),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  const entries: TarEntryInput[] = Object.entries(files).map(([path, content]) => ({
    name: `package/${path}`,
    data: bytes(content),
  }));
  return gzipSync(buildTar(entries));
}
function tarballBasename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${base}-${version}.tgz`;
}

interface Registry {
  packuments: Record<string, unknown>;
  tarballs: Record<string, Uint8Array>;
  calls: { url: string }[];
  networkFails?: boolean;
}
function buildRegistry(packages: SyntheticPackage[]): Registry {
  const packuments: Record<string, unknown> = {};
  const tarballs: Record<string, Uint8Array> = {};
  const byName = new Map<string, SyntheticPackage[]>();
  for (const p of packages) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name)!.push(p);
  }
  for (const [name, versions] of byName) {
    const versionMap: Record<string, unknown> = {};
    for (const p of versions) {
      versionMap[p.version] = {
        name,
        version: p.version,
        dist: {
          tarball: `https://registry.npmjs.org/${name}/-/${tarballBasename(name, p.version)}`,
        },
        main: 'index.js',
      };
      tarballs[`https://registry.npmjs.org/${name}/-/${tarballBasename(name, p.version)}`] =
        buildTarball(p);
    }
    packuments[name] = {
      name,
      'dist-tags': { latest: versions[versions.length - 1].version },
      versions: versionMap,
    };
  }
  return { packuments, tarballs, calls: [] };
}

const sharedRegistry: { current: Registry } = {
  current: { packuments: {}, tarballs: {}, calls: [] },
};

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    const reg = sharedRegistry.current;
    reg.calls.push({ url });
    if (reg.networkFails) {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }
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
    return {
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: bytes('not found'),
      url,
    };
  }) as unknown as SecureFetch;
  return {
    ...actual,
    createProxiedFetch: () => mockFetch,
  };
});

let dbCounter = 0;
async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({
    dbName: `test-ipk-no-arg-shell-${dbCounter++}`,
    wipe: true,
  });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

function tarballFetchCount(reg: Registry): number {
  let n = 0;
  for (const c of reg.calls) {
    if (c.url.endsWith('.tgz')) n++;
  }
  return n;
}

describe('ipk install (no-arg) via real AlmostBashShell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {}, calls: [] };
  });

  it('`ipk install` (no args) installs deps and devDeps from package.json', async () => {
    sharedRegistry.current = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify(
        {
          name: 'demo',
          dependencies: { 'is-number': '^7.0.0' },
          devDependencies: { 'is-odd': '^3.0.0' },
        },
        null,
        2
      )
    );

    const r = await shell.executeCommand('ipk install');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies).toEqual({ 'is-number': '^7.0.0' });
    expect(root.devDependencies).toEqual({ 'is-odd': '^3.0.0' });
    await fs.dispose();
  });

  it.each([
    ['ipk install', 'ipk install'],
    ['ipk i', 'ipk i'],
    ['i', 'i'],
    ['npm install', 'npm install'],
    ['npm i', 'npm i'],
  ])('`%s` (no args) is a faithful no-arg-install alias', async (_label, cmd) => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify({ name: 'demo', dependencies: { 'is-number': '^7.0.0' } }, null, 2)
    );

    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    await fs.dispose();
  });

  it('idempotent re-run is a clean no-op (no re-download of satisfied packages)', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify({ name: 'demo', dependencies: { 'is-number': '^7.0.0' } }, null, 2)
    );

    expect((await shell.executeCommand('ipk install')).exitCode).toBe(0);
    const before = tarballFetchCount(sharedRegistry.current);
    expect(before).toBe(1);

    const r = await shell.executeCommand('ipk install');
    expect(r.exitCode).toBe(0);
    expect(tarballFetchCount(sharedRegistry.current)).toBe(before);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies)).toEqual(['is-number']);
    await fs.dispose();
  });

  it('existing installs survive subsequent installs', async () => {
    sharedRegistry.current = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);

    expect((await shell.executeCommand('ipk install is-odd')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).sort()).toEqual(['is-number', 'is-odd']);
    await fs.dispose();
  });

  it('removed node_modules is rebuilt from package.json by `ipk install` (no args)', async () => {
    sharedRegistry.current = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install is-number is-odd')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);

    expect((await shell.executeCommand('rm -rf node_modules')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules')).toBe(false);

    const r = await shell.executeCommand('ipk install');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
    await fs.dispose();
  });

  it('no-arg install with no declared dependencies is a quiet successful no-op', async () => {
    sharedRegistry.current = { packuments: {}, tarballs: {}, calls: [] };
    const { shell, fs } = await newShell();
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2)
    );

    const r = await shell.executeCommand('ipk install');
    expect(r.exitCode).toBe(0);
    expect((r.stdout + r.stderr).toLowerCase()).toMatch(
      /nothing to install|up to date|already satisfied/
    );
    expect(await fs.exists('/work/node_modules')).toBe(false);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root).toEqual({ name: 'demo', version: '0.0.1' });
    await fs.dispose();
  });

  it('no-arg install with no package.json prints a clear, actionable error and creates nothing', async () => {
    sharedRegistry.current = { packuments: {}, tarballs: {}, calls: [] };
    const { shell, fs } = await newShell();

    const before = await shell.executeCommand('ls -a');
    expect(before.stdout).not.toContain('package.json');

    const r = await shell.executeCommand('ipk install');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/no package\.json/);

    expect(await fs.exists('/work/node_modules')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);

    const followUp = await shell.executeCommand('echo still-responsive');
    expect(followUp.exitCode).toBe(0);
    expect(followUp.stdout).toContain('still-responsive');
    await fs.dispose();
  });
});

describe('npm-alias failure-path parity', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {}, calls: [] };
  });

  it.each([
    ['ipk install pkg@not-a-version', 'invalid range'],
    ['npm install pkg@not-a-version', 'invalid range'],
    ['npm i pkg@not-a-version', 'invalid range'],
  ])('`%s` reports a clear "%s" error and installs nothing', async (cmd) => {
    sharedRegistry.current = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid version or range|bad range|not-a-version/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
    await fs.dispose();
  });

  it.each([
    ['ipk install pkg@99.99.99'],
    ['npm install pkg@99.99.99'],
    ['npm i pkg@99.99.99'],
  ])('`%s` reports no matching version and installs nothing', async (cmd) => {
    sharedRegistry.current = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no version satisfies|matching version/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
    await fs.dispose();
  });

  it.each([
    ['ipk install pkg'],
    ['npm install pkg'],
    ['npm i pkg'],
  ])('`%s` against a corrupt tarball reports cleanly and leaves no half-install', async (cmd) => {
    sharedRegistry.current = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    sharedRegistry.current.tarballs = {
      ...sharedRegistry.current.tarballs,
      ['https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz']: bytes('not-valid-gzip-at-all'),
    };
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/gunzip|gzip|corrupt|decompress|magic/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
    await fs.dispose();
  });

  it.each([
    ['ipk install pkg'],
    ['npm install pkg'],
    ['npm i pkg'],
  ])('`%s` reports a network failure and keeps the shell responsive', async (cmd) => {
    sharedRegistry.current = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    sharedRegistry.current.networkFails = true;
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);

    const followUp = await shell.executeCommand('echo ok');
    expect(followUp.exitCode).toBe(0);
    expect(followUp.stdout).toContain('ok');
    await fs.dispose();
  });

  it.each([
    ['ipk bogus', 'ipk'],
    ['npm bogus', 'npm'],
    ['npm uninstall foo', 'npm'],
    ['npm remove foo', 'npm'],
  ])('`%s` is rejected as an unsupported subcommand', async (cmd) => {
    sharedRegistry.current = { packuments: {}, tarballs: {}, calls: [] };
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand(cmd);
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/unknown subcommand|unsupported/);
    expect(await fs.exists('/work/node_modules')).toBe(false);
    await fs.dispose();
  });
});
