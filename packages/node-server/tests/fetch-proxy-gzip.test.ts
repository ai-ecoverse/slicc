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

  it('handles empty and one-byte plain bodies at EOF', async () => {
    const emptyDecisions: boolean[] = [];
    expect(
      await collect(
        Readable.from([]).pipe(
          createMaybeGunzipStream({ onDecided: (value) => emptyDecisions.push(value) })
        )
      )
    ).toEqual(Buffer.alloc(0));
    expect(emptyDecisions).toEqual([false]);

    const oneByte = await collect(pipeThrough(Readable.from([Buffer.from('x')])));
    expect(oneByte.toString()).toBe('x');
  });

  it('handles additional chunks after deciding plain or gzip', async () => {
    const plain = await collect(
      pipeThrough(Readable.from([Buffer.from('pl'), Buffer.from('ain'), Buffer.from('!')]))
    );
    expect(plain.toString()).toBe('plain!');

    const gz = gzipSync(PLAIN_JS);
    const decoded = await collect(
      pipeThrough(Readable.from([gz.subarray(0, 2), gz.subarray(2, 5), gz.subarray(5)]))
    );
    expect(decoded.toString()).toBe(PLAIN_JS);
  });

  it('propagates a gzip error encountered after the initial decision', async () => {
    const corrupt = Buffer.concat([Buffer.from([GZIP_MAGIC_0, GZIP_MAGIC_1]), Buffer.alloc(12)]);
    await expect(
      collect(pipeThrough(Readable.from([corrupt.subarray(0, 2), corrupt.subarray(2)])))
    ).rejects.toThrow();
  });

  it('pauses and resumes the inner gunzip when downstream applies backpressure', async () => {
    const transform = createMaybeGunzipStream();
    const originalPush = transform.push.bind(transform);
    let forcedBackpressure = false;
    transform.push = ((chunk: unknown, encoding?: BufferEncoding) => {
      const accepted = originalPush(chunk, encoding);
      if (chunk !== null && !forcedBackpressure) {
        forcedBackpressure = true;
        setImmediate(() => transform.resume());
        return false;
      }
      return accepted;
    }) as typeof transform.push;
    const collected = collect(Readable.from([gzipSync(PLAIN_JS)]).pipe(transform));
    expect((await collected).toString()).toBe(PLAIN_JS);
    expect(forcedBackpressure).toBe(true);
  });
});
