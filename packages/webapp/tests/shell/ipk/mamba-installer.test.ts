import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  installCondaPackages,
  listInstalledCondaPackages,
  uninstallCondaPackages,
} from '../../../src/shell/ipk/mamba-installer.js';
import { CONDA_PREFIX } from '../../../src/shell/ipk/mamba-prefix.js';
import type { RepodataIndex } from '../../../src/shell/ipk/mamba-repodata.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'zlib-1.3.1-h8b79025_2.tar.bz2'
);

const CHANNEL = 'https://repo.prefix.dev/emscripten-forge-4x';
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
        size: 97407,
      },
    },
  };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function mockFetch(archive: Uint8Array): SecureFetch {
  return (async (url: string) => {
    if (url.endsWith('/repodata.json')) {
      return {
        status: 200,
        statusText: 'OK',
        body: utf8(JSON.stringify(mockIndex())),
        headers: {},
        url,
      };
    }
    if (url.endsWith(`/${FILENAME}`)) {
      return {
        status: 200,
        statusText: 'OK',
        body: archive,
        headers: {},
        url,
      };
    }
    return { status: 404, statusText: 'Not Found', body: utf8(''), headers: {}, url };
  }) as SecureFetch;
}

describe('mamba-installer', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-mamba-installer-${dbCounter++}`,
      wipe: true,
    });
  });

  it('installs zlib into /shared/lib/conda with lib/libz.a and conda-meta', async () => {
    const archive = new Uint8Array(readFileSync(FIXTURE));
    const indexes = new Map<string, RepodataIndex>([[`${CHANNEL}|emscripten-wasm32`, mockIndex()]]);

    const outcome = await installCondaPackages(['zlib'], {
      fs,
      fetch: mockFetch(archive),
      channels: [CHANNEL],
      indexes,
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.name).toBe('zlib');
    expect(outcome.results[0]!.prefix).toBe(CONDA_PREFIX);

    expect(await fs.exists(`${CONDA_PREFIX}/lib/libz.a`)).toBe(true);
    expect(await fs.exists(`${CONDA_PREFIX}/include/zlib.h`)).toBe(true);
    expect(await fs.exists(`${CONDA_PREFIX}/conda-meta/zlib-1.3.1-h8b79025_2.json`)).toBe(true);

    const listed = await listInstalledCondaPackages(fs);
    expect(listed.map((p) => p.name)).toEqual(['zlib']);

    const removed = await uninstallCondaPackages(['zlib'], { fs });
    expect(removed.results[0]!.removed).toBe(true);
    expect(await fs.exists(`${CONDA_PREFIX}/lib/libz.a`)).toBe(false);
    expect(await listInstalledCondaPackages(fs)).toEqual([]);
  });
});
