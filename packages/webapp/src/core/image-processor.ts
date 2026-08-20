/**
 * Image validation and resizing for LLM vision APIs.
 *
 * Validates image size, dimensions, and format before sending to the API.
 * Resizes oversized images via ImageMagick WASM. Returns a text placeholder
 * if the image is unrecoverable (corrupt, unsupported format).
 */

import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';
import { isSupportedImageFormat, SUPPORTED_IMAGE_MIMES } from '../base/image-markers.js';
import { createLogger } from '../base/logger.js';
import type { ImageContent, TextContent } from './types.js';

const log = createLogger('image-processor');

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB API limit (on base64 string)
/** Max raw bytes that fit within the base64 limit (base64 inflates by 4/3). */
const MAX_RAW_BYTES = Math.floor((MAX_IMAGE_BYTES * 3) / 4);
export const OPTIMAL_LONG_EDGE = 1568; // px — avoids server-side resize
export const MAX_DIMENSION = 8000; // px — hard reject by API
export const SUPPORTED_MIMES = SUPPORTED_IMAGE_MIMES;

/** Estimate decoded byte size from base64 without full decode. */
export function getImageByteSize(base64: string): number {
  const data = normalizeBase64(base64);
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.ceil((data.length * 3) / 4) - padding;
}

export { isSupportedImageFormat };

type Dimensions = { width: number; height: number };

/**
 * Restore the tolerance `atob` had before the strict shared decoder: tool
 * output often arrives line-wrapped or with the trailing padding omitted, and
 * `base64ToUint8` rejects both wherever the Node `Buffer` fast-path is active.
 */
function normalizeBase64(base64: string): string {
  const compact = base64.replace(/[\t\n\f\r ]/g, '');
  const remainder = compact.length % 4;
  if (remainder === 2) return `${compact}==`;
  if (remainder === 3) return `${compact}=`;
  return compact;
}

/** Decode a base64 prefix and expose it as a byte view plus a `DataView`. */
function readHeader(base64: string, chars: number): DataView {
  const raw = base64ToUint8(normalizeBase64(base64.slice(0, chars)));
  return new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
}

function nonZero(width: number, height: number): Dimensions | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngDimensions(base64: string): Dimensions | null {
  // PNG IHDR: width @ bytes 16-19, height @ bytes 20-23 (big-endian uint32)
  // Need first 24 raw bytes = 32 base64 chars
  if (base64.length < 32) return null;
  const dv = readHeader(base64, 32);
  return nonZero(dv.getUint32(16, false), dv.getUint32(20, false));
}

function gifDimensions(base64: string): Dimensions | null {
  // GIF: width @ bytes 6-7, height @ bytes 8-9 (little-endian uint16)
  if (base64.length < 16) return null;
  const dv = readHeader(base64, 16);
  return nonZero(dv.getUint16(6, true), dv.getUint16(8, true));
}

function jpegDimensions(base64: string): Dimensions | null {
  // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker in first 64KB
  const scanChars = Math.min(Math.ceil(65536 / 3) * 4, base64.length);
  const dv = readHeader(base64, scanChars);
  for (let i = 0; i < dv.byteLength - 8; i++) {
    if (dv.getUint8(i) !== 0xff) continue;
    const marker = dv.getUint8(i + 1);
    if (marker === 0xc0 || marker === 0xc2) {
      return nonZero(dv.getUint16(i + 7, false), dv.getUint16(i + 5, false));
    }
  }
  return null;
}

/**
 * Extract image dimensions from base64 data by parsing format headers.
 * Returns null if dimensions can't be determined (unknown format, corrupt header).
 */
export function getImageDimensions(base64: string, mimeType: string): Dimensions | null {
  try {
    // Strip whitespace up front so the fixed prefix lengths below still cover
    // the header bytes when the input arrives line-wrapped.
    const data = normalizeBase64(base64);
    if (mimeType === 'image/png') return pngDimensions(data);
    if (mimeType === 'image/gif') return gifDimensions(data);
    if (mimeType === 'image/jpeg') return jpegDimensions(data);
  } catch {
    // Corrupt header — can't determine dimensions
  }
  return null;
}

/**
 * Process an ImageContent block: validate and resize if needed.
 *
 * Returns the original or resized ImageContent, or a TextContent placeholder
 * if the image cannot be processed (unsupported format, corrupt data).
 */
