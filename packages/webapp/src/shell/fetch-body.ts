const utf8Decoder = new TextDecoder();

export type FetchBody = Uint8Array | string;

export type SecureFetchRequestBody = string | Uint8Array;

export function decodeFetchBody(body: FetchBody): string {
  return typeof body === 'string' ? body : utf8Decoder.decode(body);
}

export function parseFetchJson<T>(body: FetchBody): T {
  return JSON.parse(decodeFetchBody(body)) as T;
}

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

export function copyUint8(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}
