/**
 * Pins {@link encodeBinaryForTransport} / {@link decodeBinaryForTransport}
 * — the codec the chrome.runtime KernelTransport adapters use to
 * preserve `Uint8Array` payloads across the JSON-serialising
 * `chrome.runtime.sendMessage` boundary (review comment 3362777636 on
 * PR #876).
 *
 * Regression posture:
 *   - bytes survive a `JSON.parse(JSON.stringify(encode(...)))` round
 *     trip with the original `Uint8Array` shape intact;
 *   - the codec is idempotent on plain values (no `Uint8Array` in tree);
 *   - nested objects / arrays are walked recursively;
 *   - empty / large buffers (>64KB chunked path in the codec) round
 *     trip without truncation.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBinaryForTransport,
  encodeBinaryForTransport,
} from '../../src/kernel/transport-binary-codec.js';

function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('transport-binary-codec', () => {
  it('round-trips a top-level Uint8Array through JSON serialisation', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0xff]);
    const encoded = encodeBinaryForTransport(bytes);
    // The encoded form is a plain JSON-friendly object.
    expect(encoded).toMatchObject({ __slicc_binary__: 'b64' });
    const wire = jsonRoundTrip(encoded);
    const decoded = decodeBinaryForTransport(wire);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f, 0xff]);
  });

  it('round-trips a Uint8Array nested under an envelope shape', () => {
    // Same shape the VFS RPC uses on the wire: a request envelope with
    // a `data: Uint8Array` field under encoding=binary.
    const envelope = {
      source: 'panel',
      payload: {
        type: 'vfs-write-file',
        requestId: 'r1',
        path: '/image.png',
        encoding: 'binary',
        data: new Uint8Array([1, 2, 3, 4, 5]),
      },
    };
    const wire = jsonRoundTrip(encodeBinaryForTransport(envelope));
    const decoded = decodeBinaryForTransport(wire) as typeof envelope;
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.payload.data)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded.payload.path).toBe('/image.png');
    expect(decoded.payload.requestId).toBe('r1');
    expect(decoded.payload.encoding).toBe('binary');
  });

  it('round-trips a Uint8Array inside arrays', () => {
    const value = {
      entries: [
        { name: 'a', body: new Uint8Array([7, 8]) },
        { name: 'b', body: 'plain' },
      ],
    };
    const wire = jsonRoundTrip(encodeBinaryForTransport(value));
    const decoded = decodeBinaryForTransport(wire) as typeof value;
    expect(decoded.entries[0].body).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.entries[0].body as Uint8Array)).toEqual([7, 8]);
    expect(decoded.entries[1].body).toBe('plain');
  });

  it('passes plain envelopes through unchanged', () => {
    const envelope = {
      source: 'panel',
      payload: {
        type: 'vfs-write-file',
        requestId: 'r2',
        path: '/notes.md',
        encoding: 'utf-8',
        data: 'hello world',
      },
    };
    const wire = jsonRoundTrip(encodeBinaryForTransport(envelope));
    expect(decodeBinaryForTransport(wire)).toEqual(envelope);
  });

  it('handles empty Uint8Array', () => {
    const wire = jsonRoundTrip(encodeBinaryForTransport(new Uint8Array(0)));
    const decoded = decodeBinaryForTransport(wire);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect((decoded as Uint8Array).byteLength).toBe(0);
  });

  it('handles >64KB Uint8Array (chunked base64 path)', () => {
    const bytes = new Uint8Array(70_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const wire = jsonRoundTrip(encodeBinaryForTransport(bytes));
    const decoded = decodeBinaryForTransport(wire);
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect((decoded as Uint8Array).byteLength).toBe(bytes.byteLength);
    for (let i = 0; i < bytes.length; i++) {
      if ((decoded as Uint8Array)[i] !== bytes[i]) {
        throw new Error(`byte mismatch at ${i}`);
      }
    }
  });

  it('decode is a no-op on values without the sentinel', () => {
    expect(decodeBinaryForTransport(null)).toBeNull();
    expect(decodeBinaryForTransport(42)).toBe(42);
    expect(decodeBinaryForTransport('hi')).toBe('hi');
    expect(decodeBinaryForTransport({ a: 1, b: [2, 3] })).toEqual({ a: 1, b: [2, 3] });
  });
});
