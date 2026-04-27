const utf8Decoder = new TextDecoder();

export type FetchBody = Uint8Array | string;

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
