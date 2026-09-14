import { describe, expect, it } from 'vitest';
import { prepareRequestBody } from '../../src/shell/proxied-fetch.js';

function bytesToLatin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('prepareRequestBody — binary content-type preservation', () => {
  const packBytes = new Uint8Array([
    0x50, 0x41, 0x43, 0x4b, 0x00, 0x00, 0x00, 0x02, 0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81, 0xc3, 0x28,
    0xa0, 0x80, 0xe0, 0x80,
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
