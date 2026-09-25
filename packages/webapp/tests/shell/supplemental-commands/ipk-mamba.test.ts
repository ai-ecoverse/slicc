import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import { CONDA_PREFIX } from '../../../src/shell/ipk/mamba-prefix.js';
import type { RepodataIndex } from '../../../src/shell/ipk/mamba-repodata.js';
import { createIpkCommand } from '../../../src/shell/supplemental-commands/ipk-command.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../ipk/fixtures',
  'zlib-1.3.1-h8b79025_2.tar.bz2'
);

const FILENAME = 'zlib-1.3.1-h8b79025_2.tar.bz2';

function mockIndex(): RepodataIndex {
  return {
    packages: {
      [FILENAME]: {
        name: 'zlib',
        version: '1.3.1',
        build: 'h8b79025_2',
        build_number: 2,
        depends: ['emscripten-abi >=4,<5.0a0'],
      },
    },
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function mockCondaFetch(archive: Uint8Array): SecureFetch {
  return (async (url: string) => {
    if (url.includes('repodata.json')) {
      return {
        status: 200,
        statusText: 'OK',
        body: utf8(JSON.stringify(mockIndex())),
        headers: {},
        url,
      };
    }
    if (url.endsWith(`/${FILENAME}`)) {
      return { status: 200, statusText: 'OK', body: archive, headers: {}, url };
    }
    return { status: 404, statusText: 'Not Found', body: utf8(''), headers: {}, url };
  }) as SecureFetch;
}

describe('ipk mamba', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-ipk-mamba-${dbCounter++}`,
      wipe: true,
    });
  });

  function ctx() {
    return { fs, cwd: '/work', env: new Map(), stdin: '' };
  }

  it('ipk mamba --help documents install/list/uninstall', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(new Uint8Array()) });
    const r = await cmd.execute(['mamba', '--help'], ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/mamba install/);
    expect(r.stdout).toMatch(/\/shared\/lib\/conda/);
    expect(r.stdout).toMatch(/Thin index lookup|not a full/i);
  });

  it('ipk mamba install --help does not require a package name', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(new Uint8Array()) });
    const r = await cmd.execute(['mamba', 'install', '--help'], ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.toLowerCase()).toMatch(/install/);
  });

  it('ipk mamba with no args prints usage and exits non-zero', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(new Uint8Array()) });
    const r = await cmd.execute(['mamba'], ctx() as never);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/mamba/);
  });

  it('installs zlib via ipk mamba install into the conda prefix', async () => {
    const archive = new Uint8Array(readFileSync(FIXTURE));
    // Patch resolve path: installCondaPackages fetches repodata unless indexes
    // are injected — the command path does not expose indexes, so the mock
    // fetch must answer both repodata and the tarball.
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(archive) });
    const r = await cmd.execute(['mamba', 'install', 'zlib'], ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/installed zlib-1\.3\.1/);
    expect(await fs.exists(`${CONDA_PREFIX}/lib/libz.a`)).toBe(true);
    // SIDE_MODULE used by mamba-zlib-e2e (crc32/adler32 smoke).
    expect(await fs.exists(`${CONDA_PREFIX}/lib/libz.so.1.3.1`)).toBe(true);

    const listed = await cmd.execute(['mamba', 'list'], ctx() as never);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toMatch(/zlib-1\.3\.1/);
  });

  it('help steers convert/ffmpeg/python to npm, not mamba', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(new Uint8Array()) });
    const r = await cmd.execute(['mamba', '--help'], ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/Not a drop-in for convert\/ffmpeg\/python/);
    expect(r.stdout).toMatch(/zlib\/libpng/);
  });

  it('does not treat mamba as breaking npm install help', async () => {
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(new Uint8Array()) });
    const r = await cmd.execute(['install', '--help'], ctx() as never);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/node_modules/);
    expect(r.stdout).toMatch(/mamba/);
  });
});
