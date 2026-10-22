/**
 * #4097: `ipk add -g` exited 0 over a package.json of NUL bytes.
 *
 * The bytes went missing in ZenFS: a read open across the package's
 * re-extraction flushed its stale inode onto the new file on close (see
 * tests/fs/zenfs-orphaned-vnode-patch.test.ts). These cases pin both halves
 * of the fix at the ipk surface: that race no longer corrupts a manifest, and
 * ipk reads back every package.json it extracted, re-extracts a broken one
 * once, and exits non-zero rather than report success over it.
 */
import 'fake-indexeddb/auto';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { GLOBAL_NODE_MODULES, GLOBAL_PACKAGE_JSON } from '../../../src/shell/ipk/global-prefix.js';
import { gzip, writeTar } from '../../../src/shell/ipk/tar.js';
import { createIpkCommand } from '../../../src/shell/supplemental-commands/ipk-command.js';
import {
  createGatedDirectoryHandle,
  createMutableDirectoryHandle,
} from '../../fs/fsa-test-helpers.js';
import { withTarballIntegrity } from './helpers/tarball-integrity.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

const encoder = new TextEncoder();
const BRACE_MANIFEST = `${GLOBAL_NODE_MODULES}/brace-expansion/package.json`;

function manifestOf(name: string, version: string, dependencies?: Record<string, string>) {
  return JSON.stringify({ name, version, main: 'index.js', ...(dependencies && { dependencies }) });
}

interface Pkg {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
}

/** A fake registry for `pkgs`; versions of one name are listed in the order given. */
function registryFetch(pkgs: Pkg[]): SecureFetch {
  const tarballs: Record<string, Uint8Array> = {};
  const packuments: Record<string, { name: string; versions: Record<string, unknown> }> = {};
  for (const pkg of pkgs) {
    const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
    tarballs[url] = gzip(
      writeTar([
        {
          path: 'package/package.json',
          bytes: encoder.encode(manifestOf(pkg.name, pkg.version, pkg.dependencies)),
        },
        { path: 'package/index.js', bytes: encoder.encode('module.exports = 1;\n') },
      ])
    );
    packuments[pkg.name] ??= { name: pkg.name, versions: {} };
    packuments[pkg.name].versions[pkg.version] = {
      name: pkg.name,
      version: pkg.version,
      ...(pkg.dependencies && { dependencies: pkg.dependencies }),
      dist: { tarball: url },
    };
  }
  const respond = (url: string, status: number, body: Uint8Array): FetchResult => ({
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: {},
    body,
    url,
  });
  return (async (url: string) => {
    if (tarballs[url]) return respond(url, 200, tarballs[url]);
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const packument = packuments[name];
    if (!packument) return respond(url, 404, encoder.encode('not found'));
    const versions = Object.keys(packument.versions);
    const doc = { ...packument, 'dist-tags': { latest: versions[versions.length - 1] } };
    return respond(url, 200, encoder.encode(JSON.stringify(withTarballIntegrity(doc, tarballs))));
  }) as unknown as SecureFetch;
}

function ctxOf(cwd = '/workspace') {
  const fsLike: Partial<IFileSystem> = {
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
  };
  return { fs: fsLike as IFileSystem, cwd, env: new Map<string, string>(), stdin: '' } as never;
}

const REGISTRY: Pkg[] = [
  { name: 'balanced-match', version: '1.0.2' },
  { name: 'brace-expansion', version: '2.0.1', dependencies: { 'balanced-match': '^1.0.0' } },
  { name: 'brace-expansion', version: '2.0.2', dependencies: { 'balanced-match': '^1.0.0' } },
  { name: 'minimatch', version: '9.0.5', dependencies: { 'brace-expansion': '^2.0.1' } },
];

/** minimatch needs brace-expansion 2 while the root holds 1, so 2 nests under minimatch. */
const NESTED_REGISTRY: Pkg[] = [
  { name: 'balanced-match', version: '1.0.2' },
  { name: 'brace-expansion', version: '1.1.11', dependencies: { 'balanced-match': '^1.0.0' } },
  { name: 'brace-expansion', version: '2.0.1', dependencies: { 'balanced-match': '^1.0.0' } },
  { name: 'minimatch', version: '9.0.4', dependencies: { 'brace-expansion': '^2.0.1' } },
  { name: 'minimatch', version: '9.0.5', dependencies: { 'brace-expansion': '^2.0.1' } },
];
const NESTED_MANIFEST = `${GLOBAL_NODE_MODULES}/minimatch/node_modules/brace-expansion/package.json`;
const BRACE_2 = manifestOf('brace-expansion', '2.0.1', { 'balanced-match': '^1.0.0' });

let dbCounter = 0;

