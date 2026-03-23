/**
 * Image validation and resizing for LLM vision APIs.
 *
 * Validates image size, dimensions, and format before sending to the API.
 * Resizes oversized images via ImageMagick WASM. Returns a text placeholder
 * if the image is unrecoverable (corrupt, unsupported format).
 */

import type { ImageContent, TextContent } from './types.js';
import { createLogger } from './logger.js';

const log = createLogger('image-processor');

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB API limit (on base64 string)
/** Max raw bytes that fit within the base64 limit (base64 inflates by 4/3). */
const MAX_RAW_BYTES = Math.floor((MAX_IMAGE_BYTES * 3) / 4);
export const OPTIMAL_LONG_EDGE = 1568; // px — avoids server-side resize
export const MAX_DIMENSION = 8000; // px — hard reject by API
export const SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Estimate decoded byte size from base64 without full decode. */
export function getImageByteSize(base64: string): number {
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.ceil((base64.length * 3) / 4) - padding;
}

export function isSupportedImageFormat(mimeType: string): boolean {
  return SUPPORTED_MIMES.has(mimeType);
}

/**
 * Extract image dimensions from base64 data by parsing format headers.
 * Returns null if dimensions can't be determined (unknown format, corrupt header).
 */
export function getImageDimensions(
  base64: string,
  mimeType: string
): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png') {
      // PNG IHDR: width @ bytes 16-19, height @ bytes 20-23 (big-endian uint32)
      // Need first 24 raw bytes = 32 base64 chars
      if (base64.length < 32) return null;
      const raw = atob(base64.slice(0, 32));
      const w =
        (raw.charCodeAt(16) << 24) |
        (raw.charCodeAt(17) << 16) |
        (raw.charCodeAt(18) << 8) |
        raw.charCodeAt(19);
      const h =
        (raw.charCodeAt(20) << 24) |
        (raw.charCodeAt(21) << 16) |
        (raw.charCodeAt(22) << 8) |
        raw.charCodeAt(23);
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }

    if (mimeType === 'image/gif') {
      // GIF: width @ bytes 6-7, height @ bytes 8-9 (little-endian uint16)
      if (base64.length < 16) return null;
      const raw = atob(base64.slice(0, 16));
      const w = raw.charCodeAt(6) | (raw.charCodeAt(7) << 8);
      const h = raw.charCodeAt(8) | (raw.charCodeAt(9) << 8);
      return w > 0 && h > 0 ? { width: w, height: h } : null;
    }

    if (mimeType === 'image/jpeg') {
      // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker in first 64KB
      const scanBytes = Math.min(Math.ceil(65536 / 3) * 4, base64.length);
      const raw = atob(base64.slice(0, scanBytes));
      for (let i = 0; i < raw.length - 8; i++) {
        if (raw.charCodeAt(i) === 0xff) {
          const marker = raw.charCodeAt(i + 1);
          if (marker === 0xc0 || marker === 0xc2) {
            const h = (raw.charCodeAt(i + 5) << 8) | raw.charCodeAt(i + 6);
            const w = (raw.charCodeAt(i + 7) << 8) | raw.charCodeAt(i + 8);
            return w > 0 && h > 0 ? { width: w, height: h } : null;
          }
        }
      }
    }
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
    const binaryString = atob(image.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

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
    let binary = '';
    for (let i = 0; i < output.data.length; i++) {
      binary += String.fromCharCode(output.data[i]);
    }
    const newBase64 = btoa(binary);

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
