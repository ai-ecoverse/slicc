/**
 * End-to-end: `ipk mamba install zlib` must yield a *working* emscripten
 * SIDE_MODULE (`lib/libz.so*`), not only files on disk.
 *
 * emscripten-forge ships `libz.so.1.3.1` as wasm exporting `crc32` / `adler32`.
 * After install via the `ipk mamba` command we instantiate it and check digests
 * against Node's `zlib.crc32` and a known adler32.
 *
 * convert / ffmpeg / pyodide stay on npm: forge `imagemagick` / `ffmpeg` are
 * static `.a` (CLI JS references missing `.wasm`); there is no forge `pyodide`.
 */

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
  'fixtures',
  'zlib-1.3.1-h8b79025_2.tar.bz2'
);

const FILENAME = 'zlib-1.3.1-h8b79025_2.tar.bz2';
const SO_PATH = `${CONDA_PREFIX}/lib/libz.so.1.3.1`;

/** Digests of `b'hello from mamba zlib'` (Python zlib / Node zlib.crc32). */
const EXPECTED_CRC32 = 3409578126;
const EXPECTED_ADLER32 = 1456998360;

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

type ZlibExports = {
  crc32: (crc: number, buf: number, len: number) => number;
  adler32: (adler: number, buf: number, len: number) => number;
};

/**
 * Minimal host for an emscripten SIDE_MODULE. Enough for crc32/adler32;
 * compress/uncompress need a fuller dynamic linker (GOT.func callbacks).
 */
async function loadZlibSideModule(wasmBytes: Uint8Array): Promise<{
  exports: ZlibExports;
  writeAt: (ptr: number, bytes: Uint8Array) => void;
}> {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
  const table = new WebAssembly.Table({ initial: 256, element: 'anyfunc' });
  const heap = () => new Uint8Array(memory.buffer);
  let heapTop = 1024 * 1024;

  function malloc(n: number): number {
    const p = heapTop;
    heapTop = (heapTop + n + 15) & ~15;
    return p;
  }

  const env: Record<string, unknown> = {
    memory,
    __indirect_function_table: table,
    __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 1024 * 1024 - 16),
    __memory_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 0),
    __table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 0),
    malloc,
    free: (_p: number) => {},
    strlen: (p: number) => {
      const h = heap();
      let i = p;
      while (h[i]) i++;
      return i - p;
    },
    snprintf: () => 0,
    vsnprintf: () => 0,
    open: () => -1,
    close: () => 0,
    read: () => 0,
    write: () => 0,
    lseek: () => 0,
    __errno_location: () => 16,
    strerror: () => 32,
    memchr: (p: number, c: number, n: number) => {
      const h = heap();
      for (let i = 0; i < n; i++) if (h[p + i] === c) return p + i;
      return 0;
    },
  };

  const got = {
    zcalloc: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    zcfree: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    z_errmsg: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    _length_code: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    _dist_code: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env,
    'GOT.func': got,
    'GOT.mem': got,
  });

  return {
    exports: instance.exports as unknown as ZlibExports,
    writeAt: (ptr, bytes) => {
      heap().set(bytes, ptr);
    },
  };
}

describe('ipk mamba zlib e2e (SIDE_MODULE works)', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-mamba-zlib-e2e-${dbCounter++}`,
      wipe: true,
    });
  });

  function ctx() {
    return { fs, cwd: '/work', env: new Map(), stdin: '' };
  }

  it('ipk mamba install zlib → libz.so crc32/adler32 match reference digests', async () => {
    const archive = new Uint8Array(readFileSync(FIXTURE));
    const cmd = createIpkCommand('ipk', { fs, fetch: mockCondaFetch(archive) });

    const installed = await cmd.execute(['mamba', 'install', 'zlib'], ctx() as never);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toMatch(/installed zlib-1\.3\.1/);

    expect(await fs.exists(SO_PATH)).toBe(true);
    const header = await fs.readFile(`${CONDA_PREFIX}/include/zlib.h`);
    expect(String(header)).toContain('#define ZLIB_VERSION "1.3.1"');

    const so = (await fs.readFile(SO_PATH, { encoding: 'binary' })) as Uint8Array;
    expect([so[0], so[1], so[2], so[3]]).toEqual([0, 0x61, 0x73, 0x6d]);

    const { exports, writeAt } = await loadZlibSideModule(so);
    const msg = utf8('hello from mamba zlib');
    const src = 0x10000;
    writeAt(src, msg);

    const crc = exports.crc32(0, src, msg.length) >>> 0;
    const adler = exports.adler32(1, src, msg.length) >>> 0;
    expect(crc).toBe(EXPECTED_CRC32);
    expect(adler).toBe(EXPECTED_ADLER32);
  });
});
