import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64ToUint8, uint8ToBase64 } from '../src/base64.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

function withoutBuffer<T>(fn: () => T): T {
  const g = globalThis as { Buffer?: unknown };
  const saved = g.Buffer;
  delete g.Buffer;
  try {
    return fn();
  } finally {
    g.Buffer = saved;
  }
}

// Normalise to a plain `Uint8Array` for `toEqual` comparisons. `Buffer`
// extends `Uint8Array` (so the runtime contract holds) but vitest's deep
// equal distinguishes the two prototypes, which would otherwise mask the
// fact that the bytes are identical.
function asPlain(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('base64 codec', () => {
  it('round-trips an empty Uint8Array', () => {
    const empty = new Uint8Array(0);
    expect(uint8ToBase64(empty)).toBe('');
    expect(asPlain(base64ToUint8(''))).toEqual(empty);
  });

  it('round-trips ASCII text via TextEncoder bytes', () => {
    const bytes = new TextEncoder().encode('hello, world!');
    const encoded = uint8ToBase64(bytes);
    expect(encoded).toBe('aGVsbG8sIHdvcmxkIQ==');
    expect(asPlain(base64ToUint8(encoded))).toEqual(bytes);
  });

  it('preserves arbitrary binary bytes (every byte value)', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = base64ToUint8(uint8ToBase64(bytes));
    expect(asPlain(decoded)).toEqual(bytes);
  });

  it('survives inputs larger than the chunk size (would stack-overflow the naive spread)', () => {
    // 128 KiB — well past the ~64 KiB call-stack ceiling that motivated
    // the chunked path; the original non-chunked copies in #1087 would
    // have thrown `RangeError: Maximum call stack size exceeded` here.
    const bytes = makeBytes(128 * 1024);
    const decoded = base64ToUint8(uint8ToBase64(bytes));
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(asPlain(decoded)).toEqual(bytes);
  });

  it('survives a multi-MB payload (CLI / mount-sized)', () => {
    const bytes = makeBytes(3 * 1024 * 1024);
    const decoded = base64ToUint8(uint8ToBase64(bytes));
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(decoded[0]).toBe(bytes[0]);
    expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1]);
  });
});

describe('base64 codec — universal fallback (no Buffer)', () => {
  // The fast-path test above exercises the Node Buffer branch in vitest's
  // default node env. This block forces the atob/btoa fallback so the
  // browser + extension-service-worker code path is covered too.
  let savedBuffer: unknown;

  beforeEach(() => {
    savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    delete (globalThis as { Buffer?: unknown }).Buffer;
  });
  afterEach(() => {
    (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
  });

  it('round-trips arbitrary binary bytes without the Node fast-path', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const decoded = base64ToUint8(uint8ToBase64(bytes));
    expect(asPlain(decoded)).toEqual(bytes);
  });

  it('survives inputs larger than the chunk size without the Node fast-path', () => {
    const bytes = makeBytes(128 * 1024);
    const decoded = base64ToUint8(uint8ToBase64(bytes));
    expect(asPlain(decoded)).toEqual(bytes);
  });
});

describe('base64 codec — strictness', () => {
  it('rejects malformed input under the Node fast-path (matches atob)', () => {
    // Without the strict-alphabet guard the Node `Buffer.from('base64')`
    // call would silently strip the non-alphabet bytes and return a
    // partial decode, which would let a malformed signed-fetch reply
    // slip past the transport's "decode failed" EIO surface.
    expect(() => base64ToUint8('!@#$%^&*()')).toThrow();
  });

  it('rejects malformed input under the atob fallback', () => {
    expect(() => withoutBuffer(() => base64ToUint8('!@#$%^&*()'))).toThrow();
  });

  it('returns a plain Uint8Array prototype (not Node Buffer)', () => {
    // Downstream callers (and vitest `.toEqual`) treat `Buffer` as a
    // distinct shape; the decoder normalises so callers see plain bytes.
    const decoded = base64ToUint8('aGVsbG8=');
    expect(Object.getPrototypeOf(decoded)).toBe(Uint8Array.prototype);
  });

  it('returns a standalone ArrayBuffer (not Node slab pool)', () => {
    // `Buffer.from(b64, 'base64')` for small inputs draws from Node's
    // shared pool, so the underlying `.buffer` would otherwise span
    // unrelated allocations. Callers that flow `.buffer` into a raw
    // `ArrayBuffer` downstream (proxied-fetch `response-chunk` collector)
    // depend on it being exactly the decoded bytes.
    const decoded = base64ToUint8('aGVsbG8=');
    expect(decoded.buffer.byteLength).toBe(decoded.byteLength);
  });
});

describe('base64 codec — fast-path parity', () => {
  it('Node Buffer path and atob/btoa path produce identical encodings', () => {
    const bytes = makeBytes(64 * 1024 + 17);
    const fast = uint8ToBase64(bytes);
    const fallback = withoutBuffer(() => uint8ToBase64(bytes));
    expect(fast).toBe(fallback);
  });

  it('Node Buffer path and atob/btoa path produce identical decodings', () => {
    const bytes = makeBytes(64 * 1024 + 17);
    const b64 = uint8ToBase64(bytes);
    const fast = base64ToUint8(b64);
    const fallback = withoutBuffer(() => base64ToUint8(b64));
    expect(asPlain(fallback)).toEqual(asPlain(fast));
  });
});
