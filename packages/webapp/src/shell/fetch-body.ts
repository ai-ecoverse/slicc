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

/**
 * The bytes a `FetchBody` stands for. A string is read under the latin1
 * convention (one char per byte) that just-bash `curl` and git use to thread
 * binary through a string body.
 *
 * A code unit above 0xFF cannot come from that convention — it is Unicode text
 * that was never a byte string — so such a string is encoded as UTF-8 instead.
 * Masking it (`charCodeAt(i) & 0xff`) silently dropped the high bits and turned
 * `→` (U+2192) into a lone `0x92`.
 */
export function getFetchBodyBytes(body: FetchBody): Uint8Array {
  if (typeof body !== 'string') return body;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) > 0xff) return new TextEncoder().encode(body);
  }
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) {
    bytes[i] = body.charCodeAt(i);
  }
  return bytes;
}

/** Copy a view into an owned buffer so a later mutation of the source cannot leak. */
export function copyUint8(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
