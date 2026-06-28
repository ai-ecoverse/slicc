import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { gunzip, readTar } from '../../../src/shell/ipk/tar.js';

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
  typeflag?: string;
  prefix?: string;
}

function buildUstarHeader(entry: TarEntryInput): Uint8Array {
  const header = new Uint8Array(512);
  const typeflag = entry.typeflag ?? '0';
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  // Checksum field initialized to spaces for computation.
  for (let i = 0; i < 8; i++) header[148 + i] = 0x20;
  header[156] = typeflag.charCodeAt(0);
  writeString(header, 157, 100, '');
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, '');
  writeString(header, 297, 32, '');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeString(header, 345, 155, entry.prefix ?? '');
  const sum = computeChecksum(header);
  const sumOct = sum.toString(8).padStart(6, '0');
  writeString(header, 148, 6, sumOct);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function buildTar(entries: TarEntryInput[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    chunks.push(buildUstarHeader(entry));
    chunks.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad > 0) chunks.push(new Uint8Array(pad));
  }
  // Two zero blocks at the end.
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

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function paxRecord(key: string, value: string): Uint8Array {
  const enc = new TextEncoder();
  const body = enc.encode(` ${key}=${value}\n`);
  let len = body.length + 1;
  while (String(len).length + body.length !== len) {
    len = String(len).length + body.length;
  }
  const prefix = enc.encode(String(len));
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

describe('gunzip', () => {
  it('decompresses gzip output produced by fflate', () => {
    const original = bytes('hello world');
    const gz = gzipSync(original);
    const out = gunzip(gz);
    expect(out).toEqual(original);
  });

  it('throws a clear error on non-gzip input', () => {
    const notGzip = new Uint8Array([1, 2, 3, 4, 5]);
    expect(() => gunzip(notGzip)).toThrow(/gzip|gunzip|decompress|invalid/i);
  });

  it('throws on truncated gzip input', () => {
    const gz = gzipSync(bytes('some content'));
    const truncated = gz.slice(0, 4);
    expect(() => gunzip(truncated)).toThrow();
  });
});

describe('readTar', () => {
  it('reads a single small file with package/ prefix stripped', () => {
    const tar = buildTar([{ name: 'package/package.json', data: bytes('{"name":"a"}') }]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('package.json');
    expect(new TextDecoder().decode(out[0].bytes)).toBe('{"name":"a"}');
  });

  it('reads multiple files with varied sizes honoring 512-byte block alignment', () => {
    const big = new Uint8Array(2000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const exact = new Uint8Array(512);
    for (let i = 0; i < exact.length; i++) exact[i] = (i * 7) & 0xff;
    const tiny = bytes('x');
    const empty = new Uint8Array(0);
    const tar = buildTar([
      { name: 'package/package.json', data: bytes('{"name":"multi"}') },
      { name: 'package/lib/big.bin', data: big },
      { name: 'package/lib/exact.bin', data: exact },
      { name: 'package/lib/tiny.txt', data: tiny },
      { name: 'package/lib/empty.txt', data: empty },
    ]);
    const out = readTar(tar);
    const byPath = new Map(out.map((e) => [e.path, e.bytes]));
    expect(byPath.get('package.json')).toEqual(bytes('{"name":"multi"}'));
    expect(byPath.get('lib/big.bin')).toEqual(big);
    expect(byPath.get('lib/exact.bin')).toEqual(exact);
    expect(byPath.get('lib/tiny.txt')).toEqual(tiny);
    expect(byPath.get('lib/empty.txt')).toEqual(empty);
  });

  it('parses octal sizes correctly for sizes that need 8+ octal digits', () => {
    const big = new Uint8Array(1234);
    for (let i = 0; i < big.length; i++) big[i] = (i * 13) & 0xff;
    const tar = buildTar([{ name: 'package/blob', data: big }]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].bytes.length).toBe(1234);
    expect(out[0].bytes).toEqual(big);
  });

  it('skips directory entries (typeflag 5)', () => {
    const tar = buildTar([
      { name: 'package/lib/', data: new Uint8Array(0), typeflag: '5' },
      { name: 'package/lib/a.txt', data: bytes('A') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('lib/a.txt');
  });

  it('roundtrips through gzip+gunzip', () => {
    const tar = buildTar([
      { name: 'package/index.js', data: bytes('module.exports = 1') },
      { name: 'package/README.md', data: bytes('# hi') },
    ]);
    const gz = gzipSync(tar);
    const out = readTar(gunzip(gz));
    expect(out.map((e) => e.path).sort()).toEqual(['README.md', 'index.js']);
  });

  it('handles the GNU @LongLink long-name extension', () => {
    const longName = `package/${'a'.repeat(50)}/${'b'.repeat(60)}/file.txt`;
    const nameBytes = new Uint8Array(longName.length + 1);
    nameBytes.set(new TextEncoder().encode(longName), 0);
    const tar = buildTar([
      { name: '././@LongLink', data: nameBytes, typeflag: 'L' },
      { name: longName.slice(0, 100), data: bytes('hello') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(longName.replace(/^package\//, ''));
    expect(new TextDecoder().decode(out[0].bytes)).toBe('hello');
  });

  it('honors PAX path overrides', () => {
    const longPath = `package/${'p'.repeat(120)}/file.txt`;
    const recordBytes = paxRecord('path', longPath);
    const tar = buildTar([
      { name: 'package/PaxHeader/file', data: recordBytes, typeflag: 'x' },
      { name: longPath.slice(0, 100), data: bytes('paxed') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(longPath.replace(/^package\//, ''));
    expect(new TextDecoder().decode(out[0].bytes)).toBe('paxed');
  });

  it('uses ustar prefix+name when prefix is set', () => {
    const tar = buildTar([{ name: 'lib/file.js', prefix: 'package', data: bytes('p') }]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('lib/file.js');
  });

  it('reconstructs deep paths split across ustar prefix+name (long-path regression)', () => {
    // node-tar / `npm pack` split long paths (100-255 chars) across the ustar
    // prefix (offset 345) and name (offset 0) fields. nanotar alone reads only
    // name; the reader must recombine prefix+name so the file lands in the right
    // directory instead of at the archive root.
    const body = bytes('deep contents');
    const tar = buildTar([{ name: 'file.js', prefix: 'package/lib/very/deep/dir', data: body }]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('lib/very/deep/dir/file.js');
    expect(out[0].bytes).toEqual(body);
  });

  it('does not double-prefix a PAX long-name entry that also carries a ustar prefix', () => {
    // When a PAX/GNU long-name override is present, it already holds the full
    // path; the stale ustar prefix on the same header must be ignored.
    const longPath = `package/${'q'.repeat(120)}/deep.txt`;
    const recordBytes = paxRecord('path', longPath);
    const tar = buildTar([
      { name: 'package/PaxHeader/file', data: recordBytes, typeflag: 'x' },
      { name: longPath.slice(0, 100), prefix: 'package/should/not/appear', data: bytes('paxed') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(longPath.replace(/^package\//, ''));
    expect(new TextDecoder().decode(out[0].bytes)).toBe('paxed');
  });

  it('returns independent byte copies (mutating the source does not affect entries)', () => {
    const tar = buildTar([{ name: 'package/a.txt', data: bytes('original') }]);
    const out = readTar(tar);
    expect(new TextDecoder().decode(out[0].bytes)).toBe('original');
    // Mutating the entire source buffer must not alter the returned entry bytes.
    tar.fill(0);
    expect(new TextDecoder().decode(out[0].bytes)).toBe('original');
  });

  it('filters out non-regular entries (symlinks, hardlinks)', () => {
    const tar = buildTar([
      { name: 'package/link', data: new Uint8Array(0), typeflag: '2' },
      { name: 'package/hard', data: new Uint8Array(0), typeflag: '1' },
      { name: 'package/real.txt', data: bytes('R') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('real.txt');
  });

  it('does not throw on a truncated archive (nanotar parses leniently)', () => {
    const tar = buildTar([{ name: 'package/a', data: bytes('hello world') }]);
    const truncated = tar.slice(0, 700);
    expect(() => readTar(truncated)).not.toThrow();
  });

  it('returns no entries for non-tar garbage input', () => {
    const garbage = new Uint8Array(2048);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 31) & 0xff;
    expect(readTar(garbage)).toHaveLength(0);
  });

  it('throws when input is not a Uint8Array', () => {
    // @ts-expect-error intentional bad input
    expect(() => readTar('not bytes')).toThrow(/Uint8Array/);
  });

  it('honors PAX path overrides with multibyte UTF-8 paths (byte-length record framing)', () => {
    // Multibyte path: each kanji is 3 UTF-8 bytes, so JS string length and byte
    // length differ. This catches PAX parsers that treat the record-length field
    // (a byte count) as a JS string index.
    const longPath = `package/${'漢'.repeat(40)}/file.txt`;
    const recordBytes = paxRecord('path', longPath);
    const tar = buildTar([
      { name: 'package/PaxHeader/file', data: recordBytes, typeflag: 'x' },
      { name: 'package/placeholder.txt', data: bytes('utf8') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(longPath.replace(/^package\//, ''));
    expect(new TextDecoder().decode(out[0].bytes)).toBe('utf8');
  });

  it('parses multiple PAX records back-to-back when paths contain multibyte characters', () => {
    const longPath = `package/${'好'.repeat(35)}/file.bin`;
    const enc = new TextEncoder();
    const sizeRec = paxRecord('size', '4');
    const pathRec = paxRecord('path', longPath);
    const combined = new Uint8Array(sizeRec.length + pathRec.length);
    combined.set(sizeRec, 0);
    combined.set(pathRec, sizeRec.length);
    const tar = buildTar([
      { name: 'package/PaxHeader/file', data: combined, typeflag: 'x' },
      { name: 'package/placeholder.txt', data: enc.encode('data') },
    ]);
    const out = readTar(tar);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(longPath.replace(/^package\//, ''));
  });

  it('returns no entries for input shorter than a full header block', () => {
    expect(readTar(new Uint8Array(100))).toHaveLength(0);
  });

  it('strips the package/ prefix but leaves other prefixes alone', () => {
    const tar = buildTar([
      { name: 'package/file-a', data: bytes('a') },
      { name: 'other/file-b', data: bytes('b') },
    ]);
    const out = readTar(tar);
    const byPath = new Map(out.map((e) => [e.path, new TextDecoder().decode(e.bytes)]));
    expect(byPath.get('file-a')).toBe('a');
    expect(byPath.get('other/file-b')).toBe('b');
  });
});
