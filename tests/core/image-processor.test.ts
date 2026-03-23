import { describe, it, expect } from 'vitest';
import {
  getImageByteSize,
  getImageDimensions,
  isSupportedImageFormat,
  processImageContent,
  MAX_IMAGE_BYTES,
} from './image-processor.js';
import type { ImageContent } from './types.js';

describe('getImageByteSize', () => {
  it('calculates correct size for known base64 string', () => {
    // "Hello" in base64 is "SGVsbG8=" (5 bytes)
    expect(getImageByteSize('SGVsbG8=')).toBe(5);
  });

  it('handles base64 with double padding', () => {
    // "Hi" in base64 is "SGk=" but actually "Hi" is 2 bytes → "SGk=" has 1 pad
    // "H" is 1 byte → "SA==" has 2 pads
    expect(getImageByteSize('SA==')).toBe(1);
  });

  it('handles base64 with no padding', () => {
    // "abc" is 3 bytes → "YWJj" (no padding, 4 chars)
    expect(getImageByteSize('YWJj')).toBe(3);
  });

  it('handles empty string', () => {
    expect(getImageByteSize('')).toBe(0);
  });

  it('estimates large base64 correctly', () => {
    // 1MB of data would be ~1,398,101 base64 chars
    const oneMB = 1024 * 1024;
    // base64 ratio: 4 chars per 3 bytes, so for N bytes: ceil(N/3)*4 chars
    const base64Len = Math.ceil(oneMB / 3) * 4;
    const fakeBase64 = 'A'.repeat(base64Len);
    const estimated = getImageByteSize(fakeBase64);
    // Should be close to 1MB (within rounding)
    expect(estimated).toBeGreaterThanOrEqual(oneMB);
    expect(estimated).toBeLessThanOrEqual(oneMB + 3);
  });
});

describe('isSupportedImageFormat', () => {
  it('accepts JPEG', () => {
    expect(isSupportedImageFormat('image/jpeg')).toBe(true);
  });

  it('accepts PNG', () => {
    expect(isSupportedImageFormat('image/png')).toBe(true);
  });

  it('accepts GIF', () => {
    expect(isSupportedImageFormat('image/gif')).toBe(true);
  });

  it('accepts WebP', () => {
    expect(isSupportedImageFormat('image/webp')).toBe(true);
  });

  it('rejects SVG', () => {
    expect(isSupportedImageFormat('image/svg+xml')).toBe(false);
  });

  it('rejects BMP', () => {
    expect(isSupportedImageFormat('image/bmp')).toBe(false);
  });

  it('rejects TIFF', () => {
    expect(isSupportedImageFormat('image/tiff')).toBe(false);
  });

  it('rejects non-image types', () => {
    expect(isSupportedImageFormat('application/pdf')).toBe(false);
    expect(isSupportedImageFormat('text/plain')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSupportedImageFormat('')).toBe(false);
  });
});

describe('getImageDimensions', () => {
  function makeBase64(bytes: number[]): string {
    return btoa(String.fromCharCode(...bytes));
  }

  it('extracts PNG dimensions from IHDR chunk', () => {
    // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) = 24 bytes
    const png = [
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR chunk length
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x03,
      0x20, // width = 800
      0x00,
      0x00,
      0x02,
      0x58, // height = 600
    ];
    expect(getImageDimensions(makeBase64(png), 'image/png')).toEqual({ width: 800, height: 600 });
  });

  it('extracts large PNG dimensions (> 8000px)', () => {
    const png = [
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
      0x04,
      0x00, // width = 1024
      0x00,
      0x00,
      0x27,
      0x10, // height = 10000
    ];
    expect(getImageDimensions(makeBase64(png), 'image/png')).toEqual({
      width: 1024,
      height: 10000,
    });
  });

  it('extracts GIF dimensions', () => {
    const gif = [
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // "GIF89a"
      0x20,
      0x03, // width = 800 (LE)
      0x58,
      0x02, // height = 600 (LE)
    ];
    expect(getImageDimensions(makeBase64(gif), 'image/gif')).toEqual({ width: 800, height: 600 });
  });

  it('extracts JPEG dimensions from SOF0 marker', () => {
    // Minimal JPEG: SOI + SOF0 with dimensions
    const jpeg = [
      0xff,
      0xd8, // SOI
      0xff,
      0xc0, // SOF0
      0x00,
      0x11, // length
      0x08, // precision
      0x02,
      0x58, // height = 600
      0x03,
      0x20, // width = 800
    ];
    expect(getImageDimensions(makeBase64(jpeg), 'image/jpeg')).toEqual({ width: 800, height: 600 });
  });

  it('extracts JPEG dimensions from SOF2 (progressive) marker', () => {
    const jpeg = [
      0xff,
      0xd8,
      0xff,
      0xc2, // SOF2 (progressive)
      0x00,
      0x11,
      0x08,
      0x02,
      0x58, // height = 600
      0x03,
      0x20, // width = 800
    ];
    expect(getImageDimensions(makeBase64(jpeg), 'image/jpeg')).toEqual({ width: 800, height: 600 });
  });

  it('returns null for JPEG with no SOF marker', () => {
    const jpeg = [
      0xff,
      0xd8, // SOI
      0xff,
      0xe0, // APP0 (not SOF)
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
    ];
    expect(getImageDimensions(makeBase64(jpeg), 'image/jpeg')).toBeNull();
  });

  it('returns null for PNG with zero width', () => {
    const png = [
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
      0x00, // width = 0
      0x00,
      0x00,
      0x02,
      0x58, // height = 600
    ];
    expect(getImageDimensions(makeBase64(png), 'image/png')).toBeNull();
  });

  it('returns null for too-short base64', () => {
    expect(getImageDimensions('AA==', 'image/png')).toBeNull();
  });

  it('returns null for unknown format', () => {
    expect(getImageDimensions('AAAA', 'image/webp')).toBeNull();
  });

  it('returns null for corrupt header', () => {
    // Invalid base64 that will fail atob
    expect(getImageDimensions('!!!', 'image/png')).toBeNull();
  });
});

