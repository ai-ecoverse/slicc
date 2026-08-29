/**
 * Global ipk e2e: install -g publishes PATH-visible bins; uninstall -g removes them.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { GLOBAL_BIN_DIR, GLOBAL_NODE_MODULES } from '../../../src/shell/ipk/global-prefix.js';

type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;
type FetchResult = Awaited<ReturnType<SecureFetch>>;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function writeString(view: Uint8Array, offset: number, len: number, value: string): void {
  for (let i = 0; i < len; i++) view[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
}
function writeOctal(view: Uint8Array, offset: number, len: number, value: number): void {
  const oct = value.toString(8);
  writeString(view, offset, len - 1, oct.padStart(len - 1, '0'));
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
      const url = `https://registry.npmjs.org/${p.name}/-/${tarballBasename(p.name, p.version)}`;
      tarballs[url] = buildTarball(p);
      versionMap[p.version] = {
        name: p.name,
        version: p.version,
        ...(bin !== undefined ? { bin } : {}),
        dist: { tarball: url },
      };
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

describe('global ipk bins via PATH (AlmostBashShellHeadless)', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
  });

  async function newShell(cwd = '/work') {
    const fs = await VirtualFS.create({
      dbName: `test-ipk-global-bin-${dbCounter++}`,
      wipe: true,
    });
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir('/tmp/other', { recursive: true });
    const shell = new AlmostBashShellHeadless({ fs, cwd });
    return { shell, fs };
  }

  it('invokes a globally installed bin from an unrelated cwd via PATH', async () => {
    sharedRegistry.current = buildRegistry([
      {
        name: 'greet',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'greet',
            version: '1.0.0',
            bin: { greet: 'cli.js' },
          }),
          'cli.js': 'console.log("hello-global");\n',
        },
      },
    ]);
    const { shell, fs } = await newShell();

    const install = await shell.executeCommand('ipk install -g greet');
    expect(install.exitCode).toBe(0);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/greet.jsh`)).toBe(true);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/greet/package.json`)).toBe(true);

    const run = await shell.executeCommand('cd /tmp/other && greet');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('hello-global');

    await fs.dispose();
  }, 15000);

  it('global bin ignores a same-named local package in cwd', async () => {
    sharedRegistry.current = buildRegistry([
      {
        name: 'greet',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'greet',
            version: '1.0.0',
            bin: { greet: 'cli.js' },
          }),
          'cli.js': 'console.log("hello-global");\n',
        },
      },
      {
        name: 'greet',
        version: '9.9.9',
        files: {
          'package.json': JSON.stringify({
            name: 'greet',
            version: '9.9.9',
            bin: { greet: 'local.js' },
          }),
          'local.js': 'console.log("hello-local");\n',
        },
      },
    ]);
    const { shell, fs } = await newShell();

    await shell.executeCommand('ipk install -g greet@1.0.0');
    const localInstall = await shell.executeCommand(
      'cd /tmp/other && echo "{}" > package.json && ipk install greet@9.9.9'
    );
    expect(localInstall.exitCode).toBe(0);
    const run = await shell.executeCommand('cd /tmp/other && greet');
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('hello-global');
    expect(run.stdout).not.toContain('hello-local');

    await fs.dispose();
  }, 15000);

  it('npm uninstall -g removes the PATH delegator', async () => {
    sharedRegistry.current = buildRegistry([
      {
        name: 'greet',
        version: '1.0.0',
        files: {
          'package.json': JSON.stringify({
            name: 'greet',
            version: '1.0.0',
            bin: { greet: 'cli.js' },
          }),
          'cli.js': 'console.log("hello");\n',
        },
      },
    ]);
    const { shell, fs } = await newShell();

    await shell.executeCommand('npm install -g greet');
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/greet.jsh`)).toBe(true);

    const uninstall = await shell.executeCommand('npm uninstall -g greet');
    expect(uninstall.exitCode).toBe(0);
    expect(await fs.exists(`${GLOBAL_BIN_DIR}/greet.jsh`)).toBe(false);
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/greet`)).toBe(false);

    await fs.dispose();
  }, 15000);
});
