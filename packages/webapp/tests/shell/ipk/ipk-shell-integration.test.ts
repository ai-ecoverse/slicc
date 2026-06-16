/**
 * End-to-end integration test for `ipk install` driven through a real
 * AlmostBashShell over a fake-indexeddb VirtualFS, with `SecureFetch`
 * mocked to serve synthesized `.tgz` fixtures.
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

describe('ipk via real AlmostBashShell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
  });

  async function newShell() {
    const { VirtualFS } = await import('../../../src/fs/index.js');
    const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
    const fs = await VirtualFS.create({
      dbName: `test-ipk-shell-${dbCounter++}`,
      wipe: true,
    });
    await fs.mkdir('/work', { recursive: true });
    const shell = new AlmostBashShell({ fs, cwd: '/work' });
    return { shell, fs };
  }

  it('`ipk install <pkg>` materializes node_modules + package.json and exits 0', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();

    const r = await shell.executeCommand('ipk install is-number');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/is-number/);

    const ls = await shell.executeCommand('ls node_modules');
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout).toContain('is-number');

    const cat = await shell.executeCommand('cat node_modules/is-number/package.json');
    expect(cat.exitCode).toBe(0);
    const installed = JSON.parse(cat.stdout);
    expect(installed.name).toBe('is-number');
    expect(installed.version).toBe('7.0.0');

    const rootCat = await shell.executeCommand('cat package.json');
    expect(rootCat.exitCode).toBe(0);
    const root = JSON.parse(rootCat.stdout);
    expect(root.dependencies['is-number']).toBeDefined();

    await fs.dispose();
  });

  it('`npm install <pkg>` (alias) behaves identically', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('npm install is-number');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    await fs.dispose();
  });

  it('`ipk i <pkg>` (shorthand) behaves identically', async () => {
    sharedRegistry.current = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('ipk i is-number');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    await fs.dispose();
  });

  it('installs multiple packages in one invocation', async () => {
    sharedRegistry.current = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('ipk install is-number is-odd');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
    expect(root.dependencies['is-odd']).toBeDefined();
    await fs.dispose();
  });

  it('installs scoped packages under a scope folder', async () => {
    sharedRegistry.current = buildRegistry([{ name: '@acme/util', version: '1.0.0' }]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('ipk install @acme/util');
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/@acme/util/package.json')).toBe(true);
    await fs.dispose();
  });

  it('re-installing a different version replaces files on disk and updates the recorded range', async () => {
    sharedRegistry.current = buildRegistry([
      { name: 'pkg', version: '1.0.0', files: { 'old.txt': 'old' } },
      { name: 'pkg', version: '2.0.0', files: { 'new.txt': 'new' } },
    ]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install pkg@1.0.0')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/pkg/old.txt')).toBe(true);

    expect((await shell.executeCommand('ipk install pkg@2.0.0')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/pkg/old.txt')).toBe(false);
    expect(await fs.exists('/work/node_modules/pkg/new.txt')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).filter((k) => k === 'pkg')).toEqual(['pkg']);
    expect(root.dependencies.pkg).toContain('2.0.0');
    await fs.dispose();
  });

  it('`commands` lists the ipk/npm/i registration', async () => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('commands');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ipk');
    expect(r.stdout).toContain('npm');
    expect(r.stdout).toMatch(/\bi\b/);
    await fs.dispose();
  });
});
