import { describe, expect, it } from 'vitest';
import { parseNpy, parseSingleEntryNpz } from '../../src/speech/npz.js';

/** Build a v1.0 `.npy` buffer for a little-endian float32 C-order array. */
function makeNpy(shape: number[], data: Float32Array, descr = '<f4'): Uint8Array {
  const shapeStr =
    shape.length === 1 ? `(${shape[0]},)` : `(${shape.map((n) => `${n}`).join(', ')})`;
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': ${shapeStr}, }`;
  // Pad so magic(6)+ver(2)+len(2)+header is a multiple of 64, ending in \n.
  const pre = 10 + header.length + 1;
  header += ' '.repeat((64 - (pre % 64)) % 64) + '\n';
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(10 + headerBytes.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0); // \x93NUMPY raw bytes
  out[6] = 1;
  out[7] = 0;
  new DataView(out.buffer).setUint16(8, headerBytes.length, true);
  out.set(headerBytes, 10);
  out.set(new Uint8Array(data.buffer.slice(0)), 10 + headerBytes.length);
  return out;
}

/** Wrap `content` in a STORED ZIP local-file-header (method 0). */
function makeStoredZip(name: string, content: Uint8Array, method = 0): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(30 + nameBytes.length + content.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true); // PK\x03\x04
  view.setUint16(8, method, true);
  view.setUint32(18, content.length, true); // compressed size
  view.setUint32(22, content.length, true); // uncompressed size
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(content, 30 + nameBytes.length);
  return out;
}

describe('parseNpy', () => {
  it('decodes shape and data for a 3-D float32 array', () => {
    const data = Float32Array.from([1, 2, 3, 4, 5, 6]);
    const result = parseNpy(makeNpy([1, 2, 3], data));
    expect(result.shape).toEqual([1, 2, 3]);
    expect(Array.from(result.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('decodes a 1-D array (trailing-comma shape)', () => {
    const result = parseNpy(makeNpy([4], Float32Array.from([0.5, -0.5, 0.25, -0.25])));
    expect(result.shape).toEqual([4]);
    expect(Array.from(result.data)).toEqual([0.5, -0.5, 0.25, -0.25]);
  });

  it('rejects a non-npy buffer', () => {
    expect(() => parseNpy(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))).toThrow(/bad magic/);
  });

  it('rejects a big-endian dtype', () => {
    expect(() => parseNpy(makeNpy([2], Float32Array.from([1, 2]), '>f4'))).toThrow(
      /unsupported dtype/
    );
  });

  it('rejects truncated data', () => {
    const full = makeNpy([10], new Float32Array(10));
    expect(() => parseNpy(full.subarray(0, full.length - 8))).toThrow(/truncated/);
  });
});

describe('parseSingleEntryNpz', () => {
  it('reads the single STORED entry and decodes it', () => {
    const data = Float32Array.from([10, 20, 30, 40]);
    const npz = makeStoredZip('martin.npy', makeNpy([2, 2], data));
    const result = parseSingleEntryNpz(npz);
    expect(result.shape).toEqual([2, 2]);
    expect(Array.from(result.data)).toEqual([10, 20, 30, 40]);
  });

  it('matches the Kokoro voice shape (style matrix slice math)', () => {
    // (3, 1, 4) stand-in for the real (510, 1, 256) — index by token count.
    const flat = Float32Array.from(Array.from({ length: 12 }, (_, i) => i));
    const result = parseSingleEntryNpz(makeStoredZip('martin.npy', makeNpy([3, 1, 4], flat)));
    expect(result.shape).toEqual([3, 1, 4]);
    expect(Array.from(result.data.subarray(4, 8))).toEqual([4, 5, 6, 7]);
  });

  it('rejects a non-ZIP buffer', () => {
    expect(() => parseSingleEntryNpz(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a ZIP/);
  });

  it('rejects a DEFLATE-compressed entry with actionable guidance', () => {
    const npz = makeStoredZip('martin.npy', makeNpy([2], Float32Array.from([1, 2])), 8);
    expect(() => parseSingleEntryNpz(npz)).toThrow(/STORED/);
  });
});
