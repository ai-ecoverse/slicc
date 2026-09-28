import { describe, expect, it } from 'vitest';
import {
  createRetryableUpload,
  readerSource,
  supportsRequestStreams,
  type UploadChunkSource,
  withUnsentUploadRetry,
} from '../src/raw-fetch-upload.js';

/**
 * A source whose chunks arrive only when the test releases them. Reads are
 * served in call order, like `ReadableStreamDefaultReader.read()`, so two
 * outstanding reads would each take a different chunk.
 */
function gatedSource() {
  const ready: Array<Uint8Array | null> = [];
  const readers: Array<(chunk: Uint8Array | null) => void> = [];
  const source: UploadChunkSource = () =>
    ready.length > 0
      ? Promise.resolve(ready.shift() ?? null)
      : new Promise((resolve) => readers.push(resolve));
  const push = (chunk: Uint8Array | null) => {
    const reader = readers.shift();
    if (reader) reader(chunk);
    else ready.push(chunk);
  };
  return { source, push };
}

const bytes = (...values: number[]) => new Uint8Array(values);

async function drain(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())];
}

describe('createRetryableUpload', () => {
  it('counts what an attempt handed on', async () => {
    const chunks = [bytes(1), bytes(2), null];
    const upload = createRetryableUpload(async () => chunks.shift() ?? null);
    expect(upload.untouched()).toBe(true);
    expect(await drain(upload.stream())).toEqual([1, 2]);
    expect(upload.untouched()).toBe(false);
  });

  it('keeps a chunk a stale attempt read but never handed on, in order', async () => {
    const { source, push } = gatedSource();
    const upload = createRetryableUpload(source);
    const stale = upload.stream().getReader();
    const pendingStale = stale.read();
    const retry = drain(upload.stream());
    push(bytes(1));
    push(bytes(2));
    push(null);
    expect(await retry).toEqual([1, 2]);
    void pendingStale;
  });
});

describe('withUnsentUploadRetry', () => {
  it('retries once when the first attempt was refused before reading', async () => {
    const chunks = [bytes(4), bytes(5), null];
    let attempts = 0;
    const result = await withUnsentUploadRetry(
      async () => chunks.shift() ?? null,
      async (body) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return drain(body);
      }
    );
    expect(result).toEqual([4, 5]);
    expect(attempts).toBe(2);
  });

  it('never retries once the body started, nor other errors, nor after an abort', async () => {
    const started = [bytes(1), bytes(2), null];
    let attempts = 0;
    await expect(
      withUnsentUploadRetry(
        async () => started.shift() ?? null,
        async (body) => {
          attempts += 1;
          await body.getReader().read();
          throw new TypeError('reset mid-upload');
        }
      )
    ).rejects.toThrow('reset mid-upload');
    expect(attempts).toBe(1);

    attempts = 0;
    await expect(
      withUnsentUploadRetry(
        async () => null,
        async () => {
          attempts += 1;
          throw new Error('not the refusal');
        }
      )
    ).rejects.toThrow('not the refusal');
    expect(attempts).toBe(1);

    const controller = new AbortController();
    controller.abort();
    attempts = 0;
    await expect(
      withUnsentUploadRetry(
        async () => null,
        async () => {
          attempts += 1;
          throw new TypeError('aborted');
        },
        controller.signal
      )
    ).rejects.toThrow('aborted');
    expect(attempts).toBe(1);
  });

  it('gives up after the one retry', async () => {
    let attempts = 0;
    await expect(
      withUnsentUploadRetry(
        async () => null,
        async () => {
          attempts += 1;
          throw new TypeError('down');
        }
      )
    ).rejects.toThrow('down');
    expect(attempts).toBe(2);
  });
});

describe('helpers', () => {
  it('reads a byte stream as a chunk source', async () => {
    const source = readerSource(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes(9));
          c.close();
        },
      })
    );
    expect(await source()).toEqual(bytes(9));
    expect(await source()).toBeNull();
  });

  it('detects request-body streaming', () => {
    expect(typeof supportsRequestStreams()).toBe('boolean');
  });
});
