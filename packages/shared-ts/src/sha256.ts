export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function compactArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  return new Uint8Array(data).slice().buffer;
}

export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', compactArrayBuffer(source));
  return bytesToHex(new Uint8Array(digest));
}
