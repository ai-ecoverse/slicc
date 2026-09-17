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

/** Peek PNG IHDR dimensions. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    return null;
  }
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  if (width > 0 && height > 0) return { width, height };
  return null;
}

/** Nearest-neighbor downscale used when the encoder has no canvas. */
export function fitRgbaFrame(frame: RgbaFrame, maxWidth?: number): RgbaFrame {
  if (!maxWidth || frame.width <= maxWidth || frame.width <= 0) return frame;
  const scale = maxWidth / frame.width;
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(frame.height - 1, Math.round(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(frame.width - 1, Math.round(x / scale));
      const si = (srcY * frame.width + srcX) * 4;
      const di = (y * width + x) * 4;
      data[di] = frame.data[si];
      data[di + 1] = frame.data[si + 1];
      data[di + 2] = frame.data[si + 2];
      data[di + 3] = frame.data[si + 3];
    }
  }
  return { data, width, height };
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
