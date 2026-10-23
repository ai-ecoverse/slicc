import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { withTarballIntegrity } from './helpers/tarball-integrity.js';

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

function buildTar(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, e.name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, e.data.length);
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
    chunks.push(header, e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
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
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function tarballUrl(name: string, version: string): string {
  const base = name.startsWith('@') ? name.split('/')[1] : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

interface Registry {
  packuments: Record<string, unknown>;
  tarballs: Record<string, Uint8Array>;
}

function buildRegistry(packages: SyntheticPackage[]): Registry {
  const packuments: Record<string, unknown> = {};
  const tarballs: Record<string, Uint8Array> = {};
  const byName = new Map<string, SyntheticPackage[]>();
  for (const p of packages) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, versions] of byName) {
    const versionMap: Record<string, unknown> = {};
    for (const p of versions) {
      const { name: _n, version: _v, ...edges } = p;
      const manifest = { name, version: p.version, main: 'index.js', ...edges };
      versionMap[p.version] = { ...manifest, dist: { tarball: tarballUrl(name, p.version) } };
      tarballs[tarballUrl(name, p.version)] = gzipSync(
        buildTar([
          { name: 'package/package.json', data: bytes(JSON.stringify(manifest)) },
          {
            name: 'package/index.js',
            data: bytes(`module.exports = ${JSON.stringify(`${name}@${p.version}`)};\n`),
          },
        ])
      );
    }
    packuments[name] = {
      name,
      'dist-tags': { latest: versions[versions.length - 1].version },
      versions: versionMap,
    };
  }
  return { packuments, tarballs };
}

const shared: { registry: Registry; tarballFetches: string[] } = {
  registry: { packuments: {}, tarballs: {} },
  tarballFetches: [],
};

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    const reg = shared.registry;
    if (reg.tarballs[url]) {
      shared.tarballFetches.push(url);
      return { status: 200, statusText: 'OK', headers: {}, body: reg.tarballs[url], url };
    }
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
    if (reg.packuments[name]) {
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: bytes(JSON.stringify(withTarballIntegrity(reg.packuments[name], reg.tarballs))),
        url,
      };
    }
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes('not found'), url };
  }) as unknown as SecureFetch;
  return { ...actual, createProxiedFetch: () => mockFetch };
});

let dbCounter = 0;