describe('processImageContent', () => {
  it('passes through small valid images unchanged', async () => {
    // A tiny valid PNG-like base64 (well under 5MB)
    const image: ImageContent = {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUg==',
      mimeType: 'image/png',
    };

    const result = await processImageContent(image);
    expect(result).toEqual(image);
  });

  it('returns text placeholder for unsupported MIME type', async () => {
    const image: ImageContent = {
      type: 'image',
      data: 'abc123',
      mimeType: 'image/svg+xml',
    };

    const result = await processImageContent(image);
    expect(result.type).toBe('text');
    expect((result as any).text).toContain('unsupported format');
    expect((result as any).text).toContain('image/svg+xml');
  });

  it('returns text placeholder for BMP format', async () => {
    const image: ImageContent = {
      type: 'image',
      data: 'abc123',
      mimeType: 'image/bmp',
    };

    const result = await processImageContent(image);
    expect(result.type).toBe('text');
    expect((result as any).text).toContain('unsupported format');
  });

  it('attempts resize for images over 5MB base64', async () => {
    // Create a base64 string that is > 5MB (the API limit is on base64 length)
    const largeData = 'A'.repeat(MAX_IMAGE_BYTES + 1024);
    const image: ImageContent = {
      type: 'image',
      data: largeData,
      mimeType: 'image/png',
    };

    // Since we can't load ImageMagick WASM in unit tests, the dynamic import
    // will fail, and we should get a text placeholder (error path)
    const result = await processImageContent(image);
    expect(result.type).toBe('text');
    expect((result as any).text).toContain('Image removed');
  });

  it('passes through image at exactly 5MB base64', async () => {
    // Create base64 string of exactly MAX_IMAGE_BYTES length
    const data = 'A'.repeat(MAX_IMAGE_BYTES);
    const image: ImageContent = {
      type: 'image',
      data,
      mimeType: 'image/jpeg',
    };

    const result = await processImageContent(image);
    // Should pass through — base64 string is exactly at the limit
    expect(result).toEqual(image);
  });

  it('triggers resize for image with raw bytes under 5MB but base64 over 5MB', async () => {
    // Regression test: ~4.9MB raw → ~6.5MB base64 → should NOT pass through
    // Create base64 that decodes to ~4.9MB but is ~6.5MB as a string
    const rawBytes = 4.9 * 1024 * 1024;
    const base64Len = Math.ceil(rawBytes / 3) * 4; // ~6.5MB
    expect(base64Len).toBeGreaterThan(MAX_IMAGE_BYTES); // confirm base64 > 5MB
    expect(getImageByteSize('A'.repeat(base64Len))).toBeLessThan(MAX_IMAGE_BYTES); // confirm raw < 5MB

    const image: ImageContent = {
      type: 'image',
      data: 'A'.repeat(base64Len),
      mimeType: 'image/png',
    };

    // Should attempt resize (WASM unavailable in test → text placeholder)
    const result = await processImageContent(image);
    expect(result.type).toBe('text');
    expect((result as any).text).toContain('Image removed');
  });

  it('triggers resize for small image with dimensions > 8000px', async () => {
    // Regression: full-page screenshots can be under 5MB but exceed 8000px height.
    // Build a minimal PNG header with height = 10000px, padded to look like a small image.
    const pngHeader = [
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
      0x04,
      0x00, // width = 1024
      0x00,
      0x00,
      0x27,
      0x10, // height = 10000 (> 8000)
    ];
    const headerBase64 = btoa(String.fromCharCode(...pngHeader));
    // Pad with valid base64 to make it a reasonable size (but well under 5MB)
    const data = headerBase64 + 'A'.repeat(1000);
    const image: ImageContent = {
      type: 'image',
      data,
      mimeType: 'image/png',
    };

    // Should trigger resize due to dimensions, even though size is tiny
    const result = await processImageContent(image);
    expect(result.type).toBe('text'); // WASM unavailable in test
    expect((result as any).text).toContain('Image removed');
  });

  it('handles corrupt base64 data gracefully when resize is attempted', async () => {
    const image: ImageContent = {
      type: 'image',
      data: 'X'.repeat(MAX_IMAGE_BYTES + 1024),
      mimeType: 'image/jpeg',
    };

    const result = await processImageContent(image);
    // Should gracefully return placeholder (WASM not available in test)
    expect(result.type).toBe('text');
    expect((result as any).text).toContain('Image removed');
  });
});
