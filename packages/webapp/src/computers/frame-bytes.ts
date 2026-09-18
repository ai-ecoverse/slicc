/**
 * Compact computer-frame bytes that survive JSON clones, offset views,
 * and MessagePort transfer. Overlay `<img>` data URLs and frozen-path
 * reads both go through here so a 1×1 SOF0 stub cannot be mistaken for
 * a real JPEG just because `mime` says so.
 */

export type ComputerImageMime = 'image/png' | 'image/jpeg';

/**
 * 1×1 grayscale PNG. A browser `<img>` fires `load` for these bytes.
 * Distinct from `MINIMAL_JPEG` in encode-frame.ts, which is SOF0-only
 * and fires `error` (broken-image icon + alt text).
 */
export const DECODABLE_PNG = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x04,
  0x00,
  0x00,
  0x00,
  0xb5,
  0x1c,
  0x0c,
  0x02,
  0x00,
  0x00,
  0x00,
  0x0b,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0xda,
  0x63,
  0x64,
  0x60,
  0x00,
  0x00,
  0x00,
  0x06,
  0x00,
  0x02,
  0x30,
  0x81,
  0xd0,
  0x2f,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82
);

/** Peek PNG / JPEG magic so a `.jpg` frozen path that holds PNG still renders. */
export function sniffFrameMime(bytes: Uint8Array): ComputerImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

/** JSON.stringify(Uint8Array) / chrome.runtime clone: numeric keys, no prototype. */
interface JsonClonedByteArray {
  length?: number;
  byteLength?: number;
  [index: number]: number | undefined;
}

/**
 * Own a compact `Uint8Array` copy of whatever shape `bytes` arrived in.
 *
 * Handles a real view (including `byteOffset !== 0` after worker transfer),
 * an `ArrayBuffer`, a number[], and the `{0: n, 1: n, …}` object
 * `JSON.stringify(Uint8Array)` / `chrome.runtime` produce.
 */
export function coerceComputerFrameBytes(bytes: unknown): Uint8Array {
  if (bytes instanceof Uint8Array) {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return out;
  }
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (ArrayBuffer.isView(bytes)) {
    const view = bytes as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (Array.isArray(bytes)) return Uint8Array.from(bytes as number[]);
  if (bytes && typeof bytes === 'object')
    return coerceJsonClonedBytes(bytes as JsonClonedByteArray);
  return new Uint8Array(0);
}

function jsonClonedLength(rec: JsonClonedByteArray): number {
  if (typeof rec.byteLength === 'number') return rec.byteLength;
  if (typeof rec.length === 'number') return rec.length;
  let maxKey = -1;
  for (const k of Object.keys(rec)) {
    if (!/^\d+$/.test(k)) continue;
    const n = Number(k);
    if (n > maxKey) maxKey = n;
  }
  return maxKey + 1;
}

function coerceJsonClonedBytes(rec: JsonClonedByteArray): Uint8Array {
  const len = jsonClonedLength(rec);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const n = rec[i];
    if (typeof n === 'number') out[i] = n & 0xff;
  }
  return out;
}
