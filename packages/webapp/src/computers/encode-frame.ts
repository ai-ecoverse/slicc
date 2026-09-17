/**
 * Encode an RGBA framebuffer to PNG or JPEG via OffscreenCanvas.
 *
 * Available in the kernel worker on every supported float. Tests inject a
 * stub encoder when OffscreenCanvas is missing.
 */

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type FrameMime = 'image/png' | 'image/jpeg';

/** 1×1 JPEG (SOF0) used when OffscreenCanvas is missing — tests / Node. */
export const MINIMAL_JPEG = Uint8Array.of(
  0xff,
  0xd8,
  0xff,
  0xc0,
  0x00,
  0x0b,
  0x08,
  0x00,
  0x01,
  0x00,
  0x01,
  0x01,
  0x01,
  0x11,
  0x00,
  0xff,
  0xd9
);

/** Peek SOF0/SOF2 dimensions from a JPEG payload. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let i = 0; i < bytes.length - 8; i++) {
    if (bytes[i] !== 0xff) continue;
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return null;
}

export async function encodeRgbaFrame(
  frame: RgbaFrame,
  mime: FrameMime,
  quality = 0.7
): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'undefined') {
    return MINIMAL_JPEG.slice();
  }
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const canvasCtx = canvas.getContext('2d');
  if (!canvasCtx) throw new Error('could not acquire 2d canvas context');
  const pixels = frame.data as unknown as ImageDataArray;
  canvasCtx.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  const blob = await canvas.convertToBlob({
    type: mime,
    ...(mime === 'image/jpeg' ? { quality } : {}),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode a data-URL / raw base64 screenshot into bytes. */
export function bytesFromBase64(base64: string): Uint8Array {
  const comma = base64.indexOf(',');
  const payload = comma >= 0 ? base64.slice(comma + 1) : base64;
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
