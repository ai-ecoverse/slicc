/**
 * Reconstruct a `Response` from the fetch-RPC payload.
 *
 * The host already buffered `arrayBuffer()`, so `json()` / `text()` must
 * resolve from those bytes — not from the native body stream. Native
 * `Response` body consumption is a ReadableStream turn in the worker, which
 * is not an RPC/timer handle; the drain would tear down before the
 * continuation after `await res.json()` ran (#2862).
 *
 * Hop-by-hop encoding headers are stripped: the bytes are already decoded,
 * and passing `content-encoding: gzip` into the constructor makes some
 * runtimes try to inflate them again.
 */

import type { SerializedFetchResponse } from './realm-types.js';

const NO_BODY_STATUS = new Set([204, 205, 304]);

/** Headers that describe transport framing, not the already-decoded payload. */
const STRIP_HEADERS = new Set(['content-encoding', 'transfer-encoding', 'content-length']);

export function reconstructFetchResponse(
  serialized: SerializedFetchResponse,
  fallbackUrl: string
): Response {
  const bytes = copyBodyBytes(serialized.body);
  const headers = headersForBufferedBody(serialized.headers);
  const noBody = NO_BODY_STATUS.has(serialized.status) || bytes.byteLength === 0;
  const response = new Response(noBody ? null : (bytes as unknown as BodyInit), {
    status: serialized.status,
    statusText: serialized.statusText,
    headers,
  });
  try {
    Object.defineProperty(response, 'url', {
      value: serialized.url || fallbackUrl,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Some runtimes lock `url`; `response.url` then stays "".
  }
  attachBufferedBodyReaders(response, bytes);
  return response;
}

function copyBodyBytes(body: Uint8Array): Uint8Array {
  if (body.byteLength === 0) return new Uint8Array();
  return body.slice();
}

function headersForBufferedBody(raw: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    try {
      headers.set(key, value);
    } catch {
      // Skip headers the Response constructor refuses.
    }
  }
  return headers;
}

/**
 * Shadow native body readers with Promise.resolve-from-bytes implementations
 * so `await res.json()` is a microtask, not a stream macrotask the drain
 * cannot see.
 */
function attachBufferedBodyReaders(response: Response, bytes: Uint8Array): void {
  let used = false;
  const consume = (): Uint8Array => {
    if (used) {
      throw new TypeError('Failed to read response body: body already used');
    }
    used = true;
    return bytes;
  };
  const text = async (): Promise<string> => new TextDecoder().decode(consume());
  const toArrayBuffer = (copy: Uint8Array): ArrayBuffer =>
    copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
  const arrayBuffer = async (): Promise<ArrayBuffer> => toArrayBuffer(consume());
  Object.defineProperties(response, {
    text: { value: text, configurable: true },
    json: {
      value: async (): Promise<unknown> => JSON.parse(await text()) as unknown,
      configurable: true,
    },
    arrayBuffer: { value: arrayBuffer, configurable: true },
    blob: {
      value: async (): Promise<Blob> => new Blob([toArrayBuffer(consume())]),
      configurable: true,
    },
  });
}
