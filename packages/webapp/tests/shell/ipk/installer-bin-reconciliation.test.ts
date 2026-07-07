/**
 * Root `node_modules/.bin` reconciliation behavior (M2 fix-up):
 * - Reinstalling a version that drops or renames a bin removes the stale shim
 *   from `node_modules/.bin` while shims for other still-installed packages
 *   survive.
 * - Bins declared by NESTED transitive packages (placed under a dependent's
 *   own `node_modules/` due to a version conflict) are also represented at
 *   the root `node_modules/.bin`.
 * - On binname collision between two installed versions, the root `.bin`
 *   shim deterministically points to the shallowest/top-level (hoisted)
 *   package (npm shallowest-wins).
 * - Bin-less packages never produce a `.bin` entry.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { installPackage, installPackages } from '../../../src/shell/ipk/installer.js';

/** just-bash does not re-export SecureFetchOptions from its root entry. */
type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({
    dbName: `test-ipk-installer-bin-reconciliation-${dbCounter++}`,
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

function buildUstarHeader(entry: TarEntryInput): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = '0'.charCodeAt(0);
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

describe('installer .bin reconciliation (M2 fix)', () => {
  let fs: VirtualFS;
  beforeEach(async () => {
    fs = await newFs();
  });

  it('removes a stale .bin shim when a reinstalled version drops the bin (other packages preserved)', async () => {
    const reg = makeRegistry([
      {
        name: 'foo',
        version: '1.0.0',
        bin: { foocli: 'cli.js' },
        files: { 'cli.js': '#!/usr/bin/env node\n' },
      },
      // newer foo drops the bin entirely
      { name: 'foo', version: '2.0.0' },
      {
        name: 'bar',
        version: '1.0.0',
        bin: { barcli: 'bar.js' },
        files: { 'bar.js': '#!/usr/bin/env node\n' },
      },
    ]);
    const fetch = fakeFetch(reg);

    await installPackages(['foo@1.0.0', 'bar@1.0.0'], { fs, fetch, cwd: '/work' });
    expect(await fs.exists('/work/node_modules/.bin/foocli')).toBe(true);
    expect(await fs.exists('/work/node_modules/.bin/barcli')).toBe(true);

    await installPackage('foo@2.0.0', { fs, fetch, cwd: '/work' });

    expect(await fs.exists('/work/node_modules/.bin/foocli')).toBe(false);
    expect(await fs.exists('/work/node_modules/.bin/barcli')).toBe(true);

    const barShim = (await fs.readFile('/work/node_modules/.bin/barcli')) as string;
    expect(barShim).toContain('bar');
    expect(barShim).toContain('bar.js');

    const remaining = (await fs.readDir('/work/node_modules/.bin')).map((e) => e.name).sort();
    expect(remaining).toEqual(['barcli']);
  });

  it('removes a stale .bin shim when a reinstalled version renames the bin (the new name is linked, the old one is gone)', async () => {
    const reg = makeRegistry([
      {
        name: 'rename-cli',
        version: '1.0.0',
        bin: { oldname: 'cli.js' },
        files: { 'cli.js': '#!/usr/bin/env node\n' },
      },
      {
        name: 'rename-cli',
        version: '2.0.0',
        bin: { newname: 'cli.js' },
        files: { 'cli.js': '#!/usr/bin/env node\n' },
      },
    ]);
    const fetch = fakeFetch(reg);

    await installPackage('rename-cli@1.0.0', { fs, fetch, cwd: '/work' });
    expect(await fs.exists('/work/node_modules/.bin/oldname')).toBe(true);
    expect(await fs.exists('/work/node_modules/.bin/newname')).toBe(false);

    await installPackage('rename-cli@2.0.0', { fs, fetch, cwd: '/work' });

    expect(await fs.exists('/work/node_modules/.bin/oldname')).toBe(false);
    expect(await fs.exists('/work/node_modules/.bin/newname')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/newname')) as string;
    expect(shim).toContain('rename-cli');
  });

  it('surfaces a bin declared only by a NESTED-conflict transitive package at the root node_modules/.bin', async () => {
    // outer-a pulls shared@1 (hoisted, no bin); outer-b pulls shared@2 (nested, declares bin).
    const reg = makeRegistry([
      { name: 'outer-a', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      { name: 'outer-b', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      { name: 'shared', version: '1.0.0' },
      {
        name: 'shared',
        version: '2.0.0',
        bin: { 'shared-tool': 'bin.js' },
        files: { 'bin.js': '#!/usr/bin/env node\n' },
      },
    ]);
    const fetch = fakeFetch(reg);

    await installPackages(['outer-a', 'outer-b'], { fs, fetch, cwd: '/work' });

    // The conflicting nested layout we expect:
    const topShared = JSON.parse(
      (await fs.readFile('/work/node_modules/shared/package.json')) as string
    );
    expect(topShared.version).toBe('1.0.0');
    const nestedShared = JSON.parse(
      (await fs.readFile('/work/node_modules/outer-b/node_modules/shared/package.json')) as string
    );
    expect(nestedShared.version).toBe('2.0.0');

    // The bin from the nested-conflict transitive package must be visible at the ROOT .bin.
    expect(await fs.exists('/work/node_modules/.bin/shared-tool')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/shared-tool')) as string;
    expect(shim).toContain('outer-b/node_modules/shared');
    expect(shim).toContain('bin.js');
  });

  it('on binname collision the root .bin deterministically points to the shallowest/top-level package (npm shallowest-wins)', async () => {
    // top-tool is a direct top-level package that declares "common".
    // outer-b nests a transitive with bin "common" due to a version conflict against shared@1.
    const reg = makeRegistry([
      {
        name: 'top-tool',
        version: '1.0.0',
        bin: { common: 'top.js' },
        files: { 'top.js': '#!/usr/bin/env node\n// top-tool wins\n' },
      },
      { name: 'outer-a', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      { name: 'outer-b', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      { name: 'shared', version: '1.0.0' },
      {
        name: 'shared',
        version: '2.0.0',
        bin: { common: 'nested.js' },
        files: { 'nested.js': '#!/usr/bin/env node\n// nested loses\n' },
      },
    ]);
    const fetch = fakeFetch(reg);

    await installPackages(['top-tool', 'outer-a', 'outer-b'], { fs, fetch, cwd: '/work' });

    // Nested version is on disk.
    expect(await fs.exists('/work/node_modules/outer-b/node_modules/shared/package.json')).toBe(
      true
    );

    // Root .bin/common resolves to top-tool (depth 0), NOT the nested shared@2.0.0 (depth 1).
    expect(await fs.exists('/work/node_modules/.bin/common')).toBe(true);
    const shim = (await fs.readFile('/work/node_modules/.bin/common')) as string;
    expect(shim).toContain('top-tool');
    expect(shim).toContain('top.js');
    expect(shim).not.toContain('outer-b/node_modules/shared');
    expect(shim).not.toContain('nested.js');
  });

  it('does not create root .bin entries for bin-less packages even when nested-conflict transitives exist', async () => {
    // No package declares any bin. We must not get a phantom .bin entry.
    const reg = makeRegistry([
      { name: 'outer-a', version: '1.0.0', dependencies: { shared: '^1.0.0' } },
      { name: 'outer-b', version: '1.0.0', dependencies: { shared: '^2.0.0' } },
      { name: 'shared', version: '1.0.0' },
      { name: 'shared', version: '2.0.0' },
    ]);
    await installPackages(['outer-a', 'outer-b'], {
      fs,
      fetch: fakeFetch(reg),
      cwd: '/work',
    });

    expect(await fs.exists('/work/node_modules/outer-b/node_modules/shared/package.json')).toBe(
      true
    );
    expect(await fs.exists('/work/node_modules/.bin')).toBe(false);
  });
});
