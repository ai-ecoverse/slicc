import type { SerializedFetchResponse } from './realm-types.js';

const NO_BODY_STATUS = new Set([204, 205, 304]);

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
  } catch {}
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
    } catch {}
  }
  return headers;
}

const BUFFERED_BODY = Symbol('slicc.realmBufferedBody');

type BufferedBodyHost = Request | Response;

export function attachBufferedBodyReaders(body: BufferedBodyHost, bytes: Uint8Array): void {
  if (BUFFERED_BODY in body) return;
  Object.defineProperty(body, BUFFERED_BODY, { value: true, configurable: true });
  const nativeBodyUsed = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(body), 'bodyUsed');
  let used = false;
  const consume = (): Uint8Array => {
    if (used) {
      throw new TypeError('Failed to read response body: body already used');
    }
    used = true;
    disturbNativeBody(body);
    return bytes;
  };
  const text = async (): Promise<string> => new TextDecoder().decode(consume());
  const toArrayBuffer = (copy: Uint8Array): ArrayBuffer =>
    copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
  const arrayBuffer = async (): Promise<ArrayBuffer> => toArrayBuffer(consume());
  Object.defineProperties(body, {
    bodyUsed: {
      configurable: true,
      enumerable: false,
      get(): boolean {
        if (used) return true;
        return nativeBodyUsed?.get ? Boolean(nativeBodyUsed.get.call(body)) : false;
      },
    },
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
    bytes: { value: async (): Promise<Uint8Array> => consume(), configurable: true },
  });
}

function disturbNativeBody(body: BufferedBodyHost): void {
  try {
    const stream = body.body;
    if (stream && !stream.locked) stream.getReader();
  } catch {}
}
