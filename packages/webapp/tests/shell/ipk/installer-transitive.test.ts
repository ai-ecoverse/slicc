/**
 * Transitive-install behavior tests for `ipk` (M2):
 * - Full transitive dependency tree materializes into npm-style node_modules.
 * - Compatible duplicate versions hoist to the top; conflicting versions nest
 *   under the dependent's own `node_modules`.
 * - Only directly-requested packages are recorded in `package.json` (not
 *   transitive dependencies).
 * - `node_modules/.bin` shims are created for declared bins on every installed
 *   package (direct AND transitive); packages without bins do not produce a
 *   spurious `.bin` entry.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch, SecureFetchOptions } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage, installPackages } from '../../../src/shell/ipk/installer.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-ipk-installer-transitive-${dbCounter++}`, wipe: true });
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
  const sum = computeChecksum(header);
  writeString(header, 148, 6, sum.toString(8).padStart(6, '0'));
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
  dependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
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
  if (pkg.bin !== undefined) manifest.bin = pkg.bin;
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
      if (p.bin !== undefined) entry.bin = p.bin;
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
      if (
        url.endsWith(`/${encodeURIComponent(name).replace(/%40/g, '@')}`) ||
        url.endsWith(`/${name}`)
      ) {
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

describe('installer transitive resolution (M2)', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('pulls the full transitive dependency tree (A -> B -> C) into node_modules', async () => {
    const reg = makeRegistry([
      { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
      { name: 'b', version: '1.0.0', dependencies: { c: '^1.0.0' } },
      { name: 'c', version: '1.0.0' },
    ]);
    const result = await installPackage('a', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('a');
    expect(await fs.exists('/work/node_modules/a/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/b/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/c/package.json')).toBe(true);

    // Each manifest has the expected version on disk.
    for (const name of ['a', 'b', 'c']) {
      const m = JSON.parse(
        (await fs.readFile(`/work/node_modules/${name}/package.json`)) as string
      );
      expect(m.version).toBe('1.0.0');
    }
  });

  it('records ONLY directly-requested packages in package.json (transitives are not promoted)', async () => {
    const reg = makeRegistry([
      { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
      { name: 'b', version: '1.0.0', dependencies: { c: '^1.0.0' } },
      { name: 'c', version: '1.0.0' },
    ]);
    await installPackage('a', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies)).toEqual(['a']);
    expect(root.dependencies.b).toBeUndefined();
    expect(root.dependencies.c).toBeUndefined();
  });

  it('hoists compatible duplicate versions of a shared transitive to the top node_modules', async () => {
    const reg = makeRegistry([
      { name: 'left', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      { name: 'right', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      { name: 'shared', version: '1.0.0' },
      { name: 'shared', version: '1.2.0' },
    ]);
    const out = await installPackages(['left', 'right'], {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(out.errors).toEqual([]);
    expect(out.results).toHaveLength(2);

    expect(await fs.exists('/work/node_modules/left/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/right/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/shared/package.json')).toBe(true);

    // Hoisted, not duplicated under either dependent.
    expect(await fs.exists('/work/node_modules/left/node_modules/shared')).toBe(false);
    expect(await fs.exists('/work/node_modules/right/node_modules/shared')).toBe(false);

    const sharedManifest = JSON.parse(
      (await fs.readFile('/work/node_modules/shared/package.json')) as string
    );
    expect(sharedManifest.version).toBe('1.2.0');

    // package.json records only the directly-requested packages.
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).sort()).toEqual(['left', 'right']);
  });

  it('nests a conflicting version under the requiring package when ranges are incompatible', async () => {
    const reg = makeRegistry([
      { name: 'left', version: '1.0.0', dependencies: { dep: '^1.0.0' } },
      { name: 'right', version: '1.0.0', dependencies: { dep: '^2.0.0' } },
      { name: 'dep', version: '1.5.0' },
      { name: 'dep', version: '2.0.0' },
    ]);
    const out = await installPackages(['left', 'right'], {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(out.errors).toEqual([]);

    const topDep = JSON.parse((await fs.readFile('/work/node_modules/dep/package.json')) as string);
    expect(topDep.version).toBe('1.5.0');

    // The conflicting version is materialized under the requiring package's own
    // node_modules; the compatible version stays at the top.
    expect(await fs.exists('/work/node_modules/left/node_modules/dep')).toBe(false);
    const nestedDep = JSON.parse(
      (await fs.readFile('/work/node_modules/right/node_modules/dep/package.json')) as string
    );
    expect(nestedDep.version).toBe('2.0.0');
  });

  it('creates .bin shims for declared direct bins (object form) and not for bin-less packages', async () => {
    const reg = makeRegistry([
      {
        name: 'hello-cli',
        version: '1.0.0',
        bin: { hello: 'cli.js' },
        files: { 'cli.js': '#!/usr/bin/env node\nconsole.log("hello");\n' },
      },
      { name: 'is-number', version: '7.0.0' },
    ]);
    await installPackages(['hello-cli', 'is-number'], {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });

    expect(await fs.exists('/work/node_modules/.bin/hello')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/hello')) as string;
    expect(shim.length).toBeGreaterThan(0);
    expect(shim).toContain('hello-cli');
    expect(shim).toContain('cli.js');

    // No phantom shim for a package that did not declare a bin.
    const binEntries = await fs.readDir('/work/node_modules/.bin');
    expect(binEntries.map((e) => e.name).sort()).toEqual(['hello']);
  });

  it('creates a .bin shim for a string-form bin using the unscoped package name', async () => {
    const reg = makeRegistry([
      {
        name: '@acme/tool',
        version: '1.0.0',
        bin: './bin/tool.js',
        files: { 'bin/tool.js': '#!/usr/bin/env node\n' },
      },
    ]);
    await installPackage('@acme/tool', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(await fs.exists('/work/node_modules/.bin/tool')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/tool')) as string;
    expect(shim).toContain('@acme/tool');
    expect(shim).toContain('bin/tool.js');
  });

  it('creates .bin shims for TRANSITIVE bins, not just direct ones', async () => {
    const reg = makeRegistry([
      { name: 'wrapper', version: '1.0.0', dependencies: { 'transitive-cli': '^1.0.0' } },
      {
        name: 'transitive-cli',
        version: '1.0.0',
        bin: { trans: 'bin.js' },
        files: { 'bin.js': '#!/usr/bin/env node\n' },
      },
    ]);
    await installPackage('wrapper', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(await fs.exists('/work/node_modules/.bin/trans')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/trans')) as string;
    expect(shim).toContain('transitive-cli');
  });

  it('does NOT create a node_modules/.bin directory when no installed package declares a bin', async () => {
    const reg = makeRegistry([
      { name: 'left', version: '1.0.0', dependencies: { right: '^1.0.0' } },
      { name: 'right', version: '1.0.0' },
    ]);
    await installPackage('left', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(await fs.exists('/work/node_modules/left')).toBe(true);
    expect(await fs.exists('/work/node_modules/right')).toBe(true);
    expect(await fs.exists('/work/node_modules/.bin')).toBe(false);
  });

  it('terminates and installs both endpoints when transitive dependencies cycle (A <-> B)', async () => {
    const reg = makeRegistry([
      { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } },
      { name: 'b', version: '1.0.0', dependencies: { a: '^1.0.0' } },
    ]);
    await installPackage('a', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(await fs.exists('/work/node_modules/a/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/b/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies)).toEqual(['a']);
  });

  it('keeps transitive resolution working through a scoped root', async () => {
    const reg = makeRegistry([
      {
        name: '@acme/util',
        version: '1.0.0',
        dependencies: { 'is-number': '^7.0.0' },
      },
      { name: 'is-number', version: '7.0.0' },
    ]);
    await installPackage('@acme/util', { fs, fetch: fakeFetch(reg), cwd: '/work' });
    expect(await fs.exists('/work/node_modules/@acme/util/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies)).toEqual(['@acme/util']);
  });

  it('isolates a stage-1 failure (404 packument) without polluting successful installs or the manifest', async () => {
    const reg = makeRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const out = await installPackages(['is-number', 'bogus-xyz', 'is-odd'], {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });
    expect(out.results.map((r) => r.name).sort()).toEqual(['is-number', 'is-odd']);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].spec).toBe('bogus-xyz');
    expect(await fs.exists('/work/node_modules/bogus-xyz')).toBe(false);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).sort()).toEqual(['is-number', 'is-odd']);
    expect(root.dependencies['bogus-xyz']).toBeUndefined();
  });
});
