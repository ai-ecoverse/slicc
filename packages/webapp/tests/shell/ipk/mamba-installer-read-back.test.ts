/**
 * #4101: `ipk mamba install` exited 0 without reading back what it wrote —
 * the conda sibling of #4097 (installer-manifest-integrity.test.ts). It now
 * reads back every extracted file and its conda-meta record, re-extracts once
 * on a mismatch, and fails rather than report success. `ipk mamba list`
 * reports an unreadable conda-meta record instead of failing or dropping it.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { extractCondaArchive } from '../../../src/shell/ipk/mamba-extract.js';
import { CONDA_PREFIX } from '../../../src/shell/ipk/mamba-prefix.js';
import type { RepodataIndex } from '../../../src/shell/ipk/mamba-repodata.js';
import { createIpkCommand } from '../../../src/shell/supplemental-commands/ipk-command.js';

const FILENAME = 'zlib-1.3.1-h8b79025_2.tar.bz2';
const ARCHIVE = new Uint8Array(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', FILENAME))
);
const LIBZ = `${CONDA_PREFIX}/lib/libz.a`;
const META = `${CONDA_PREFIX}/conda-meta/zlib-1.3.1-h8b79025_2.json`;
const LIBZ_BYTES = extractCondaArchive(ARCHIVE, FILENAME).find(
  (e) => e.path === 'lib/libz.a'
)!.bytes;

const encoder = new TextEncoder();

function condaFetch(): SecureFetch {
  const index: RepodataIndex = {
    packages: {
      [FILENAME]: { name: 'zlib', version: '1.3.1', build: 'h8b79025_2', build_number: 2 },
    },
  };
  return (async (url: string) => {
    const ok = (body: Uint8Array) => ({ status: 200, statusText: 'OK', body, headers: {}, url });
    if (url.includes('repodata.json')) return ok(encoder.encode(JSON.stringify(index)));
    if (url.endsWith(`/${FILENAME}`)) return ok(ARCHIVE);
    return { status: 404, statusText: 'Not Found', body: new Uint8Array(), headers: {}, url };
  }) as SecureFetch;
}

function ctx() {
  return { fs: {}, cwd: '/workspace', env: new Map(), stdin: '' } as never;
}

let dbCounter = 0;

describe('ipk mamba install reads back what it wrote', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `ipk-mamba-read-back-${dbCounter++}`, wipe: true });
  });

  /** Corrupt the first `times` writes of `path` to NUL bytes of the same length. */
  function nulWrites(path: string, times: number): { count: () => number } {
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

  function mamba(...args: string[]) {
    return createIpkCommand('ipk', { fs, fetch: condaFetch() }).execute(['mamba', ...args], ctx());
  }

  it('re-extracts a file that read back as NUL bytes', async () => {
    const writes = nulWrites(LIBZ, 1);

    const result = await mamba('install', 'zlib');

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(writes.count()).toBe(2);
    const libz = (await fs.readFile(LIBZ, { encoding: 'binary' })) as Uint8Array;
    expect(new Uint8Array(libz)).toEqual(LIBZ_BYTES);
    expect(await fs.readlink(`${CONDA_PREFIX}/lib/libz.so`)).toBe('libz.so.1');
    expect(JSON.parse((await fs.readFile(META)) as string)).toMatchObject({ name: 'zlib' });
  });

  it('exits 1 and records nothing when the file is still corrupt after the retry', async () => {
    const writes = nulWrites(LIBZ, Number.POSITIVE_INFINITY);

    const result = await mamba('install', 'zlib');

    expect(result.exitCode).toBe(1);
    expect(writes.count()).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `zlib-1.3.1-h8b79025_2 does not match its archive after re-extracting: ` +
        `${LIBZ}: ${LIBZ_BYTES.length} NUL bytes`
    );
    expect(await fs.exists(META)).toBe(false);
    expect(await fs.exists(LIBZ)).toBe(false);
    expect((await mamba('list')).stdout).toContain('(empty)');
  });

  it('rewrites a conda-meta record that read back corrupt once', async () => {
    const writes = nulWrites(META, 1);

    const result = await mamba('install', 'zlib');

    expect(result.exitCode).toBe(0);
    expect(writes.count()).toBe(2);
    expect(JSON.parse((await fs.readFile(META)) as string)).toMatchObject({ name: 'zlib' });
  });

  it('exits 1 without keeping a conda-meta record that never reads back', async () => {
    nulWrites(META, Number.POSITIVE_INFINITY);

    const result = await mamba('install', 'zlib');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${META} does not read back after writing it twice`);
    expect(await fs.exists(META)).toBe(false);
    expect(await fs.exists(LIBZ)).toBe(false);
  });
});

describe('ipk mamba with an unparseable conda-meta record', () => {
  let fs: VirtualFS;
  const BROKEN = `${CONDA_PREFIX}/conda-meta/libpng-1.6.43-h1234567_0.json`;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `ipk-mamba-broken-meta-${dbCounter++}`, wipe: true });
  });

  function mamba(...args: string[]) {
    return createIpkCommand('ipk', { fs, fetch: condaFetch() }).execute(['mamba', ...args], ctx());
  }

  it('list reports the broken record and still lists the others', async () => {
    expect((await mamba('install', 'zlib')).exitCode).toBe(0);
    await fs.writeFile(BROKEN, new Uint8Array(64));

    const result = await mamba('list');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('zlib-1.3.1-h8b79025_2');
    expect(result.stderr).toContain(`warning: unreadable conda-meta record ${BROKEN}`);
    expect(result.stderr).toContain('uninstall libpng');
  });

  it('uninstall removes the broken record and says its files remain', async () => {
    await fs.mkdir(`${CONDA_PREFIX}/conda-meta`, { recursive: true });
    await fs.writeFile(BROKEN, '{"name": "libpng", ');

    const result = await mamba('uninstall', 'libpng');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('removed libpng');
    expect(result.stderr).toContain(`${BROKEN} was unreadable, so only the record was removed`);
    expect(await fs.exists(BROKEN)).toBe(false);
  });

  it('a reinstall replaces its own broken record, so uninstall reclaims the files', async () => {
    expect((await mamba('install', 'zlib')).exitCode).toBe(0);
    await fs.writeFile(META, new Uint8Array(32));

    const reinstall = await mamba('install', 'zlib');
    expect(reinstall.stderr).toBe('');
    expect(reinstall.exitCode).toBe(0);
    const listed = await mamba('list');
    expect(listed.stderr).toBe('');
    expect(listed.stdout).toContain('zlib-1.3.1-h8b79025_2');

    expect((await mamba('uninstall', 'zlib')).exitCode).toBe(0);
    expect(await fs.exists(LIBZ)).toBe(false);
  });
});
