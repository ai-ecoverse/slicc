import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage } from '../../../src/shell/ipk/installer.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-ipk-installer-${dbCounter++}`, wipe: true });
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
  typeflag?: string;
}

function buildUstarHeader(entry: TarEntryInput): Uint8Array {
  const header = new Uint8Array(512);
  const typeflag = entry.typeflag ?? '0';
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = typeflag.charCodeAt(0);
  writeString(header, 157, 100, '');
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, '');
  writeString(header, 297, 32, '');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeString(header, 345, 155, '');
  const sum = computeChecksum(header);
  const sumOct = sum.toString(8).padStart(6, '0');
  writeString(header, 148, 6, sumOct);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(entries: TarEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    chunks.push(buildUstarHeader(entry));
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
  files?: Record<string, string>;
  manifestExtras?: Record<string, unknown>;
}

function buildPackageTarball(pkg: SyntheticPackage): Uint8Array {
  const manifest = {
    name: pkg.name,
    version: pkg.version,
    main: 'index.js',
    ...pkg.manifestExtras,
  };
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

interface PackumentSpec {
  name: string;
  versions: string[];
  distTags?: Record<string, string>;
  versionExtras?: Record<string, Record<string, unknown>>;
}

function buildPackument(spec: PackumentSpec): unknown {
  const versionMap: Record<string, unknown> = {};
  for (const v of spec.versions) {
    versionMap[v] = {
      name: spec.name,
      version: v,
      dist: {
        tarball: `https://registry.npmjs.org/${spec.name}/-/${tarballBasename(spec.name, v)}`,
      },
      main: 'index.js',
      ...spec.versionExtras?.[v],
    };
  }
  return {
    name: spec.name,
    'dist-tags': spec.distTags ?? { latest: spec.versions[spec.versions.length - 1] },
    versions: versionMap,
  };
}

function tarballBasename(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `${base}-${version}.tgz`;
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
    packuments[name] = buildPackument({
      name,
      versions: list.map((p) => p.version),
    });
    for (const p of list) {
      const url = `https://registry.npmjs.org/${name}/-/${tarballBasename(name, p.version)}`;
      tarballs[url] = buildPackageTarball(p);
    }
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

describe('installPackage (single-package path)', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await newFs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs a named package into <cwd>/node_modules and records it in package.json', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const fetch = fakeFetch(reg);
    const result = await installPackage('is-number', { fs, fetch, cwd: '/work' });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('is-number');
    expect(result.version).toBe('7.0.0');

    await expect(fs.exists('/work/node_modules/is-number/package.json')).resolves.toBe(true);
    const pkgManifest = JSON.parse(
      (await fs.readFile('/work/node_modules/is-number/package.json')) as string
    );
    expect(pkgManifest.name).toBe('is-number');
    expect(pkgManifest.version).toBe('7.0.0');

    const indexJs = (await fs.readFile('/work/node_modules/is-number/index.js')) as string;
    expect(indexJs.length).toBeGreaterThan(0);
    expect(indexJs).toContain('is-number@7.0.0');

    const rootPackageJson = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(rootPackageJson.dependencies).toBeDefined();
    expect(rootPackageJson.dependencies['is-number']).toBeDefined();
    expect(rootPackageJson.dependencies['is-number']).toMatch(/7\.0\.0/);
  });

  it('creates node_modules and package.json when both are absent', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    expect(await fs.exists('/work')).toBe(false);
    const result = await installPackage('is-number', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(result.ok).toBe(true);
    expect(await fs.exists('/work/node_modules')).toBe(true);
    expect(await fs.exists('/work/package.json')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
  });

  it('does not clobber existing fields in package.json', async () => {
    const reg = makeRegistry([{ name: 'is-number', version: '7.0.0' }]);
    await fs.mkdir('/work', { recursive: true });
    const existing = {
      name: 'demo',
      version: '0.0.1',
      scripts: { test: 'echo hi' },
      dependencies: { 'pre-existing': '^1.0.0' },
      devDependencies: { 'dev-pre': '^2.0.0' },
    };
    await fs.writeFile('/work/package.json', JSON.stringify(existing, null, 2));

    const result = await installPackage('is-number', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(result.ok).toBe(true);
    const merged = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(merged.name).toBe('demo');
    expect(merged.version).toBe('0.0.1');
    expect(merged.scripts).toEqual({ test: 'echo hi' });
    expect(merged.dependencies['pre-existing']).toBe('^1.0.0');
    expect(merged.dependencies['is-number']).toBeDefined();
    expect(merged.devDependencies['dev-pre']).toBe('^2.0.0');
  });

  it('installs an exact version pin', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.0.0' },
      { name: 'pkg', version: '1.2.3' },
      { name: 'pkg', version: '2.0.0' },
    ]);
    const result = await installPackage('pkg@1.0.0', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.0.0');
    const m = JSON.parse((await fs.readFile('/work/node_modules/pkg/package.json')) as string);
    expect(m.version).toBe('1.0.0');
  });

  it('resolves a caret range to the highest matching version', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.0.0' },
      { name: 'pkg', version: '1.2.5' },
      { name: 'pkg', version: '1.3.0' },
      { name: 'pkg', version: '2.0.0' },
    ]);
    const result = await installPackage('pkg@^1.2.0', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.3.0');
  });

  it('resolves a tilde range to the highest matching patch', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.2.0' },
      { name: 'pkg', version: '1.2.5' },
      { name: 'pkg', version: '1.3.0' },
    ]);
    const result = await installPackage('pkg@~1.2.0', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.version).toBe('1.2.5');
  });

  it('resolves @latest to the latest dist-tag', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.0.0' },
      { name: 'pkg', version: '2.0.0' },
    ]);
    const result = await installPackage('pkg@latest', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.version).toBe('2.0.0');
  });

  it('resolves a wildcard spec to the latest dist-tag', async () => {
    const reg = makeRegistry([
      { name: 'pkg', version: '1.5.0' },
      { name: 'pkg', version: '2.1.0' },
    ]);
    const result = await installPackage('pkg@*', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.version).toBe('2.1.0');
  });

  it('installs scoped packages under a scope folder', async () => {
    const reg = makeRegistry([{ name: '@acme/util', version: '1.0.0' }]);
    const result = await installPackage('@acme/util', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('@acme/util');
    expect(await fs.exists('/work/node_modules/@acme/util/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['@acme/util']).toBeDefined();
  });

  it('replaces an existing install on disk and updates the recorded range when a new version is installed', async () => {
    const reg = makeRegistry([
      {
        name: 'pkg',
        version: '1.0.0',
        files: { 'old-only.txt': 'old' },
      },
      {
        name: 'pkg',
        version: '2.0.0',
        files: { 'new-only.txt': 'new' },
      },
    ]);

    const first = await installPackage('pkg@1.0.0', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(first.version).toBe('1.0.0');
    expect(await fs.exists('/work/node_modules/pkg/old-only.txt')).toBe(true);

    const second = await installPackage('pkg@2.0.0', {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(second.version).toBe('2.0.0');

    expect(await fs.exists('/work/node_modules/pkg/old-only.txt')).toBe(false);
    expect(await fs.exists('/work/node_modules/pkg/new-only.txt')).toBe(true);
    const installed = JSON.parse(
      (await fs.readFile('/work/node_modules/pkg/package.json')) as string
    );
    expect(installed.version).toBe('2.0.0');

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies.pkg).toBeDefined();
    expect(root.dependencies.pkg).not.toContain('1.0.0');
    expect(root.dependencies.pkg).toContain('2.0.0');
    expect(Object.keys(root.dependencies).filter((k) => k === 'pkg')).toEqual(['pkg']);
  });

  it('rejects with a clear error when no version satisfies the range', async () => {
    const reg = makeRegistry([{ name: 'pkg', version: '1.0.0' }]);
    await expect(
      installPackage('pkg@^99.0.0', { fs, fetch: fakeFetch(reg), cwd: '/work' })
    ).rejects.toThrow(/no version satisfies|matching version|satisfies/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
  });

  it('rejects with a clear error and writes nothing when the registry returns 404', async () => {
    const fetch = (async (url: string): Promise<FetchResult> => ({
      status: 404,
      statusText: 'Not Found',
      headers: {},
      body: bytes('not found'),
      url,
    })) as unknown as SecureFetch;
    await expect(
      installPackage('this-does-not-exist', { fs, fetch, cwd: '/work' })
    ).rejects.toThrow(/404|registry|not found/i);
    expect(await fs.exists('/work/node_modules/this-does-not-exist')).toBe(false);
  });
});
