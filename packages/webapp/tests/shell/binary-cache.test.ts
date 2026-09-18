import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { cacheBinaryBody, consumeCachedBinary } from '../../src/shell/binary-cache.js';
import { readResponseBody } from '../../src/shell/proxied-fetch.js';
import { VfsAdapter } from '../../src/shell/vfs-adapter.js';

function latin1FromBytes(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

describe('binary-cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores and retrieves binary data', () => {
    const body = 'hello';
    const bytes = new Uint8Array([104, 101, 108, 108, 111]);
    cacheBinaryBody(body, bytes);
    const result = consumeCachedBinary(body);
    expect(result).toEqual(bytes);
  });

  it('returns null for uncached strings', () => {
    expect(consumeCachedBinary('not-cached')).toBeNull();
  });

  it('consumes entry on first retrieval (single-use)', () => {
    const body = 'test';
    const bytes = new Uint8Array([1, 2, 3]);
    cacheBinaryBody(body, bytes);
    expect(consumeCachedBinary(body)).toEqual(bytes);
    expect(consumeCachedBinary(body)).toBeNull();
  });

  it('handles empty string body', () => {
    const bytes = new Uint8Array([]);
    cacheBinaryBody('', bytes);
    const result = consumeCachedBinary('');
    expect(result).toEqual(bytes);
  });

  it('handles binary data with all byte values', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const latin1 = Array.from(bytes, (b) => String.fromCharCode(b)).join('');

    cacheBinaryBody(latin1, bytes);
    const result = consumeCachedBinary(latin1);
    expect(result).toEqual(bytes);
  });

  it('auto-expires entries after 10 seconds', () => {
    const body = 'expiring';
    const bytes = new Uint8Array([42]);
    cacheBinaryBody(body, bytes);

    vi.advanceTimersByTime(9999);
    expect(consumeCachedBinary(body)).toEqual(bytes);

    cacheBinaryBody(body, bytes);
    vi.advanceTimersByTime(10001);
    expect(consumeCachedBinary(body)).toBeNull();
  });

  it('supports multiple concurrent entries with different keys', () => {
    const body1 = 'short';
    const bytes1 = new Uint8Array([1, 2, 3]);
    const body2 = 'a much longer string that differs significantly';
    const bytes2 = new Uint8Array([4, 5, 6]);

    cacheBinaryBody(body1, bytes1);
    cacheBinaryBody(body2, bytes2);

    expect(consumeCachedBinary(body1)).toEqual(bytes1);
    expect(consumeCachedBinary(body2)).toEqual(bytes2);
  });
});

describe('binary-cache round-trip through readResponseBody + writeFile', () => {
  let vfs: VirtualFS;
  let adapter: VfsAdapter;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-binary-cache-rt-${dbCounter++}`, wipe: true });
    adapter = new VfsAdapter(vfs);
  });

  function allByteValues(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(new ArrayBuffer(256));
    for (let i = 0; i < 256; i++) bytes[i] = i;
    return bytes;
  }

  it('no-URL path: string cache yields byte-exact write', async () => {
    const bytes = allByteValues();
    const resp = new Response(bytes.buffer, {
      headers: { 'content-type': 'application/octet-stream' },
    });

    const returned = await readResponseBody(resp);
    expect(Array.from(returned)).toEqual(Array.from(bytes));

    const latin1 = latin1FromBytes(bytes);
    await adapter.writeFile('/no-url.bin', latin1, 'binary');
    const written = (await vfs.readFile('/no-url.bin', { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });

  it('URL path: explicit binary write remains byte-exact without a string cache', async () => {
    const bytes = allByteValues();
    const resp = new Response(bytes.buffer, {
      headers: { 'content-type': 'application/octet-stream' },
    });

    const returned = await readResponseBody(resp, 'https://example.com/pkg.zip');
    expect(Array.from(returned)).toEqual(Array.from(bytes));

    const latin1 = latin1FromBytes(bytes);

    expect(consumeCachedBinary(latin1)).toBeNull();

    await adapter.writeFile('/url.bin', latin1, 'binary');
    const written = (await vfs.readFile('/url.bin', { encoding: 'binary' })) as Uint8Array;
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });
});
