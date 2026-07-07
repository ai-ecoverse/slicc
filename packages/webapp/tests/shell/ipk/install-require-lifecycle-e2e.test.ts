/**
 * Real-shell e2e for the install->require LIFECYCLE (install-require-lifecycle).
 * Drives the production `AlmostBashShell` over a real `fake-indexeddb`
 * `VirtualFS` with a mocked `SecureFetch` serving synthesized `.tgz` fixtures,
 * proving the integration behaviors that string the whole stack together:
 *
 *  - VAL-CROSS-013: installs persist across SEPARATE shell commands in one VFS
 *    session, and an idempotent re-install is a clean no-op (no on-disk /
 *    manifest duplication, require still resolves afterward).
 *  - VAL-CROSS-012: package.json round-trip — `rm -rf node_modules` then a
 *    no-arg `ipk install` rebuilds the requirable tree (incl. transitive deps)
 *    from the manifest.
 *  - VAL-CROSS-009: a real `.jsh` workflow combining `require('sliccy:exec')`
 *    (a hard-cut capability) with an installed ipk package runs end-to-end.
 *  - VAL-CROSS-015: a brand-new default workspace (no node_modules, no
 *    package.json) can install + require with zero prior setup.
 *  - VAL-CROSS-016 (programmatic reload analog): a freshly-opened VirtualFS
 *    instance over the same persisted store requires the package with NO
 *    reinstall and NO registry fetch. The true full-page reload is confirmed by
 *    the browser validator; this is the closest deterministic analog.
 *
 * Fulfills VAL-CROSS-009, VAL-CROSS-012, VAL-CROSS-013, VAL-CROSS-015, VAL-CROSS-016.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** just-bash does not re-export SecureFetchOptions from its root entry. */
type SecureFetchOptions = NonNullable<Parameters<SecureFetch>[1]>;

type FetchResult = Awaited<ReturnType<SecureFetch>>;

// --- ustar tarball synthesis (mirrors ipk-require-e2e.test.ts) --------------

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
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
}
function buildTarball(pkg: SyntheticPackage): Uint8Array {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      main: 'index.js',
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
    }),
    'index.js': `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};\n`,
    ...pkg.files,
  };
  return gzipSync(
    buildTar(
      Object.entries(files).map(([path, content]) => ({
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
          main: 'index.js',
          dist: { tarball: url },
          ...(p.dependencies ? { dependencies: p.dependencies } : {}),
        },
      },
    };
  }
  return { packuments, tarballs };
}

// is-number / is-odd modeled with real callable implementations so the
// require-and-USE assertions exercise behavior, not just resolution.
const IS_NUMBER: SyntheticPackage = {
  name: 'is-number',
  version: '7.0.0',
  files: {
    'index.js':
      'module.exports = function isNumber(n){ return typeof n === "number" && n - n === 0; };\n',
  },
};
const IS_ODD: SyntheticPackage = {
  name: 'is-odd',
  version: '3.0.1',
  dependencies: { 'is-number': '^7.0.0' },
  files: {
    'index.js':
      'const isNumber = require("is-number");\n' +
      'module.exports = function isOdd(n){ if(!isNumber(n)) throw new TypeError("not a number"); return Math.abs(n % 2) === 1; };\n',
  },
};

const sharedRegistry: { current: Registry } = { current: { packuments: {}, tarballs: {} } };
const requestedUrls: string[] = [];

vi.mock('../../../src/shell/proxied-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shell/proxied-fetch.js')>();
  const mockFetch = (async (url: string, _opts?: SecureFetchOptions): Promise<FetchResult> => {
    requestedUrls.push(url);
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
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes('not found'), url };
  }) as unknown as SecureFetch;
  return { ...actual, createProxiedFetch: () => mockFetch };
});

let dbCounter = 0;

async function newVfs(dbName: string, wipe: boolean) {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const fs = await VirtualFS.create({ dbName, wipe });
  return fs;
}

async function newShell() {
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const dbName = `test-lifecycle-${dbCounter++}`;
  const fs = await newVfs(dbName, true);
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs, dbName };
}

async function shellOn(fs: Awaited<ReturnType<typeof newVfs>>, cwd = '/work') {
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  return new AlmostBashShell({ fs, cwd });
}

