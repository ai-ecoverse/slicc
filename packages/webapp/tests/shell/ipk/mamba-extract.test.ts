import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bunzip2, extractCondaArchive } from '../../../src/shell/ipk/mamba-extract.js';
import { gzip, writeTar } from '../../../src/shell/ipk/tar.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'zlib-1.3.1-h8b79025_2.tar.bz2'
);

describe('mamba-extract', () => {
  it('bunzip2 rejects non-bzip2 input', () => {
    expect(() => bunzip2(new Uint8Array([1, 2, 3]))).toThrow(/not a valid bzip2/);
  });

  it('extracts the zlib emscripten-forge fixture into lib/libz.a + headers', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const entries = extractCondaArchive(bytes, 'zlib-1.3.1-h8b79025_2.tar.bz2');
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('lib/libz.a');
    expect(paths).toContain('include/zlib.h');
    expect(paths.some((p) => p.startsWith('info/'))).toBe(true);
    const libz = entries.find((e) => e.path === 'lib/libz.a');
    expect(libz!.bytes.length).toBeGreaterThan(100);

    const so = entries.find((e) => e.path === 'lib/libz.so');
    const so1 = entries.find((e) => e.path === 'lib/libz.so.1');
    expect(so?.symlink).toBe('libz.so.1');
    expect(so1?.symlink).toBe('libz.so.1.3.1');
  });

  it('extracts .tar.gz fixtures via gunzip', () => {
    const tar = writeTar([{ path: 'lib/hello.txt', bytes: new TextEncoder().encode('hi') }]);
    const gz = gzip(tar);
    const entries = extractCondaArchive(gz, 'hello.tar.gz');
    expect(entries.map((e) => e.path)).toContain('lib/hello.txt');
  });

  it('refuses path-escape entries and unsupported .conda', () => {
    expect(() => extractCondaArchive(new Uint8Array([0]), 'pkg.conda')).toThrow(/not supported/);
  });
});
