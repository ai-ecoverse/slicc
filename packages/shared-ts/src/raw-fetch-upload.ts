import { isTextRequestContentType } from './content-type.js';
import {
  foldRawRequestHeaders,
  RAW_FETCH_STREAM_THRESHOLD_BYTES,
  type RawHeaderList,
} from './raw-fetch-protocol.js';
import { HMAC_SIGN_HEADER } from './secrets-pipeline.js';

export type UploadChunkSource = () => Promise<Uint8Array | null>;

export interface RetryableUpload {
  stream(): ReadableStream<Uint8Array>;

  untouched(): boolean;
}

export function createRetryableUpload(source: UploadChunkSource): RetryableUpload {
  const ready: Array<Uint8Array | null> = [];
  let inflight: Promise<void> | null = null;
  let delivered = 0;
  let generation = 0;

  const fill = (): Promise<void> => {
    inflight ??= source()
      .then((chunk) => {
        ready.push(chunk);
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const stream = (): ReadableStream<Uint8Array> => {
    const own = ++generation;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (ready.length === 0) await fill();
          if (own !== generation) return;
          const chunk = ready[0];
          if (chunk === null || chunk === undefined) {
            controller.close();
            return;
          }
          ready.shift();
          delivered += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
  };

  return { stream, untouched: () => delivered === 0 };
}

export function readerSource(stream: ReadableStream<Uint8Array>): UploadChunkSource {
  const reader = stream.getReader();
  return async () => {
    const { done, value } = await reader.read();
    return done ? null : value;
  };
}

export function rawUploadStreams(input: {
  headers: RawHeaderList;
  bodyLength: number | undefined;
  canStream: boolean;
}): boolean {
  if (!input.canStream) return false;
  const headers = foldRawRequestHeaders(input.headers);
  if (headers[HMAC_SIGN_HEADER] !== undefined) return false;
  if (isTextRequestContentType(headers['content-type'] ?? '')) return false;
  return input.bodyLength === undefined || input.bodyLength >= RAW_FETCH_STREAM_THRESHOLD_BYTES;
}

export function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  try {
    const hasContentType = new Request('https://example.invalid/', {
      body: new ReadableStream(),
      method: 'POST',
      get duplex() {
        duplexAccessed = true;
        return 'half';
      },
    } as RequestInit).headers.has('Content-Type');
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
}

export function isUnsentRefusal(
  err: unknown,
  upload: RetryableUpload,
  signal?: AbortSignal
): boolean {
  return err instanceof TypeError && upload.untouched() && !signal?.aborted;
}

export async function withUnsentUploadRetry<T>(
  source: UploadChunkSource,
  attempt: (body: ReadableStream<Uint8Array>) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const upload = createRetryableUpload(source);
  try {
    return await attempt(upload.stream());
  } catch (err) {
    if (!isUnsentRefusal(err, upload, signal)) throw err;
    return await attempt(upload.stream());
  }
}