describe('install->require lifecycle e2e (real shell + mocked registry)', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
    requestedUrls.length = 0;
  });

  it('VAL-CROSS-013: install persists across separate commands; idempotent re-install is a clean no-op', async () => {
    sharedRegistry.current = buildRegistry([IS_NUMBER]);
    const { shell, fs } = await newShell();

    // 1) install as one command line
    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);

    // 2) an unrelated command runs in between
    expect((await shell.executeCommand('pwd')).stdout.trim()).toBe('/work');

    // 3) a SEPARATE later command requires the package successfully
    const r1 = await shell.executeCommand('node -e "console.log(require(\'is-number\')(1))"');
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout.trim()).toBe('true');

    // 4) the second install is a no-op-style success (no error)
    const urlsBeforeReinstall = requestedUrls.length;
    const second = await shell.executeCommand('ipk install is-number');
    expect(second.exitCode).toBe(0);

    // 5) require still resolves after the repeat install
    const r2 = await shell.executeCommand('node -e "console.log(require(\'is-number\')(2))"');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe('true');

    // No on-disk duplication: exactly one is-number install.
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    // No manifest duplication: dependency recorded exactly once, JSON valid.
    const manifest = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(manifest.dependencies ?? {}).filter((k) => k === 'is-number')).toEqual([
      'is-number',
    ]);
    expect(manifest.dependencies['is-number']).toMatch(/7\.0\.0/);

    // The idempotent re-install must not re-download the tarball.
    const reinstallUrls = requestedUrls.slice(urlsBeforeReinstall);
    expect(reinstallUrls.some((u) => /-\/is-number-7\.0\.0\.tgz/.test(u))).toBe(false);

    await fs.dispose();
  });

  it('VAL-CROSS-012: package.json round-trip — rm -rf node_modules then no-arg install rebuilds the requirable tree', async () => {
    sharedRegistry.current = buildRegistry([IS_NUMBER, IS_ODD]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install is-number is-odd')).exitCode).toBe(0);

    // Both resolve via require before the teardown.
    const before = await shell.executeCommand(
      "node -e \"console.log(require('is-odd')(3), require('is-number')(5))\""
    );
    expect(before.exitCode).toBe(0);
    expect(before.stdout.trim()).toBe('true true');

    // Manifest records only the directly-installed packages.
    const manifest = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['is-number', 'is-odd']);

    // Remove node_modules; requiring now fails.
    expect((await shell.executeCommand('rm -rf node_modules')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-odd')).toBe(false);
    const missing = await shell.executeCommand('node -e "require(\'is-odd\')"');
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("Cannot find module 'is-odd'");

    // No-arg install rebuilds the entire tree from the manifest.
    expect((await shell.executeCommand('ipk install')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/is-odd/package.json')).toBe(true);
    // The transitive dep is restored too (hoisted at top level).
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);

    const after = await shell.executeCommand('node -e "console.log(require(\'is-odd\')(3))"');
    expect(after.exitCode).toBe(0);
    expect(after.stdout.trim()).toBe('true');

    await fs.dispose();
  });

  it("VAL-CROSS-009: a .jsh combining require('sliccy:exec') + an installed package runs end-to-end", async () => {
    sharedRegistry.current = buildRegistry([IS_NUMBER]);
    const { shell, fs } = await newShell();

    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);

    await fs.writeFile(
      '/work/report.jsh',
      [
        "const { exec } = require('sliccy:exec');",
        "const isNumber = require('is-number');",
        "const out = (await exec('echo 41')).stdout.trim();",
        "console.log('shell+pkg', isNumber(Number(out) + 1));",
      ].join('\n')
    );

    const run = await shell.executeCommand('node /work/report.jsh');
    expect(run.stderr).not.toContain('ReferenceError');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('shell+pkg true');

    await fs.dispose();
  });

  it('VAL-CROSS-015: a brand-new default workspace installs + requires with zero prior setup', async () => {
    sharedRegistry.current = buildRegistry([IS_NUMBER]);
    const { shell, fs } = await newShell();

    // Brand-new workspace: neither node_modules nor package.json exists.
    expect(await fs.exists('/work/node_modules')).toBe(false);
    expect(await fs.exists('/work/package.json')).toBe(false);

    // First-ever shell actions: install then require.
    expect((await shell.executeCommand('ipk install is-number')).exitCode).toBe(0);

    // Both were created from scratch.
    expect(await fs.exists('/work/node_modules/is-number/package.json')).toBe(true);
    expect(await fs.exists('/work/package.json')).toBe(true);
    const manifest = JSON.parse((await fs.readFile('/work/package.json')) as string);
    expect(manifest.dependencies['is-number']).toBeTruthy();

    const run = await shell.executeCommand('node -e "console.log(require(\'is-number\')(9))"');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('true');

    await fs.dispose();
  });

  it('VAL-CROSS-016 (programmatic reload analog): a freshly-opened VFS requires without reinstall or registry fetch', async () => {
    sharedRegistry.current = buildRegistry([IS_NUMBER]);

    const dbName = `test-lifecycle-reload-${dbCounter++}`;
    // Anchor instance keeps the persisted store alive across the dispose of the
    // "pre-reload" VFS (the InMemory backend drops the store at refs===0, so a
    // long-lived holder models IndexedDB surviving a page reload).
    const anchor = await newVfs(dbName, true);
    await anchor.mkdir('/work', { recursive: true });

    const fsBefore = await newVfs(dbName, false);
    const shellBefore = await shellOn(fsBefore);
    expect((await shellBefore.executeCommand('ipk install is-number')).exitCode).toBe(0);
    const installedUrls = requestedUrls.length;
    expect(installedUrls).toBeGreaterThan(0);
    await fsBefore.dispose();

    // "Reload": a fresh VirtualFS instance reads the persisted store.
    const fsAfter = await newVfs(dbName, false);
    expect(await fsAfter.exists('/work/node_modules/is-number/package.json')).toBe(true);
    const shellAfter = await shellOn(fsAfter);
    const run = await shellAfter.executeCommand('node -e "console.log(require(\'is-number\')(9))"');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('true');

    // No new registry/CDN fetch happened after the reload.
    expect(requestedUrls.length).toBe(installedUrls);

    await fsAfter.dispose();
    await anchor.dispose();
  });
});
