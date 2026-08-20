import { describe, expect, it } from 'vitest';
import {
  decodeSabResult,
  encodeSabResult,
  SAB_HEADER_BYTES,
  SAB_MIN_BYTES,
  SAB_STATUS_BYTES,
  SAB_STATUS_ERRNO,
  SAB_STATUS_JSON,
  SAB_STATUS_VOID,
  sabViews,
} from '../../../src/kernel/realm/sync-sab-wire.js';

describe('sync-sab wire — encode/decode', () => {
  it('round-trips every result kind', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(decodeSabResult(...spread(encodeSabResult({ ok: true, kind: 'bytes', bytes })))).toEqual(
      {
        ok: true,
        kind: 'bytes',
        bytes,
      }
    );
    expect(encodeSabResult({ ok: true, kind: 'bytes', bytes }).status).toBe(SAB_STATUS_BYTES);

    const json = { isFile: true, isDirectory: false, size: 7, names: ['a', 'ü'] };
    const enc = encodeSabResult({ ok: true, kind: 'json', json });
    expect(enc.status).toBe(SAB_STATUS_JSON);
    expect(decodeSabResult(...spread(enc))).toEqual({ ok: true, kind: 'json', json });

    const v = encodeSabResult({ ok: true, kind: 'void' });
    expect(v.status).toBe(SAB_STATUS_VOID);
    expect(v.payload.byteLength).toBe(0);
    expect(decodeSabResult(...spread(v))).toEqual({ ok: true, kind: 'void' });

    const e = encodeSabResult({ ok: false, errno: 'EACCES', message: 'denied' });
    expect(e.status).toBe(SAB_STATUS_ERRNO);
    expect(decodeSabResult(...spread(e))).toEqual({
      ok: false,
      errno: 'EACCES',
      message: 'denied',
    });
  });

  it('fails closed on malformed payloads and unknown statuses', () => {
    const junk = new TextEncoder().encode('{not json');
    expect(decodeSabResult(SAB_STATUS_JSON, junk)).toMatchObject({ ok: false, errno: 'EIO' });
    expect(decodeSabResult(SAB_STATUS_ERRNO, junk)).toMatchObject({ ok: false, errno: 'EIO' });
    // A non-errno-shaped code must not cross into the realm as `.code`.
    const bad = new TextEncoder().encode(JSON.stringify({ errno: 'boom!', message: 'x' }));
    expect(decodeSabResult(SAB_STATUS_ERRNO, bad)).toMatchObject({ ok: false, errno: 'EIO' });
    expect(decodeSabResult(99, new Uint8Array(0))).toMatchObject({ ok: false, errno: 'EIO' });
  });

  it('views split the buffer into a 64-byte header and the window', () => {
    const sab = new SharedArrayBuffer(SAB_MIN_BYTES);
    const { header, window } = sabViews(sab);
    expect(header.byteLength).toBe(SAB_HEADER_BYTES);
    expect(window.byteOffset).toBe(SAB_HEADER_BYTES);
    expect(window.byteLength).toBe(SAB_MIN_BYTES - SAB_HEADER_BYTES);
    expect(() => sabViews(new SharedArrayBuffer(16))).toThrow(/too small/);
  });
});

function spread(enc: { status: number; payload: Uint8Array }): [number, Uint8Array] {
  return [enc.status, enc.payload];
}