async function newShell() {
  const fs = await VirtualFS.create({ dbName: `test-ipk-peer-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShellHeadless({ fs, cwd: '/work' });
  return { shell, fs };
}

async function installedVersion(fs: VirtualFS, dir: string): Promise<string | null> {
  const path = `${dir}/package.json`;
  if (!(await fs.exists(path))) return null;
  return (JSON.parse((await fs.readFile(path)) as string) as { version: string }).version;
}

const LOCAL = '/work/node_modules';
const GLOBAL = '/shared/lib/node_modules';

describe('ipk install: required peerDependencies (npm 7+)', () => {
  beforeEach(() => {
    shared.registry = { packuments: {}, tarballs: {} };
    shared.tarballFetches = [];
  });

  for (const [mode, flag, modulesDir] of [
    ['project', '', LOCAL],
    ['global', ' -g', GLOBAL],
  ] as const) {
    describe(`${mode} install`, () => {
      it('installs a missing "*" peer, hoisted next to its dependent', async () => {
        shared.registry = buildRegistry([
          { name: 'grep', version: '1.0.0' },
          { name: 'grep', version: '1.2.0' },
          { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { grep: '*' } },
        ]);
        const { shell, fs } = await newShell();
        const r = await shell.executeCommand(`ipk install${flag} @ai/wasm-xz`);
        expect(r.stderr).toBe('');
        expect(r.exitCode).toBe(0);
        expect(await installedVersion(fs, `${modulesDir}/@ai/wasm-xz`)).toBe('8.0.0');
        expect(await installedVersion(fs, `${modulesDir}/grep`)).toBe('1.2.0');
        expect(await fs.exists(`${modulesDir}/@ai/wasm-xz/node_modules/grep`)).toBe(false);

        const manifestDir = mode === 'global' ? '/shared/lib' : '/work';
        const manifest = JSON.parse((await fs.readFile(`${manifestDir}/package.json`)) as string);
        expect(manifest.dependencies).toEqual({ '@ai/wasm-xz': '^8.0.0' });
        await fs.dispose();
      });

      it('leaves an installed peer that satisfies the range alone', async () => {
        shared.registry = buildRegistry([
          { name: 'grep', version: '1.0.0' },
          { name: 'grep', version: '1.2.0' },
          { name: 'sed', version: '4.9.0' },
          { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { grep: '*', sed: '*' } },
        ]);
        const { shell, fs } = await newShell();
        expect((await shell.executeCommand(`ipk install${flag} grep@1.0.0`)).exitCode).toBe(0);
        shared.tarballFetches = [];

        const r = await shell.executeCommand(`ipk install${flag} @ai/wasm-xz`);
        expect(r.stderr).toBe('');
        expect(r.exitCode).toBe(0);
        expect(await installedVersion(fs, `${modulesDir}/grep`)).toBe('1.0.0');

        expect(await installedVersion(fs, `${modulesDir}/sed`)).toBe('4.9.0');
        expect(shared.tarballFetches.sort()).toEqual([
          tarballUrl('@ai/wasm-xz', '8.0.0'),
          tarballUrl('sed', '4.9.0'),
        ]);
        await fs.dispose();
      });

      it('keeps a previously auto-installed peer on the next install', async () => {
        shared.registry = buildRegistry([
          { name: 'grep', version: '1.0.0' },
          { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { grep: '*' } },
          { name: 'other', version: '1.0.0' },
        ]);
        const { shell, fs } = await newShell();
        expect((await shell.executeCommand(`ipk install${flag} @ai/wasm-xz`)).exitCode).toBe(0);

        shared.registry = buildRegistry([
          { name: 'grep', version: '1.0.0' },
          { name: 'grep', version: '1.5.0' },
          { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { grep: '*' } },
          { name: 'other', version: '1.0.0' },
        ]);
        shared.tarballFetches = [];
        const r = await shell.executeCommand(`ipk install${flag} other`);
        expect(r.exitCode).toBe(0);
        expect(await installedVersion(fs, `${modulesDir}/grep`)).toBe('1.0.0');
        expect(shared.tarballFetches).toEqual([tarballUrl('other', '1.0.0')]);
        await fs.dispose();
      });

      it('does not install a peer marked optional in peerDependenciesMeta', async () => {
        shared.registry = buildRegistry([
          { name: 'grep', version: '1.0.0' },
          { name: 'less', version: '1.0.0' },
          {
            name: '@ai/wasm-git',
            version: '22.0.0',
            peerDependencies: { grep: '*', less: '*' },
            peerDependenciesMeta: { less: { optional: true } },
          },
        ]);
        const { shell, fs } = await newShell();
        const r = await shell.executeCommand(`ipk install${flag} @ai/wasm-git`);
        expect(r.exitCode).toBe(0);
        expect(await installedVersion(fs, `${modulesDir}/grep`)).toBe('1.0.0');
        expect(await fs.exists(`${modulesDir}/less`)).toBe(false);
        expect(shared.tarballFetches).not.toContain(tarballUrl('less', '1.0.0'));
        await fs.dispose();
      });

      it('warns about a conflicting installed peer, keeps it, and exits 0', async () => {
        shared.registry = buildRegistry([
          { name: 'sed', version: '1.0.0' },
          { name: 'sed', version: '2.1.0' },
          { name: 'tool', version: '1.0.0', peerDependencies: { sed: '^2.0.0' } },
        ]);
        const { shell, fs } = await newShell();
        expect((await shell.executeCommand(`ipk install${flag} sed@1.0.0`)).exitCode).toBe(0);

        const r = await shell.executeCommand(`ipk install${flag} tool`);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain('installed tool@1.0.0');
        expect(r.stderr).toContain('ERESOLVE');
        expect(r.stderr).toContain(
          'Could not resolve dependency: peer sed@"^2.0.0" from tool@1.0.0'
        );
        expect(r.stderr).toContain('Found: sed@1.0.0');
        expect(r.stderr).toContain('Conflicting peer dependency: sed@2.1.0');
        expect(await installedVersion(fs, `${modulesDir}/sed`)).toBe('1.0.0');
        expect(shared.tarballFetches).not.toContain(tarballUrl('sed', '2.1.0'));
        await fs.dispose();
      });
    });
  }

  it('-g replaces an orphaned conflicting peer it would prune, with a warning', async () => {
    shared.registry = buildRegistry([
      { name: 'sed', version: '1.0.0' },
      { name: 'sed', version: '2.1.0' },
      { name: 'tool', version: '1.0.0', peerDependencies: { sed: '^2.0.0' } },
    ]);
    const { shell, fs } = await newShell();

    await fs.mkdir(`${GLOBAL}/sed`, { recursive: true });
    await fs.writeFile(`${GLOBAL}/sed/package.json`, '{"name":"sed","version":"1.0.0"}');

    const r = await shell.executeCommand('ipk install -g tool');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('warn ERESOLVE replacing peer dependency');
    expect(r.stderr).toContain('Found: sed@1.0.0');
    expect(r.stderr).toContain('replacing it with sed@2.1.0');
    expect(await installedVersion(fs, `${GLOBAL}/sed`)).toBe('2.1.0');
    await fs.dispose();
  });

  it('warns when an uninstall sync replaces a peer only the removed package kept', async () => {
    shared.registry = buildRegistry([
      { name: 'sed', version: '1.0.0' },
      { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { sed: '*' } },
    ]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install -g @ai/wasm-xz')).exitCode).toBe(0);
    shared.registry = buildRegistry([
      { name: 'sed', version: '1.0.0' },
      { name: 'sed', version: '2.1.0' },
      { name: '@ai/wasm-xz', version: '8.0.0', peerDependencies: { sed: '*' } },
      { name: 'tool', version: '1.0.0', peerDependencies: { sed: '^2.0.0' } },
    ]);
    const kept = await shell.executeCommand('ipk install -g tool');
    expect(kept.stderr).toContain('warn ERESOLVE overriding peer dependency');
    expect(await installedVersion(fs, `${GLOBAL}/sed`)).toBe('1.0.0');

    const r = await shell.executeCommand('ipk uninstall -g @ai/wasm-xz');
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('warn ERESOLVE replacing peer dependency');
    expect(r.stderr).toContain('replacing it with sed@2.1.0');
    expect(await installedVersion(fs, `${GLOBAL}/sed`)).toBe('2.1.0');
    await fs.dispose();
  });

  it('installs peers of peers, and their dependencies, without looping on a peer cycle', async () => {
    shared.registry = buildRegistry([
      { name: 'coreutils', version: '1.0.0', peerDependencies: { bash: '*' } },
      {
        name: 'bash',
        version: '5.0.0',
        peerDependencies: { coreutils: '*' },
        dependencies: { readline: '^8' },
      },
      { name: 'readline', version: '8.2.0' },
      { name: 'diffutils', version: '3.0.0', peerDependencies: { coreutils: '^1.0.0' } },
    ]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('ipk install diffutils');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(await installedVersion(fs, `${LOCAL}/coreutils`)).toBe('1.0.0');
    expect(await installedVersion(fs, `${LOCAL}/bash`)).toBe('5.0.0');
    expect(await installedVersion(fs, `${LOCAL}/readline`)).toBe('8.2.0');
    await fs.dispose();
  });

  it('checks a peer against the version asked for in the same install', async () => {
    shared.registry = buildRegistry([
      { name: 'grep', version: '1.0.0' },
      { name: 'grep', version: '2.0.0' },
      { name: 'tool', version: '1.0.0', peerDependencies: { grep: '^1.0.0' } },
    ]);
    const { shell, fs } = await newShell();
    const r = await shell.executeCommand('ipk install tool grep@1');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(await installedVersion(fs, `${LOCAL}/grep`)).toBe('1.0.0');
    await fs.dispose();
  });
});