describe('ipk add -g with a reader open on a manifest it replaces (OPFS)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('leaves the re-extracted package.json intact, not NUL bytes', async () => {
    const gated = createGatedDirectoryHandle(createMutableDirectoryHandle({}).handle);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => gated.handle } });
    const dbName = `ipk-manifest-race-${dbCounter++}`;
    const fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    const ipk = createIpkCommand('ipk', { fs, fetch: registryFetch(NESTED_REGISTRY) });
    const first = await ipk.execute(['add', '-g', 'brace-expansion@1', 'minimatch@9.0.4'], ctxOf());
    expect(first.exitCode).toBe(0);

    // A read of minimatch's nested brace-expansion manifest (another `ipk`
    // walking the tree, a `require`) is still open when the upgrade replaces
    // minimatch's directory and extracts the same brace-expansion again. Its
    // flush is made to land mid-write, as it did in CI.
    const opfsPath = `${dbName}${NESTED_MANIFEST}`;
    const read = gated.hold('getFile', opfsPath);
    const reading = fs.readFile(NESTED_MANIFEST);
    await read.reached;
    const dataWrite = gated.hold('createWritable', opfsPath);
    const upgrade = ipk.execute(['add', '-g', 'minimatch@9.0.5'], ctxOf());
    await dataWrite.reached;
    const staleFlush = gated.hold('close', opfsPath);
    read.release();
    const flushed = await Promise.race([
      staleFlush.reached.then(() => true),
      reading.then(() => false),
    ]);
    if (!flushed) staleFlush.release();
    dataWrite.release();
    const result = await upgrade;
    staleFlush.release();
    await reading;

    expect(result.exitCode).toBe(0);
    // Unpatched ZenFS: as many NUL bytes as the manifest is long.
    expect(await fs.readFile(NESTED_MANIFEST)).toBe(BRACE_2);
    await fs.dispose();
  });
});

describe('ipk add verifies every package.json it wrote', () => {
  /** Corrupt the first `times` writes of `path` to NUL bytes of the same length. */
  function nulWrites(fs: VirtualFS, path: string, times: number): { count: () => number } {
    const write = fs.writeFile.bind(fs);
    let writes = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (target, content, options) => {
      if (target !== path) return write(target, content, options);
      writes++;
      if (writes > times) return write(target, content, options);
      const length = typeof content === 'string' ? encoder.encode(content).length : content.length;
      return write(target, new Uint8Array(length), options);
    });
    return { count: () => writes };
  }

  async function memoryFs(): Promise<VirtualFS> {
    return VirtualFS.create({ dbName: `ipk-manifest-verify-${dbCounter++}`, wipe: true });
  }

  it('re-extracts a dependency whose manifest read back as NUL bytes', async () => {
    const fs = await memoryFs();
    const writes = nulWrites(fs, BRACE_MANIFEST, 1);
    const ipk = createIpkCommand('ipk', { fs, fetch: registryFetch(REGISTRY) });

    const result = await ipk.execute(['add', '-g', 'minimatch@9.0.5'], ctxOf());

    expect(result.exitCode).toBe(0);
    expect(writes.count()).toBe(2);
    const manifest = JSON.parse((await fs.readFile(BRACE_MANIFEST)) as string);
    expect(manifest).toMatchObject({ name: 'brace-expansion', version: '2.0.2' });
    expect(await fs.exists(`${GLOBAL_NODE_MODULES}/balanced-match/package.json`)).toBe(true);
  });

  it('exits non-zero when the manifest is still unreadable after the retry', async () => {
    const fs = await memoryFs();
    const writes = nulWrites(fs, BRACE_MANIFEST, Number.POSITIVE_INFINITY);
    const ipk = createIpkCommand('ipk', { fs, fetch: registryFetch(REGISTRY) });

    const result = await ipk.execute(['add', '-g', 'minimatch@9.0.5'], ctxOf());

    expect(result.exitCode).toBe(1);
    expect(writes.count()).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `brace-expansion@2.0.2 (${BRACE_MANIFEST}: ${manifestOf('brace-expansion', '2.0.2', { 'balanced-match': '^1.0.0' }).length} NUL bytes)`
    );
    // Nothing recorded a dependency the tree cannot load.
    expect(await fs.exists(GLOBAL_PACKAGE_JSON)).toBe(false);
  });

  it('exits non-zero when the project manifest it records cannot be read back', async () => {
    const fs = await memoryFs();
    nulWrites(fs, GLOBAL_PACKAGE_JSON, Number.POSITIVE_INFINITY);
    const ipk = createIpkCommand('ipk', { fs, fetch: registryFetch(REGISTRY) });

    const result = await ipk.execute(['add', '-g', 'balanced-match'], ctxOf());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `${GLOBAL_PACKAGE_JSON} does not read back after writing it twice`
    );
  });
});
