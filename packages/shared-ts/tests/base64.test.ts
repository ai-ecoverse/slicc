import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64ToUint8, normalizeBase64, uint8ToBase64 } from '../src/base64.js';

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

function asPlain(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

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
    expect(() => base64ToUint8('!@#$%^&*()')).toThrow();
  });

  it('rejects malformed input under the atob fallback', () => {
    expect(() => withoutBuffer(() => base64ToUint8('!@#$%^&*()'))).toThrow();
  });

  it('rejects truncated input (length not a multiple of 4) under the Node fast-path', () => {
    expect(() => base64ToUint8('abcde')).toThrow();
  });

  it('rejects truncated input (length not a multiple of 4) under the atob fallback', () => {
    expect(() => withoutBuffer(() => base64ToUint8('abcde'))).toThrow();
  });

  it('rejects misplaced padding under the Node fast-path', () => {
    expect(() => base64ToUint8('abcd=')).toThrow();
  });

  it('rejects misplaced padding under the atob fallback', () => {
    expect(() => withoutBuffer(() => base64ToUint8('abcd='))).toThrow();
  });

  it('rejects over-padded input under the Node fast-path', () => {
    expect(() => base64ToUint8('a===')).toThrow();
  });

  it('rejects over-padded input under the atob fallback', () => {
    expect(() => withoutBuffer(() => base64ToUint8('a==='))).toThrow();
  });

  it('accepts every valid padding shape under both paths', () => {
    for (const valid of ['YWJj', 'YWI=', 'YQ==']) {
      expect(() => base64ToUint8(valid)).not.toThrow();
      expect(() => withoutBuffer(() => base64ToUint8(valid))).not.toThrow();
    }
  });

  it('returns a plain Uint8Array prototype (not Node Buffer)', () => {
    const decoded = base64ToUint8('aGVsbG8=');
    expect(Object.getPrototypeOf(decoded)).toBe(Uint8Array.prototype);
  });

  it('returns a standalone ArrayBuffer (not Node slab pool)', () => {
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

describe('normalizeBase64', () => {
  it('accepts a padded payload unchanged', () => {
    expect(normalizeBase64('YWJj')).toBe('YWJj');
    expect(normalizeBase64('YWI=')).toBe('YWI=');
    expect(normalizeBase64('YQ==')).toBe('YQ==');
  });

  it('strips the whitespace a wrapped payload carries', () => {
    expect(normalizeBase64('YW\nJ j')).toBe('YWJj');
    expect(normalizeBase64('YWJ\tj\r\n')).toBe('YWJj');
  });

  it('accepts an unpadded tail and leaves it unpadded', () => {
    expect(normalizeBase64('YWJjZA')).toBe('YWJjZA');
    expect(normalizeBase64('YWJjZGU')).toBe('YWJjZGU');
  });

  it('returns a string every decoder accepts', () => {
    const normalized = normalizeBase64('YWJjZA');
    expect(normalized).not.toBeNull();
    expect(() => base64ToUint8(normalized!)).not.toThrow();
    expect(new TextDecoder().decode(base64ToUint8(normalized!))).toBe('abcd');
  });

  it('decodes an unpadded payload identically on both paths', () => {
    const fast = base64ToUint8('YWJjZA');
    const fallback = withoutBuffer(() => base64ToUint8('YWJjZA'));
    expect(new TextDecoder().decode(fast)).toBe('abcd');
    expect(Array.from(fallback)).toEqual(Array.from(fast));
  });

  it('accepts the empty string', () => {
    expect(normalizeBase64('')).toBe('');
  });

  it('rejects a remainder of one character', () => {
    expect(normalizeBase64('abcde')).toBeNull();
  });

  it('rejects misplaced or excessive padding', () => {
    expect(normalizeBase64('abcd=')).toBeNull();
    expect(normalizeBase64('a===')).toBeNull();
    expect(normalizeBase64('ab==cd')).toBeNull();
  });

  it('rejects characters outside the standard alphabet', () => {
    expect(normalizeBase64('!@#$')).toBeNull();

    expect(normalizeBase64('ab-_')).toBeNull();
  });
});
