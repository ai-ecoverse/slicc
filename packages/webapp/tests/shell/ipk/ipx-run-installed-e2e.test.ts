/**
 * Real-shell e2e for the `ipx` runner (ipx-run-installed, M6): `ipk install`
 * synthesized bin fixtures over a real AlmostBashShell + fake-indexeddb VFS,
 * then drive `ipx` through the production realm seam. Proves:
 *  - VAL-IPX-001: runs an installed package bin and prints its output.
 *  - VAL-IPX-002: argv and stdin are forwarded to the bin (no injection/drop).
 *  - VAL-IPX-006: bin resolution shapes — string bin, map bin (both entries),
 *    the .bin shim, and the package-`bin` fallback (no shim).
 *  - VAL-IPX-007: bins run through the jsh runtime — CJS and ESM bins, with the
 *    rewired require (an installed dep) and the `node:` scheme.
 *  - VAL-IPX-008: exit codes propagate and stdout/stderr stay separate.
 */
import 'fake-indexeddb/auto';
import { gzipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** just-bash does not re-export SecureFetchOptions from its root entry. */
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
  dependencies?: Record<string, string>;
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
          dist: { tarball: url },
          ...(p.dependencies ? { dependencies: p.dependencies } : {}),
        },
      },
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
    return { status: 404, statusText: 'Not Found', headers: {}, body: bytes('not found'), url };
  }) as unknown as SecureFetch;
  return { ...actual, createProxiedFetch: () => mockFetch };
});

let dbCounter = 0;

async function newShell() {
  const { VirtualFS } = await import('../../../src/fs/index.js');
  const { AlmostBashShell } = await import('../../../src/shell/almost-bash-shell.js');
  const fs = await VirtualFS.create({ dbName: `test-ipx-${dbCounter++}`, wipe: true });
  await fs.mkdir('/work', { recursive: true });
  const shell = new AlmostBashShell({ fs, cwd: '/work' });
  return { shell, fs };
}

function pkgJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ version: '1.0.0', ...extra });
}

/** String-`bin` CJS package whose bin echoes its argv. */
const sayPkg: SyntheticPackage = {
  name: 'say',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'say', bin: './cli.js' }),
    'cli.js': '#!/usr/bin/env node\nconsole.log("SAY:" + process.argv.slice(2).join("|"));\n',
  },
};

/** Map-`bin` CJS package with two distinct entry files. */
const dualPkg: SyntheticPackage = {
  name: 'dual',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'dual', bin: { dual: './d.js', twin: './t.js' } }),
    'd.js': '#!/usr/bin/env node\nconsole.log("DUAL");\n',
    't.js': '#!/usr/bin/env node\nconsole.log("TWIN");\n',
  },
};

/**
 * Map-`bin` CJS package with two names pointing at ONE file, distinguished by
 * the invoked name via `process.argv[1]` basename (the cowsay/cowthink shape).
 * Also uses the `node:path` scheme (VAL-IPX-007).
 */
const mooPkg: SyntheticPackage = {
  name: 'moo',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'moo', bin: { moo: './cli.js', moothink: './cli.js' } }),
    'cli.js': [
      '#!/usr/bin/env node',
      'const path = require("node:path");',
      'const invoked = path.basename(process.argv[1]);',
      'console.log(invoked + ":" + process.argv.slice(2).join(" "));',
    ].join('\n'),
  },
};

/** CJS bin that `require()`s an installed transitive dependency. */
const usedepPkg: SyntheticPackage = {
  name: 'usedep',
  version: '1.0.0',
  dependencies: { leaf: '^1.0.0' },
  files: {
    'package.json': pkgJson({ name: 'usedep', bin: './cli.js', dependencies: { leaf: '^1.0.0' } }),
    'cli.js': '#!/usr/bin/env node\nconsole.log("USED:" + require("leaf"));\n',
  },
};
const leafPkg: SyntheticPackage = {
  name: 'leaf',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'leaf', main: 'index.js' }),
    'index.js': 'module.exports = "leaf-loaded";\n',
  },
};

/** Bin that reads stdin (VAL-IPX-002). */
const stdinerPkg: SyntheticPackage = {
  name: 'stdiner',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'stdiner', bin: './cli.js' }),
    'cli.js':
      '#!/usr/bin/env node\nconst data = process.stdin.read() || "";\nconsole.log("STDIN:" + data.trim());\n',
  },
};

/** Bin that writes to both streams and exits with a chosen code (VAL-IPX-008). */
const streamsPkg: SyntheticPackage = {
  name: 'streams',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'streams', bin: './cli.js' }),
    'cli.js': [
      '#!/usr/bin/env node',
      'process.stdout.write("OUT\\n");',
      'process.stderr.write("ERR\\n");',
      'const code = Number(process.argv[2] || 0);',
      'process.exit(code);',
    ].join('\n'),
  },
};

/** ESM bin (`"type":"module"`, `.mjs`) that echoes argv (VAL-IPX-007). */
const esmbinPkg: SyntheticPackage = {
  name: 'esmbin',
  version: '1.0.0',
  files: {
    'package.json': pkgJson({ name: 'esmbin', type: 'module', bin: './cli.mjs' }),
    'cli.mjs': [
      '#!/usr/bin/env node',
      'import path from "node:path";',
      'const invoked = path.basename(process.argv[1]);',
      'console.log("ESM:" + invoked + ":" + process.argv.slice(2).join(","));',
    ].join('\n'),
  },
};

