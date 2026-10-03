/**
 * SHA-256 digest → lowercase hex, plus the bytes→hex codec it uses.
 *
 * One implementation for every float that previously hand-rolled
 * `crypto.subtle.digest('SHA-256', …)` then `.toString(16).padStart(2, '0')`.
 * Offset `Uint8Array` views are compacted by `byteOffset`/`byteLength` before
 * hashing so a subarray never includes backing-buffer bytes (issue #3778).
 */

/** Lowercase hex of `bytes` (the view, not its backing buffer). */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compact a view or buffer to a standalone `ArrayBuffer` covering exactly
 * the visible bytes. Passing `view.buffer` (or a TypeScript `as BufferSource`
 * of that buffer) to `digest` hashes bytes outside an offset view.
 */
export function compactArrayBuffer(data: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * SHA-256 of a UTF-8 string, `Uint8Array` view, or `ArrayBuffer`, as
 * lowercase hex. Offset views hash the same as a copy of the same bytes.
 */
export async function sha256Hex(data: Uint8Array | ArrayBuffer | string): Promise<string> {
  const source = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', compactArrayBuffer(source));
  return bytesToHex(new Uint8Array(digest));
}
