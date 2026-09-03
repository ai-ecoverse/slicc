const utf8Decoder = new TextDecoder();

export type FetchBody = Uint8Array | string;

/** Request body SecureFetch may carry: a Unicode string, or raw bytes. */
export type SecureFetchRequestBody = string | Uint8Array;

export function decodeFetchBody(body: FetchBody): string {
  return typeof body === 'string' ? body : utf8Decoder.decode(body);
}

export function parseFetchJson<T>(body: FetchBody): T {
  return JSON.parse(decodeFetchBody(body)) as T;
}

export function getFetchBodyBytes(body: FetchBody): Uint8Array {
  if (typeof body !== 'string') return body;

  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    bytes[i] = body.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Copy a view into an owned buffer so a later mutation of the source cannot leak. */
export function copyUint8(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
