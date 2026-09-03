import { describe, expect, it } from 'vitest';
import { prepareRequestBody } from '../../src/shell/proxied-fetch.js';

/**
 * Regression: binary request bodies (git packfiles, ZIPs, octet-stream) must
 * survive `prepareRequestBody` without UTF-8 re-encoding. Upstream callers
 * (e.g. git-http.ts) thread bytes through `SecureFetch`'s `body: string`
 * contract by converting Uint8Array → latin1 string (one char per byte).
 * If `prepareRequestBody` returns that string raw, `fetch()` UTF-8-encodes
 * it and every byte ≥0x80 expands to 2 bytes — git push silently corrupts
 * packfiles for any repo with deflated objects.
 */

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('prepareRequestBody — binary content-type preservation', () => {
  // A synthetic packfile-shaped buffer: low bytes mixed with high bytes
  // (0x80..0xFF). Real packfiles are zlib-deflated so most bytes ≥0x80.
  const packBytes = new Uint8Array([
    0x50,
    0x41,
    0x43,
    0x4b, // "PACK" signature
    0x00,
    0x00,
    0x00,
    0x02, // version
    0xff,
    0xfe,
    0xfd,
    0xfc, // arbitrary high bytes
    0x80,
    0x81,
    0xc3,
    0x28, // invalid-UTF-8 sequence
    0xa0,
    0x80,
    0xe0,
    0x80, // overlong / continuation bytes
  ]);

  it('git push: application/x-git-receive-pack-request returns a Blob with bytes intact', async () => {
    const body = bytesToLatin1(packBytes);
    const result = prepareRequestBody(body, {
      'Content-Type': 'application/x-git-receive-pack-request',
    });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(packBytes));
  });

  it('git clone/fetch: application/x-git-upload-pack-request returns a Blob with bytes intact', async () => {
    const body = bytesToLatin1(packBytes);
    const result = prepareRequestBody(body, {
      'Content-Type': 'application/x-git-upload-pack-request',
    });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(packBytes));
  });

  it('application/octet-stream preserves arbitrary bytes', async () => {
    const body = bytesToLatin1(packBytes);
    const result = prepareRequestBody(body, { 'Content-Type': 'application/octet-stream' });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(packBytes));
  });

  it('matches an uppercase binary Content-Type header and preserves arbitrary bytes', async () => {
    const body = bytesToLatin1(packBytes);
    const result = prepareRequestBody(body, { 'CONTENT-TYPE': 'application/octet-stream' });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(packBytes));
  });

  it('multipart/form-data still returns a Blob (pre-existing behavior)', async () => {
    const body = bytesToLatin1(packBytes);
    const result = prepareRequestBody(body, {
      'Content-Type': 'multipart/form-data; boundary=---x',
    });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(packBytes));
  });

  it('text/plain returns the string unchanged (no Blob wrap)', () => {
    const result = prepareRequestBody('hello world', { 'Content-Type': 'text/plain' });
    expect(result).toBe('hello world');
  });

  it('application/json returns the string unchanged', () => {
    const json = '{"foo": "bar"}';
    const result = prepareRequestBody(json, { 'Content-Type': 'application/json' });
    expect(result).toBe(json);
  });

  it('empty content-type defaults to text (no Blob wrap)', () => {
    const result = prepareRequestBody('plain text');
    expect(result).toBe('plain text');
  });

  it('undefined body returns undefined', () => {
    expect(prepareRequestBody(undefined)).toBeUndefined();
  });

  it('Uint8Array wraps as a Blob even without a Content-Type (jsh fetch path)', async () => {
    // A latin1 string with no CT is left as a string so `fetch()` UTF-8-encodes
    // text. A Uint8Array is already bytes — wrapping it must not depend on CT,
    // or JPEG `FF D8` becomes `C3 BF C3 98`.
    const probe = new Uint8Array([0xff, 0xd8, 0xff, 0x98, 0x00, 0x41, 0x7f, 0x80, 0xfe]);
    const result = prepareRequestBody(probe);
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(probe));
  });

  it('Uint8Array is not UTF-8-expanded even under a text Content-Type', async () => {
    const probe = new Uint8Array([0xff, 0xd8, 0xff, 0x98, 0x00, 0x41, 0x7f, 0x80, 0xfe]);
    const result = prepareRequestBody(probe, { 'Content-Type': 'text/plain' });
    expect(result).toBeInstanceOf(Blob);
    const out = await blobBytes(result as Blob);
    expect(Array.from(out)).toEqual(Array.from(probe));
  });
});
