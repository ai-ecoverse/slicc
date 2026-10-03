import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bytesToHex, compactArrayBuffer, sha256Hex } from '../src/sha256.js';

/** NIST FIPS 180-4 SHA-256("abc"). */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('bytesToHex', () => {
  it('encodes empty, single-nibble, and full-range bytes as lowercase hex', () => {
    expect(bytesToHex(new Uint8Array())).toBe('');
    expect(bytesToHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff');
  });

  it('encodes an offset view as the slice, not the backing buffer', () => {
    const padded = new Uint8Array([0xaa, 0x0f, 0x10, 0xbb]);
    expect(bytesToHex(padded.subarray(1, 3))).toBe('0f10');
  });
});

describe('sha256Hex', () => {
  it('hashes the NIST abc vector as UTF-8 and as those bytes', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex('abc')).toBe(SHA256_ABC);
    expect(await sha256Hex(bytes)).toBe(SHA256_ABC);
    expect(await sha256Hex(bytes.buffer)).toBe(SHA256_ABC);
  });

  it('hashes an offset Uint8Array the same as a copy of the same bytes', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = backing.subarray(2, 6);
    const copy = view.slice();
    expect(view.byteOffset).toBeGreaterThan(0);
    expect(await sha256Hex(view)).toBe(await sha256Hex(copy));
    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([2, 3, 4, 5])));
  });

  it('does not match hashing the view backing buffer (the old BufferSource drift)', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = backing.subarray(2, 6);
    const wholeBufferHex = bytesToHex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer))
    );
    const castBufferHex = bytesToHex(
      new Uint8Array(await crypto.subtle.digest('SHA-256', view.buffer as unknown as BufferSource))
    );
    expect(await sha256Hex(view)).not.toBe(wholeBufferHex);
    expect(await sha256Hex(view)).not.toBe(castBufferHex);
    expect(compactArrayBuffer(view).byteLength).toBe(view.byteLength);
    expect(compactArrayBuffer(view).byteLength).not.toBe(view.buffer.byteLength);
  });

  it('hashes ArrayBuffer and Uint8Array values from another vm realm', async () => {
    const ctx = createContext();
    const foreignBuffer = runInContext('new ArrayBuffer(4)', ctx);
    expect(foreignBuffer instanceof ArrayBuffer).toBe(false);
    new Uint8Array(foreignBuffer).set([2, 3, 4, 5]);
    const local = new Uint8Array([2, 3, 4, 5]);
    expect(await sha256Hex(foreignBuffer as ArrayBuffer)).toBe(await sha256Hex(local));

    const foreignView = runInContext(
      'new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).subarray(2, 6)',
      ctx
    );
    expect(foreignView instanceof Uint8Array).toBe(false);
    expect(ArrayBuffer.isView(foreignView)).toBe(true);
    expect(await sha256Hex(foreignView as Uint8Array)).toBe(await sha256Hex(local));
  });
});
