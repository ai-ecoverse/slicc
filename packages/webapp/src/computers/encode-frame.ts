import type { ComputerFrame } from '@slicc/shared-ts';

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type FrameMime = 'image/png' | 'image/jpeg';

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

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7);
}

export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    let marker = bytes[i + 1];

    while (marker === 0xff && i + 2 < bytes.length) {
      i += 1;
      marker = bytes[i + 1];
    }
    if (isStandaloneJpegMarker(marker)) {
      i += 2;
      continue;
    }

    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

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

export async function pngBytesToJpeg(bytes: Uint8Array, quality = 0.7): Promise<Uint8Array> {
  if (jpegSize(bytes)) return bytes;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return MINIMAL_JPEG.slice();
  }
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const canvasCtx = canvas.getContext('2d');
  if (!canvasCtx) throw new Error('could not acquire 2d canvas context');
  canvasCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await out.arrayBuffer());
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

export async function fitComputerFrame(
  frame: ComputerFrame,
  maxWidth: number,
  resample: (
    frame: ComputerFrame,
    width: number,
    height: number
  ) => Promise<Uint8Array | null> = resampleEncodedFrame
): Promise<ComputerFrame> {
  if (!maxWidth || frame.width <= maxWidth) {
    if (!frame.overCap) return frame;
    return {
      seq: frame.seq,
      mime: frame.mime,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytes,
    };
  }
  const scale = maxWidth / frame.width;
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const resampled = await resample(frame, width, height);
  if (resampled) {
    return { seq: frame.seq, mime: 'image/jpeg', width, height, bytes: resampled };
  }
  return { ...frame, overCap: true };
}

async function resampleEncodedFrame(
  frame: ComputerFrame,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return null;
  }
  try {
    const blob = new Blob([new Uint8Array(frame.bytes)], { type: frame.mime });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(width, height);
    const canvasCtx = canvas.getContext('2d');
    if (!canvasCtx) {
      bitmap.close();
      return null;
    }
    canvasCtx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}