export async function processImageContent(
  image: ImageContent
): Promise<ImageContent | TextContent> {
  // Check format
  if (!isSupportedImageFormat(image.mimeType)) {
    log.warn('Unsupported image format', { mimeType: image.mimeType });
    return {
      type: 'text',
      text: `[Image removed: unsupported format "${image.mimeType}". Supported: JPEG, PNG, GIF, WebP]`,
    };
  }

  // The API enforces the 5MB limit on the base64 string, not decoded bytes.
  // base64 inflates size by ~33%, so we must check image.data.length directly.
  const base64Size = image.data.length;

  // Check dimensions — API rejects images > 8000px on any side.
  // Parse from header bytes (no full decode needed).
  const dims = getImageDimensions(image.data, image.mimeType);
  const needsResize =
    base64Size > MAX_IMAGE_BYTES ||
    (dims !== null && (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)) ||
    (dims !== null && Math.max(dims.width, dims.height) > OPTIMAL_LONG_EDGE);

  if (!needsResize) {
    return image;
  }

  log.info('Image needs processing', {
    base64Size,
    dimensions: dims ? `${dims.width}x${dims.height}` : 'unknown',
    reason: base64Size > MAX_IMAGE_BYTES ? 'size' : 'dimensions',
  });

  // Step 1: Load ImageMagick WASM
  let getMagick: typeof import('../shell/supplemental-commands/magick-wasm.js').getMagick;
  let MIME_TO_MAGICK_FORMAT: typeof import('../shell/supplemental-commands/magick-wasm.js').MIME_TO_MAGICK_FORMAT;
  try {
    const mod = await import('../shell/supplemental-commands/magick-wasm.js');
    getMagick = mod.getMagick;
    MIME_TO_MAGICK_FORMAT = mod.MIME_TO_MAGICK_FORMAT;
  } catch (err) {
    log.error('ImageMagick WASM module unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      type: 'text',
      text: `[Image removed: resize service unavailable (ImageMagick WASM could not be loaded)]`,
    };
  }

  let magick: Awaited<ReturnType<typeof getMagick>>;
  try {
    magick = await getMagick();
  } catch (err) {
    log.error('ImageMagick WASM initialization failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      type: 'text',
      text: `[Image removed: resize service unavailable (WASM init failed)]`,
    };
  }

  // Step 2: Decode and process
  try {
    const bytes = base64ToUint8(normalizeBase64(image.data));

    const output: { data: Uint8Array | null; mime: string } = { data: null, mime: image.mimeType };

    await magick.ImageMagick.read(bytes, async (img) => {
      const w = img.width;
      const h = img.height;
      const longEdge = Math.max(w, h);

      // Resize if dimensions exceed optimal or max
      if (longEdge > OPTIMAL_LONG_EDGE) {
        const scale = OPTIMAL_LONG_EDGE / longEdge;
        const newW = Math.round(w * scale);
        const newH = Math.round(h * scale);
        img.resize(newW, newH);
        log.info('Resized image', { from: `${w}x${h}`, to: `${newW}x${newH}` });
      }

      const format = MIME_TO_MAGICK_FORMAT[image.mimeType] || 'JPEG';

      img.write(format, (data: Uint8Array) => {
        output.data = new Uint8Array(data);
      });

      // If still over 5MB, try JPEG at quality 80
      if (output.data && output.data.length > MAX_RAW_BYTES && format !== 'JPEG') {
        log.info('Still over 5MB, compressing to JPEG q80');
        img.quality = 80;
        img.write('JPEG', (data: Uint8Array) => {
          output.data = new Uint8Array(data);
        });
        output.mime = 'image/jpeg';
      } else if (output.data && output.data.length > MAX_RAW_BYTES) {
        // Already JPEG, try lower quality
        log.info('Still over 5MB as JPEG, reducing quality to 60');
        img.quality = 60;
        img.write('JPEG', (data: Uint8Array) => {
          output.data = new Uint8Array(data);
        });
      }
    });

    if (!output.data) {
      log.warn('ImageMagick produced no output');
      return {
        type: 'text',
        text: '[Image removed: could not be processed (empty output from resize)]',
      };
    }

    // Final size check
    if (output.data.length > MAX_RAW_BYTES) {
      log.warn('Image still over 5MB after resize+compress', { size: output.data.length });
      return {
        type: 'text',
        text: `[Image removed: still ${Math.round((output.data.length / 1024 / 1024) * 10) / 10}MB after resize and compression, exceeds 5MB API limit]`,
      };
    }

    // Encode back to base64
    const newBase64 = uint8ToBase64(output.data);

    log.info('Image processed successfully', {
      originalBase64: base64Size,
      newBase64: newBase64.length,
      mimeType: output.mime,
    });

    return {
      type: 'image',
      data: newBase64,
      mimeType: output.mime,
    };
  } catch (err) {
    log.error('Image data processing failed (corrupt or unreadable)', {
      mimeType: image.mimeType,
      estimatedBytes: base64Size,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      type: 'text',
      text: `[Image removed: image data could not be processed (${err instanceof Error ? err.message : 'corrupt or unreadable'})]`,
    };
  }
}
