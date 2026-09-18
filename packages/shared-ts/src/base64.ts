const CHUNK_SIZE = 0x8000;

interface NodeBufferCtor {
  from(input: string, encoding: 'base64'): Uint8Array;
  from(input: Uint8Array): { toString(encoding: 'base64'): string };
}

function nodeBuffer(): NodeBufferCtor | undefined {
  return (globalThis as { Buffer?: NodeBufferCtor }).Buffer;
}

const ATOB_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

const BASE64_WHITESPACE_RE = /[\t\n\f\r ]/g;

export function normalizeBase64(b64: string): string | null {
  const compact = b64.replace(BASE64_WHITESPACE_RE, '');
  return ATOB_BASE64_RE.test(compact) ? compact : null;
}

function padded(b64: string): string {
  const remainder = b64.length % 4;
  return remainder === 0 ? b64 : b64 + '='.repeat(4 - remainder);
}

export function base64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const B = nodeBuffer();
  if (B) {
    const normalized = normalizeBase64(b64);
    if (normalized === null) throw new Error('Invalid base64 string');

    return new Uint8Array(B.from(padded(normalized), 'base64'));
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const compact =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  const B = nodeBuffer();
  if (B) {
    return B.from(compact).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < compact.byteLength; i += CHUNK_SIZE) {
    const slice = compact.subarray(i, Math.min(i + CHUNK_SIZE, compact.byteLength));
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}
