/**
 * No-arg `ipk install` (install-from-manifest) behavior (M2):
 * - Reads cwd `package.json` and installs all `dependencies` AND
 *   `devDependencies` via the transitive installer.
 * - Idempotent re-install is a clean no-op (no re-download of satisfied
 *   packages, no on-disk duplication, exit 0).
 * - Existing installs survive subsequent installs, and a removed
 *   `node_modules` rebuilds faithfully from the manifest.
 * - Empty `dependencies`/`devDependencies` is a quiet successful no-op.
 * - Missing `package.json` is a clear, throwing error and creates nothing.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  installFromManifest,
  installPackage,
  installPackages,
} from '../../../src/shell/ipk/installer.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({
    dbName: `test-ipk-installer-from-manifest-${dbCounter++}`,
    wipe: true,
  });
}

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
  for (const entry of entries) {
    chunks.push(buildHeader(entry));
    chunks.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
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
  dependencies?: Record<string, string>;
  files?: Record<string, string>;
}

function tarballBasename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${base}-${version}.tgz`;
}

function tarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${tarballBasename(name, version)}`;
}

function buildPackageTarball(pkg: SyntheticPackage): Uint8Array {
  const manifest: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
    main: 'index.js',
  };
  if (pkg.dependencies) manifest.dependencies = pkg.dependencies;
  const files: Record<string, string> = {
    'package.json': JSON.stringify(manifest),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  const entries: TarEntryInput[] = Object.entries(files).map(([path, content]) => ({
    name: `package/${path}`,
    data: bytes(content),
  }));
  return gzipSync(buildTar(entries));
}

interface FakeRegistry {
  packuments: Record<string, unknown>;
  tarballs: Record<string, Uint8Array>;
  calls: { url: string; method: string }[];
}

function makeRegistry(packages: SyntheticPackage[]): FakeRegistry {
  const packuments: Record<string, unknown> = {};
  const tarballs: Record<string, Uint8Array> = {};
  const byName = new Map<string, SyntheticPackage[]>();
  for (const p of packages) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name)!.push(p);
  }
  for (const [name, list] of byName) {
    const versionMap: Record<string, unknown> = {};
    for (const p of list) {
      const entry: Record<string, unknown> = {
        name,
        version: p.version,
        dist: { tarball: tarballUrl(name, p.version) },
        main: 'index.js',
      };
      if (p.dependencies) entry.dependencies = p.dependencies;
      versionMap[p.version] = entry;
      tarballs[tarballUrl(name, p.version)] = buildPackageTarball(p);
    }
    packuments[name] = {
      name,
      'dist-tags': { latest: list[list.length - 1].version },
      versions: versionMap,
    };
  }
  return { packuments, tarballs, calls: [] };
}

function fakeFetch(reg: FakeRegistry): SecureFetch {
  return (async (url: string, opts?: SecureFetchOptions): Promise<FetchResult> => {
    reg.calls.push({ url, method: opts?.method ?? 'GET' });
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
}

function countTarballFetches(reg: FakeRegistry): number {
  let n = 0;
  for (const c of reg.calls) {
    if (c.url.endsWith('.tgz')) n++;
  }
  return n;
}

describe('installFromManifest (no-arg ipk install)', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('installs both dependencies and devDependencies from package.json', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
      { name: 'lodash', version: '4.17.21' },
    ]);
    await fs.mkdir('/work', { recursive: true });
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify(
        {
          name: 'demo',
          version: '0.0.1',
          dependencies: { 'is-number': '^7.0.0' },
          devDependencies: { 'is-odd': '^3.0.0', lodash: '^4.0.0' },
        },
        null,
        2
      )
    );

    const out = await installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(out.empty).toBe(false);
    expect(out.errors).toEqual([]);
    expect(out.results.map((r) => r.name).sort()).toEqual(['is-number', 'is-odd', 'lodash']);

    for (const n of ['is-number', 'is-odd', 'lodash']) {
      expect(await fs.exists(`/work/node_modules/${n}/package.json`)).toBe(true);
    }

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies).toEqual({ 'is-number': '^7.0.0' });
    expect(root.devDependencies).toEqual({ 'is-odd': '^3.0.0', lodash: '^4.0.0' });
  });

  it('is a quiet successful no-op when both dependencies and devDependencies are absent/empty', async () => {
    const reg = makeRegistry([]);
    await fs.mkdir('/work', { recursive: true });
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2)
    );

    const out = await installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(out.empty).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([]);
    expect(await fs.exists('/work/node_modules')).toBe(false);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root).toEqual({ name: 'demo', version: '0.0.1' });
  });

  it('treats explicit empty dependencies/devDependencies objects as a quiet no-op', async () => {
    const reg = makeRegistry([]);
    await fs.mkdir('/work', { recursive: true });
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify({ name: 'demo', dependencies: {}, devDependencies: {} }, null, 2)
    );

    const out = await installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(out.empty).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([]);
    expect(await fs.exists('/work/node_modules')).toBe(false);
  });

  it('throws a clear error when package.json is missing and creates nothing', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    await fs.mkdir('/work', { recursive: true });

    await expect(installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' })).rejects.toThrow(
      /no package\.json/i
    );

    expect(await fs.exists('/work/node_modules')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
  });

  it('rebuilds node_modules from package.json when node_modules has been removed', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    await fs.mkdir('/work', { recursive: true });
    await fs.writeFile(
      '/work/package.json',
      JSON.stringify(
        {
          name: 'demo',
          dependencies: { 'is-number': '^7.0.0', 'is-odd': '^3.0.0' },
        },
        null,
        2
      )
    );

    expect(await fs.exists('/work/node_modules')).toBe(false);
    const out = await installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(out.errors).toEqual([]);
    expect(out.results.map((r) => r.name).sort()).toEqual(['is-number', 'is-odd']);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
  });

  it('does not modify package.json when running the no-arg install', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    await fs.mkdir('/work', { recursive: true });
    const original = JSON.stringify(
      {
        name: 'demo',
        version: '0.0.1',
        scripts: { test: 'echo hi' },
        dependencies: { 'is-number': '^7.0.0' },
      },
      null,
      2
    );
    await fs.writeFile('/work/package.json', original);

    await installFromManifest({ fs, fetch: fakeFetch(reg), cwd: '/work' });
    const after = (await fs.readFile('/work/package.json')) as string;
    expect(JSON.parse(after)).toEqual(JSON.parse(original));
  });
});

describe('idempotent install (named and no-arg)', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('a second named install of the same satisfied version downloads no tarball', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const fetch = fakeFetch(reg);
    await installPackage('is-number', { fs, fetch, cwd: '/work' });
    const firstCount = countTarballFetches(reg);
    expect(firstCount).toBe(1);

    await installPackage('is-number', { fs, fetch, cwd: '/work' });
    expect(countTarballFetches(reg)).toBe(firstCount);

    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies)).toEqual(['is-number']);
  });

  it('a second no-arg install when everything is already satisfied is a clean no-op', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    await fs.mkdir('/work', { recursive: true });
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
    const fetch = fakeFetch(reg);

    await installFromManifest({ fs, fetch, cwd: '/work' });
    const firstCount = countTarballFetches(reg);
    expect(firstCount).toBe(2);

    await installFromManifest({ fs, fetch, cwd: '/work' });
    expect(countTarballFetches(reg)).toBe(firstCount);

    for (const n of ['is-number', 'is-odd']) {
      expect(await fs.exists(`/work/node_modules/${n}/package.json`)).toBe(true);
    }
  });

  it('preserves an existing install when a later install targets a different package', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const fetch = fakeFetch(reg);

    await installPackage('is-number', { fs, fetch, cwd: '/work' });
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);

    await installPackage('is-odd', { fs, fetch, cwd: '/work' });
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).sort()).toEqual(['is-number', 'is-odd']);
  });

  it('replaces a previously-installed version with a newer one when the resolved version changes', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.0.0', files: { 'marker.txt': 'A' } },
      { name: 'pkg', version: '2.0.0', files: { 'marker.txt': 'B' } },
    ]);
    const fetch = fakeFetch(reg);

    await installPackage('pkg@1.0.0', { fs, fetch, cwd: '/work' });
    expect((await fs.readFile('/work/node_modules/pkg/marker.txt')) as string).toBe('A');

    await installPackage('pkg@2.0.0', { fs, fetch, cwd: '/work' });
    expect((await fs.readFile('/work/node_modules/pkg/marker.txt')) as string).toBe('B');
  });

  it('multi-package re-install of identical specs downloads each tarball exactly once', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const fetch = fakeFetch(reg);
    await installPackages(['is-number', 'is-odd'], { fs, fetch, cwd: '/work' });
    const firstCount = countTarballFetches(reg);
    expect(firstCount).toBe(2);

    await installPackages(['is-number', 'is-odd'], { fs, fetch, cwd: '/work' });
    expect(countTarballFetches(reg)).toBe(firstCount);
  });
});
