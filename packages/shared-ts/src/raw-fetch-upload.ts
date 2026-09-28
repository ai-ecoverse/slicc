/**
 * Streamed uploads for raw-mode fetches (#3571), shared by the floats that
 * stream a request body with `duplex: 'half'`: the extension service worker
 * and the webapp's page → node-server bridge hop.
 *
 * Chrome streams a request body over HTTP/1.1 (verified on Chrome for
 * Testing 146, loopback and HTTPS), but rejects the first streamed request
 * that needs a new connection before sending any of it: the origin sees no
 * request at all (measured with `credentials: 'omit'`, whose connections are
 * pooled apart). {@link withUnsentUploadRetry} retries exactly that case,
 * and nothing that may have reached the origin.
 */

import { isTextRequestContentType } from './content-type.js';
import {
  foldRawRequestHeaders,
  RAW_FETCH_STREAM_THRESHOLD_BYTES,
  type RawHeaderList,
} from './raw-fetch-protocol.js';
import { HMAC_SIGN_HEADER } from './secrets-pipeline.js';

/** Next upload chunk, `null` at the end. */
export type UploadChunkSource = () => Promise<Uint8Array | null>;

export interface RetryableUpload {
  /** A fresh body stream for one attempt. */
  stream(): ReadableStream<Uint8Array>;
  /** Whether no attempt has handed `fetch` a single byte yet. */
  untouched(): boolean;
}

/**
 * Body streams over one source for successive attempts. Source reads are
 * single-flight and land in a small buffer that only the newest attempt
 * takes from, so a stale attempt whose read is still pending cannot swallow
 * or reorder a chunk. Nothing an attempt delivered is kept: retrying is only
 * sound while {@link RetryableUpload.untouched} holds.
 */
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

/** Adapt a byte stream to an {@link UploadChunkSource}. */
export function readerSource(stream: ReadableStream<Uint8Array>): UploadChunkSource {
  const reader = stream.getReader();
  return async () => {
    const { done, value } = await reader.read();
    return done ? null : value;
  };
}

/**
 * Whether a raw upload streams rather than being buffered whole. Text bodies
 * are buffered so the float can unmask secrets in them, HMAC-signed ones so
 * it can sign them, and small ones because a known length keeps
 * `Content-Length` and costs nothing to hold.
 */
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

/** Feature test from the Fetch spec's request-streams explainer. */
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

/**
 * Whether a rejected attempt may be retried: the measured refusal is a
 * `TypeError` raised before the body handed out a single byte, so the origin
 * cannot hold a complete request (a chunked body needs its terminating
 * chunk). Anything else may have been processed and is never replayed,
 * whatever the method.
 */
export function isUnsentRefusal(
  err: unknown,
  upload: RetryableUpload,
  signal?: AbortSignal
): boolean {
  return err instanceof TypeError && upload.untouched() && !signal?.aborted;
}

/** Run `attempt` with a streamed body, retrying only an {@link isUnsentRefusal}. */
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
