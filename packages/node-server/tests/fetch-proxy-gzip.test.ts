import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  bufferStartsWithGzipMagic,
  contentEncodingLooksUncompressed,
  createMaybeGunzipStream,
  GZIP_MAGIC_0,
  GZIP_MAGIC_1,
} from '../src/fetch-proxy-gzip.js';

const PLAIN_JS = 'export const aem = 1;\n';

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function pipeThrough(src: Readable): Readable {
  return src.pipe(createMaybeGunzipStream());
}

describe('fetch-proxy gzip sniff', () => {
  it('treats missing and identity encodings as uncompressed declarations', () => {
    expect(contentEncodingLooksUncompressed(null)).toBe(true);
    expect(contentEncodingLooksUncompressed(undefined)).toBe(true);
    expect(contentEncodingLooksUncompressed('')).toBe(true);
    expect(contentEncodingLooksUncompressed('identity')).toBe(true);
    expect(contentEncodingLooksUncompressed(' Identity ')).toBe(true);
    expect(contentEncodingLooksUncompressed('gzip')).toBe(false);
    expect(contentEncodingLooksUncompressed('br')).toBe(false);
  });

  it('detects gzip magic and rejects shorter prefixes', () => {
    expect(bufferStartsWithGzipMagic(Buffer.from([GZIP_MAGIC_0, GZIP_MAGIC_1, 0x08]))).toBe(true);
    expect(bufferStartsWithGzipMagic(Buffer.from([GZIP_MAGIC_0]))).toBe(false);
    expect(bufferStartsWithGzipMagic(Buffer.from([0x00, 0x00]))).toBe(false);
    expect(bufferStartsWithGzipMagic(Buffer.from(PLAIN_JS, 'utf8'))).toBe(false);
  });

  it('gunzips a body that starts with magic when encoding is absent', async () => {
    const gz = gzipSync(PLAIN_JS);
    expect(bufferStartsWithGzipMagic(gz)).toBe(true);
    const out = await collect(pipeThrough(Readable.from([gz])));
    expect(out.toString('utf8')).toBe(PLAIN_JS);
    expect(bufferStartsWithGzipMagic(out)).toBe(false);
  });

  it('gunzips when encoding is identity (AEM/Fastly identity-cache shape)', async () => {
    const gz = gzipSync(PLAIN_JS);
    const out = await collect(pipeThrough(Readable.from([gz])));
    expect(out.toString('utf8')).toBe(PLAIN_JS);
  });

  it('gunzips when the magic is split across chunks', async () => {
    const gz = gzipSync(PLAIN_JS);
    const src = Readable.from([gz.subarray(0, 1), gz.subarray(1)]);
    const out = await collect(pipeThrough(src));
    expect(out.toString('utf8')).toBe(PLAIN_JS);
  });

  it('passes identity/plain bytes through unchanged', async () => {
    const plain = Buffer.from(PLAIN_JS, 'utf8');
    const out = await collect(pipeThrough(Readable.from([plain])));
    expect(out.equals(plain)).toBe(true);
  });

  it('gunzips declared gzip too, so a client that did not auto-decompress still yields JS', async () => {
    const gz = gzipSync(PLAIN_JS);
    const out = await collect(pipeThrough(Readable.from([gz])));
    expect(out.toString('utf8')).toBe(PLAIN_JS);
  });

  it('errors on truncated gzip rather than forwarding magic bytes', async () => {
    const gz = gzipSync(PLAIN_JS);
    const truncated = gz.subarray(0, 8);
    await expect(collect(pipeThrough(Readable.from([truncated])))).rejects.toThrow();
  });

  it('reports inflating before decoded bytes are pushed', async () => {
    const decided: boolean[] = [];
    const gz = gzipSync(PLAIN_JS);
    const out = await collect(
      Readable.from([gz]).pipe(createMaybeGunzipStream({ onDecided: (v) => decided.push(v) }))
    );
    expect(decided).toEqual([true]);
    expect(out.toString('utf8')).toBe(PLAIN_JS);
  });

  it('reports not-inflating for identity/plain', async () => {
    const decided: boolean[] = [];
    await collect(
      Readable.from([Buffer.from(PLAIN_JS)]).pipe(
        createMaybeGunzipStream({ onDecided: (v) => decided.push(v) })
      )
    );
    expect(decided).toEqual([false]);
  });
});
