import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  GLOBAL_BIN_DIR,
  GLOBAL_NODE_MODULES,
  GLOBAL_NPM_PREFIX,
  GLOBAL_PACKAGE_JSON,
} from '../../../src/shell/ipk/global-prefix.js';
import {
  createIpkCommand,
  parseInstallArgs,
} from '../../../src/shell/supplemental-commands/ipk-command.js';

/** just-bash does not re-export SecureFetchOptions from its root entry. */
type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

type FetchResult = Awaited<ReturnType<SecureFetch>>;

let dbCounter = 0;
async function newFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `test-ipk-command-${dbCounter++}`, wipe: true });
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
  dependencies?: Record<string, string>;
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
      let bin: unknown;
      const manifestText = p.files?.['package.json'];
      if (manifestText) {
        try {
          bin = (JSON.parse(manifestText) as { bin?: unknown }).bin;
        } catch {
          bin = undefined;
        }
      }
      versionMap[p.version] = {
        name,
        version: p.version,
        ...(p.dependencies ? { dependencies: p.dependencies } : {}),
        ...(bin !== undefined ? { bin } : {}),
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

function makeFetch(reg: Registry): SecureFetch {
  return (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
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

function ctxOf(fs: VirtualFS, cwd = '/work') {
  const fsLike: Partial<IFileSystem> = {
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
  };
  return {
    fs: fsLike as IFileSystem,
    cwd,
    env: new Map<string, string>(),
    stdin: new Uint8Array() as unknown as never,
  };
}

describe('createIpkCommand', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await newFs();
  });

  it('registers under the requested name (ipk / npm)', () => {
    const fetch = makeFetch(buildRegistry([]));
    expect(createIpkCommand('ipk', { fs, fetch }).name).toBe('ipk');
    expect(createIpkCommand('npm', { fs, fetch }).name).toBe('npm');
  });

  it('ipk install <pkg> installs into node_modules, records the dep, and exits 0', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'is-number'], ctxOf(fs) as never);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/is-number/);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
  });

  it('ipk i <pkg> is an alias for install', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['i', 'is-number'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
  });

  it('npm install <pkg> behaves identically to ipk install (alias parity)', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'is-number'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
  });

  it('installs multiple packages in one invocation', async () => {
    const reg = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'is-number', 'is-odd'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
    expect(root.dependencies['is-odd']).toBeDefined();
  });

  it('installs scoped packages under node_modules/<scope>/<name>', async () => {
    const reg = buildRegistry([{ name: '@acme/util', version: '1.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', '@acme/util'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/@acme/util/package.json')).toBe(true);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['@acme/util']).toBeDefined();
  });

  it('honors an exact version pin (<pkg>@x.y.z)', async () => {
    const reg = buildRegistry([
      { name: 'pkg', version: '1.0.0' },
      { name: 'pkg', version: '2.5.0' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'pkg@1.0.0'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    const installed = JSON.parse(
      (await fs.readFile('/work/node_modules/pkg/package.json')) as string
    );
    expect(installed.version).toBe('1.0.0');
  });

  it('resolves ^/~/dist-tag/wildcard specs to the correct version', async () => {
    const reg = buildRegistry([
      { name: 'pkg', version: '1.0.0' },
      { name: 'pkg', version: '1.2.5' },
      { name: 'pkg', version: '1.3.0' },
      { name: 'pkg', version: '2.0.0' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });

    const caret = await cmd.execute(['install', 'pkg@^1.2.0'], ctxOf(await newFs()) as never);
    expect(caret.exitCode).toBe(0);

    const tilde = await cmd.execute(['install', 'pkg@~1.2.0'], ctxOf(await newFs()) as never);
    expect(tilde.exitCode).toBe(0);

    const latestFs = await newFs();
    const latestCmd = createIpkCommand('ipk', { fs: latestFs, fetch: makeFetch(reg) });
    const latest = await latestCmd.execute(['install', 'pkg@latest'], ctxOf(latestFs) as never);
    expect(latest.exitCode).toBe(0);
    const m = JSON.parse(
      (await latestFs.readFile('/work/node_modules/pkg/package.json')) as string
    );
    expect(m.version).toBe('2.0.0');

    const wildFs = await newFs();
    const wildCmd = createIpkCommand('ipk', { fs: wildFs, fetch: makeFetch(reg) });
    const wild = await wildCmd.execute(['install', 'pkg@*'], ctxOf(wildFs) as never);
    expect(wild.exitCode).toBe(0);
    const mw = JSON.parse((await wildFs.readFile('/work/node_modules/pkg/package.json')) as string);
    expect(mw.version).toBe('2.0.0');
  });

  it('re-installing a different version replaces files on disk and updates the manifest range', async () => {
    const reg = buildRegistry([
      { name: 'pkg', version: '1.0.0', files: { 'old-only.txt': 'old' } },
      { name: 'pkg', version: '2.0.0', files: { 'new-only.txt': 'new' } },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });

    const r1 = await cmd.execute(['install', 'pkg@1.0.0'], ctxOf(fs) as never);
    expect(r1.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/pkg/old-only.txt')).toBe(true);

    const r2 = await cmd.execute(['install', 'pkg@2.0.0'], ctxOf(fs) as never);
    expect(r2.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/pkg/old-only.txt')).toBe(false);
    expect(await fs.exists('/work/node_modules/pkg/new-only.txt')).toBe(true);

    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(root.dependencies).filter((k) => k === 'pkg')).toEqual(['pkg']);
    expect(root.dependencies.pkg).toContain('2.0.0');
    expect(root.dependencies.pkg).not.toContain('1.0.0');
  });

  it('prints usage with --help and exits 0', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['--help'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/install/i);
  });

  it('prints clear error and exits non-zero when no subcommand is given', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute([], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/usage|install/);
  });

  it('install with no package name (M1) reports a clear error', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['install'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/package|no-arg|name/i);
  });

  it('reports a clear failure when one of multiple packages cannot be resolved', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(
      ['install', 'is-number', 'definitely-bogus-xyz'],
      ctxOf(fs) as never
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/definitely-bogus-xyz/);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/definitely-bogus-xyz')).toBe(false);
  });

  it('handles registry failures cleanly with a non-zero exit and no manifest pollution', async () => {
    const fetch = (async (url: string): Promise<FetchResult> => ({
      status: 500,
      statusText: 'Server Error',
      headers: {},
      body: bytes('boom'),
      url,
    })) as unknown as SecureFetch;
    const cmd = createIpkCommand('ipk', { fs, fetch });
    const r = await cmd.execute(['install', 'anything'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/500|registry|server/i);
    if (await fs.exists('/work/package.json')) {
      const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
      expect(root.dependencies?.anything).toBeUndefined();
    }
  });

  it('npm with no subcommand shows usage and exits non-zero', async () => {
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute([], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect((r.stderr + r.stdout).toLowerCase()).toMatch(/usage|install/);
  });

  it('ipk with an unsupported subcommand prints an error and exits non-zero', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['bogus'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown subcommand|bogus/);
  });

  it('npm with an unsupported subcommand prints an error and exits non-zero', async () => {
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['bogus', 'x'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/unknown subcommand|bogus/);
  });

  it('i with no args reports a clear error', async () => {
    const cmd = createIpkCommand('i', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute([], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing subcommand|package|name|requires/i);
  });

  it('reports invalid version syntax clearly and installs nothing', async () => {
    const reg = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'pkg@not-a-version'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid version or range|bad range|not-a-version/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
  });

  it('reports unsatisfiable version clearly, leaves no node_modules entry and no manifest pollution', async () => {
    const reg = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', 'pkg@99.99.99'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no version satisfies|matching version/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
  });

  it('reports a corrupt tarball clearly, cleans up the partial install, and does not pollute the manifest', async () => {
    const reg = buildRegistry([{ name: 'pkg', version: '1.0.0' }]);
    const badReg = {
      ...reg,
      tarballs: {
        ...reg.tarballs,
        ['https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz']: bytes('this-is-not-gzip-data'),
      },
    };
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(badReg) });
    const r = await cmd.execute(['install', 'pkg'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/gunzip|gzip|corrupt|decompress|magic/i);
    expect(await fs.exists('/work/node_modules/pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
  });

  it('reports a network throw clearly, leaves no node_modules entry and no manifest pollution', async () => {
    const fetch = (async (_url: string): Promise<FetchResult> => {
      throw new Error('ECONNREFUSED: connection refused');
    }) as unknown as SecureFetch;
    const cmd = createIpkCommand('ipk', { fs, fetch });
    const r = await cmd.execute(['install', 'net-pkg'], ctxOf(fs) as never);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/network|ECONNREFUSED|connection refused/i);
    expect(await fs.exists('/work/node_modules/net-pkg')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);
  });

  it('in a multi-package install, the failing package is named specifically and does not corrupt the manifest for successes', async () => {
    const reg = buildRegistry([
      { name: 'is-number', version: '7.0.0' },
      { name: 'is-odd', version: '3.0.1' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(
      ['install', 'is-number', 'bogus-xyz123', 'is-odd'],
      ctxOf(fs) as never
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/bogus-xyz123/);
    expect(r.stdout).toMatch(/is-number/);
    expect(r.stdout).toMatch(/is-odd/);
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
    expect(await fs.exists('/work/node_modules/bogus-xyz123')).toBe(false);
    const root = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(root.dependencies['is-number']).toBeDefined();
    expect(root.dependencies['is-odd']).toBeDefined();
    expect(root.dependencies['bogus-xyz123']).toBeUndefined();
  });

  it('parseInstallArgs recognizes -g / --global and collects specs', () => {
    expect(parseInstallArgs(['-g', 'left-pad'])).toEqual({ global: true, specs: ['left-pad'] });
    expect(parseInstallArgs(['--global', '@acme/util'])).toEqual({
      global: true,
      specs: ['@acme/util'],
    });
    expect(parseInstallArgs(['is-number'])).toEqual({ global: false, specs: ['is-number'] });
  });

  it('ipk install -g installs into /shared/lib/node_modules, not cwd', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', '-g', 'is-number'], ctxOf(fs, '/tmp/other') as never);

    expect(r.exitCode).toBe(0);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/is-number/package.json`)).toBe(true);
    expect(await fs.exists('/tmp/other/node_modules/is-number')).toBe(false);
    expect(await fs.exists('/tmp/other/package.json')).toBe(false);
    const globalManifest = JSON.parse((await fs.readFile(GLOBAL_PACKAGE_JSON)) as string);
    expect(globalManifest.dependencies['is-number']).toBeDefined();
  });

  it('npm install -g behaves identically to ipk install -g', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', '-g', 'is-number'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/is-number/package.json`)).toBe(true);
  });

  it('global install with no package name fails clearly', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['install', '-g'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/global install requires/i);
  });

  it('global install publishes a PATH delegator for package bins', async () => {
    const reg = buildRegistry([
      {
        name: 'say',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'say',
            version: '1.0.0',
            bin: { say: 'cli.js' },
          }),
          'cli.js': 'console.log("cli");\n',
        },
      },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', '-g', 'say'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    const delegator = `${GLOBAL_BIN_DIR}/say.jsh`;
    expect(await fs.exists(delegator)).toBe(true);
    const source = (await fs.readFile(delegator)) as string;
    expect(source).toMatch(/@ipk-global-delegator/);
    expect(source).toMatch(/await __h\.done/);
    expect(source).toMatch(/process\.stdout\.write/);
    expect(source).toMatch(/ipx/);
  });

  it('incremental global installs merge prior direct dependencies into resolution', async () => {
    const reg = buildRegistry([
      {
        name: 'cli-a',
        version: '1.0.0',
        dependencies: { dep: '^1.0.0' },
        files: {
          'package.json': JSON.stringify({
            name: 'cli-a',
            version: '1.0.0',
            dependencies: { dep: '^1.0.0' },
            bin: { 'cli-a': 'cli.js' },
          }),
          'cli.js': 'require("dep");\n',
        },
      },
      {
        name: 'cli-b',
        version: '1.0.0',
        dependencies: { dep: '^3.0.0' },
        files: {
          'package.json': JSON.stringify({
            name: 'cli-b',
            version: '1.0.0',
            dependencies: { dep: '^3.0.0' },
            bin: { 'cli-b': 'cli.js' },
          }),
          'cli.js': 'require("dep");\n',
        },
      },
      { name: 'dep', version: '1.0.0' },
      { name: 'dep', version: '3.0.0' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r1 = await cmd.execute(['install', '-g', 'cli-a'], ctxOf(fs) as never);
    expect(r1.exitCode).toBe(0);
    const depRoot1 = JSON.parse(
      (await fs.readFile(`${GLOBAL_NODE_MODULES}/dep/package.json`)) as string
    );
    expect(depRoot1.version).toBe('1.0.0');

    const r2 = await cmd.execute(['install', '-g', 'cli-b'], ctxOf(fs) as never);
    expect(r2.exitCode).toBe(0);
    const depRoot2 = JSON.parse(
      (await fs.readFile(`${GLOBAL_NODE_MODULES}/dep/package.json`)) as string
    );
    expect(depRoot2.version).toBe('1.0.0');
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/cli-b/node_modules/dep/package.json`)).toBe(
      true
    );
    const depNested = JSON.parse(
      (await fs.readFile(`${GLOBAL_NODE_MODULES}/cli-b/node_modules/dep/package.json`)) as string
    );
    expect(depNested.version).toBe('3.0.0');
  });

  it('global upgrade prunes orphaned transitive bins from PATH', async () => {
    const reg = buildRegistry([
      {
        name: 'tool',
        version: '1.0.0',
        dependencies: { 'old-cli': '^1.0.0' },
        files: {
          'package.json': JSON.stringify({
            name: 'tool',
            version: '1.0.0',
            dependencies: { 'old-cli': '^1.0.0' },
            bin: { tool: 'tool.js' },
          }),
          'tool.js': 'console.log("tool-v1");\n',
        },
      },
      {
        name: 'tool',
        version: '2.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'tool',
            version: '2.0.0',
            bin: { tool: 'tool.js' },
          }),
          'tool.js': 'console.log("tool-v2");\n',
        },
      },
      {
        name: 'old-cli',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'old-cli',
            version: '1.0.0',
            bin: { 'old-cli': 'cli.js' },
          }),
          'cli.js': 'console.log("old");\n',
        },
      },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install', '-g', 'tool@1.0.0'], ctxOf(fs) as never);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/old-cli.jsh`)).toBe(true);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/old-cli`)).toBe(true);

    const r = await cmd.execute(['install', '-g', 'tool@2.0.0'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/old-cli.jsh`)).toBe(false);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/old-cli`)).toBe(false);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/tool.jsh`)).toBe(true);
  });

  it('global install refuses to overwrite a user script in /shared/bin', async () => {
    await fs.mkdir(GLOBAL_BIN_DIR, { recursive: true });
    await fs.writeFile(`${GLOBAL_BIN_DIR}/say.jsh`, '// user script\n');
    const reg = buildRegistry([
      {
        name: 'say',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'say',
            version: '1.0.0',
            bin: { say: 'cli.js' },
          }),
          'cli.js': 'console.log("cli");\n',
        },
      },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    const r = await cmd.execute(['install', '-g', 'say'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/refusing to overwrite/i);
    expect((await fs.readFile(`${GLOBAL_BIN_DIR}/say.jsh`)) as string).toBe('// user script\n');
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/say`)).toBe(false);
  });

  it('npm root -g prints the global node_modules path', async () => {
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(buildRegistry([])) });
    const r = await cmd.execute(['root', '-g'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(GLOBAL_NODE_MODULES);
  });

  it('npm list -g lists globally installed direct dependencies', async () => {
    const reg = buildRegistry([{ name: 'is-number', version: '7.0.0' }]);
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install', '-g', 'is-number'], ctxOf(fs) as never);
    const r = await cmd.execute(['list', '-g'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(GLOBAL_NPM_PREFIX);
    expect(r.stdout).toContain('is-number@7.0.0');
  });

  it('ipk uninstall -g removes a global package and reconciles the tree', async () => {
    const reg = buildRegistry([
      { name: 'keep', version: '1.0.0' },
      { name: 'drop', version: '1.0.0' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install', '-g', 'keep', 'drop'], ctxOf(fs) as never);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/keep`)).toBe(true);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/drop`)).toBe(true);

    const r = await cmd.execute(['uninstall', '-g', 'drop'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed drop/);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/drop`)).toBe(false);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/keep`)).toBe(true);
    const manifest = JSON.parse((await fs.readFile(GLOBAL_PACKAGE_JSON)) as string);
    expect(manifest.dependencies.keep).toBeDefined();
    expect(manifest.dependencies.drop).toBeUndefined();
  });

  it('local uninstall removes package from cwd manifest and node_modules', async () => {
    const reg = buildRegistry([
      { name: 'keep', version: '1.0.0' },
      { name: 'drop', version: '1.0.0' },
    ]);
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install', 'keep', 'drop'], ctxOf(fs) as never);
    const r = await cmd.execute(['uninstall', 'drop'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/drop')).toBe(false);
    expect(await fs.exists('/work/node_modules/keep')).toBe(true);
    const manifest = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(manifest.dependencies.drop).toBeUndefined();
  });

  it('local uninstall removes a package listed only in devDependencies', async () => {
    const reg = buildRegistry([{ name: 'vitest', version: '1.0.0' }]);
    await fs.writeFile(
      '/work/package.json',
      `${JSON.stringify({ name: 'work', devDependencies: { vitest: '^1.0.0' } }, null, 2)}\n`
    );
    const cmd = createIpkCommand('npm', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install'], ctxOf(fs) as never);
    expect(await fs.exists('/work/node_modules/vitest')).toBe(true);

    const r = await cmd.execute(['uninstall', 'vitest'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/removed vitest/);
    const manifest = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(manifest.devDependencies?.vitest).toBeUndefined();
    expect(await fs.exists('/work/node_modules/vitest')).toBe(false);
  });

  it('uninstall leaves manifest unchanged when reconciliation fails', async () => {
    const reg = buildRegistry([
      { name: 'keep', version: '1.0.0' },
      { name: 'drop', version: '1.0.0' },
    ]);
    const cmd = createIpkCommand('ipk', { fs, fetch: makeFetch(reg) });
    await cmd.execute(['install', '-g', 'keep', 'drop'], ctxOf(fs) as never);

    const failFetch = (async () => {
      throw new Error('network down');
    }) as unknown as SecureFetch;
    const failCmd = createIpkCommand('ipk', { fs, fetch: failFetch });
    const r = await failCmd.execute(['uninstall', '-g', 'drop'], ctxOf(fs) as never);
    expect(r.exitCode).toBe(1);
    const manifest = JSON.parse((await fs.readFile(GLOBAL_PACKAGE_JSON)) as string);
    expect(manifest.dependencies.keep).toBeDefined();
    expect(manifest.dependencies.drop).toBeDefined();
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/drop`)).toBe(true);
  });
});
