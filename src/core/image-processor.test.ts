import { describe, it, expect } from 'vitest';
import {
  getImageByteSize,
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