describe('ipx runner e2e: ipk install → ipx over the real shell', () => {
  beforeEach(() => {
    sharedRegistry.current = { packuments: {}, tarballs: {} };
  });

  it('VAL-IPX-001/006: runs an installed string-bin package via its .bin shim', async () => {
    sharedRegistry.current = buildRegistry([sayPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install say')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/.bin/say')).toBe(true);

    const run = await shell.executeCommand('ipx say hello there');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('SAY:hello|there');
    await fs.dispose();
  });

  it('VAL-IPX-002: forwards argv verbatim — runner-like flags reach the bin, nothing injected/dropped', async () => {
    sharedRegistry.current = buildRegistry([sayPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install say')).exitCode).toBe(0);

    const run = await shell.executeCommand('ipx say a b --help c');
    expect(run.exitCode).toBe(0);
    // The bin-name token is NOT passed as an arg; every trailing token reaches
    // the bin in order, including the runner-like `--help` flag.
    expect(run.stdout.trim()).toBe('SAY:a|b|--help|c');
    await fs.dispose();
  });

  it('VAL-IPX-002: forwards piped stdin to the bin', async () => {
    sharedRegistry.current = buildRegistry([stdinerPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install stdiner')).exitCode).toBe(0);

    const run = await shell.executeCommand('echo from-stdin | ipx stdiner');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('STDIN:from-stdin');
    await fs.dispose();
  });

  it('VAL-IPX-006: map-bin package runs the distinct second mapped entry', async () => {
    sharedRegistry.current = buildRegistry([dualPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install dual')).exitCode).toBe(0);

    const first = await shell.executeCommand('ipx dual');
    expect(first.exitCode).toBe(0);
    expect(first.stdout.trim()).toBe('DUAL');

    const second = await shell.executeCommand('ipx twin');
    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe('TWIN');
    await fs.dispose();
  });

  it('VAL-IPX-006: one-file map-bin distinguishes the invoked name via argv[1]', async () => {
    sharedRegistry.current = buildRegistry([mooPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install moo')).exitCode).toBe(0);

    const moo = await shell.executeCommand('ipx moo hi');
    expect(moo.exitCode).toBe(0);
    expect(moo.stdout.trim()).toBe('moo:hi');

    const moothink = await shell.executeCommand('ipx moothink hmm');
    expect(moothink.exitCode).toBe(0);
    expect(moothink.stdout.trim()).toBe('moothink:hmm');
    await fs.dispose();
  });

  it('VAL-IPX-006: package-`bin` fallback resolves when no .bin shim exists', async () => {
    sharedRegistry.current = buildRegistry([sayPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install say')).exitCode).toBe(0);

    // Remove the shim so resolution must fall through to the package bin field.
    await fs.rm('/work/node_modules/.bin/say');
    expect(await fs.exists('/work/node_modules/.bin/say')).toBe(false);

    const run = await shell.executeCommand('ipx say fallback');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('SAY:fallback');
    await fs.dispose();
  });

  it('VAL-IPX-007: a CJS bin `require()`s an installed dependency via the rewired loader', async () => {
    sharedRegistry.current = buildRegistry([usedepPkg, leafPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install usedep')).exitCode).toBe(0);
    expect(await fs.exists('/work/node_modules/leaf/package.json')).toBe(true);

    const run = await shell.executeCommand('ipx usedep');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('USED:leaf-loaded');
    await fs.dispose();
  });

  it('VAL-IPX-007: an ESM bin runs through the host transpile path', async () => {
    sharedRegistry.current = buildRegistry([esmbinPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install esmbin')).exitCode).toBe(0);

    const run = await shell.executeCommand('ipx esmbin x y');
    expect(run.stderr).not.toContain('Cannot find module');
    expect(run.stderr).not.toContain('Unexpected token');
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toBe('ESM:esmbin:x,y');
    await fs.dispose();
  }, 20000);

  it('VAL-IPX-008: exit code 0 propagates and stdout/stderr stay separate', async () => {
    sharedRegistry.current = buildRegistry([streamsPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install streams')).exitCode).toBe(0);

    const ok = await shell.executeCommand('ipx streams');
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('OUT');
    expect(ok.stderr.trim()).toBe('ERR');
    expect(ok.stdout).not.toContain('ERR');
    expect(ok.stderr).not.toContain('OUT');
    await fs.dispose();
  });

  it('VAL-IPX-008: a non-zero bin exit propagates to ipx', async () => {
    sharedRegistry.current = buildRegistry([streamsPkg]);
    const { shell, fs } = await newShell();
    expect((await shell.executeCommand('ipk install streams')).exitCode).toBe(0);

    const fail = await shell.executeCommand('ipx streams 3');
    expect(fail.exitCode).toBe(3);
    expect(fail.stdout.trim()).toBe('OUT');
    await fs.dispose();
  });

  it('an unresolvable bin name errors clearly with a non-zero exit and runs nothing', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx no-such-bin-xyz');
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('no-such-bin-xyz');
    await fs.dispose();
  });

  it('`ipx` with no args shows usage and stays responsive', async () => {
    const { shell, fs } = await newShell();
    const run = await shell.executeCommand('ipx');
    expect(run.stdout).toContain('Usage:');
    // A follow-up command still runs.
    const after = await shell.executeCommand('echo still-here');
    expect(after.stdout.trim()).toBe('still-here');
    await fs.dispose();
  });
});
