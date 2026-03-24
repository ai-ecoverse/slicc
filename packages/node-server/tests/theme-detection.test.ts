import { deflateSync } from 'zlib';
import { describe, expect, it } from 'vitest';

import { computeAverageLuminance, decodePngPixels } from '../src/electron-controller.js';

/**
 * Create a minimal valid PNG (8-bit RGBA) with a solid color fill.
 * Returns a base64-encoded string.
 */
function createSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255
): string {
  // Build raw scanlines: each row = filter byte (0 = None) + RGBA pixels
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const compressed = deflateSync(raw);

  // Assemble PNG chunks
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    // CRC (simplified — Node's zlib CRC isn't exposed, but PNG decoders
    // typically don't validate CRC in our test context)
    chunk.writeUInt32BE(0, 8 + data.length);
    return chunk;
  }

  // IHDR: width, height, bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]).toString('base64');
}

describe('decodePngPixels', () => {
  it('decodes a solid black PNG', () => {
    const base64 = createSolidPng(4, 4, 0, 0, 0);
    const { width, height, pixels } = decodePngPixels(base64);
    expect(width).toBe(4);
    expect(height).toBe(4);
    // Every pixel should be black (0, 0, 0, 255)
    for (let i = 0; i < width * height; i++) {
      expect(pixels[i * 4]).toBe(0);
      expect(pixels[i * 4 + 1]).toBe(0);
      expect(pixels[i * 4 + 2]).toBe(0);
      expect(pixels[i * 4 + 3]).toBe(255);
    }
  });

  it('decodes a solid white PNG', () => {
    const base64 = createSolidPng(4, 4, 255, 255, 255);
    const { width, height, pixels } = decodePngPixels(base64);
    expect(width).toBe(4);
    expect(height).toBe(4);
    for (let i = 0; i < width * height; i++) {
      expect(pixels[i * 4]).toBe(255);
      expect(pixels[i * 4 + 1]).toBe(255);
      expect(pixels[i * 4 + 2]).toBe(255);
      expect(pixels[i * 4 + 3]).toBe(255);
    }
  });

  it('decodes a colored PNG correctly', () => {
    const base64 = createSolidPng(2, 2, 128, 64, 200);
    const { pixels } = decodePngPixels(base64);
    expect(pixels[0]).toBe(128);
    expect(pixels[1]).toBe(64);
    expect(pixels[2]).toBe(200);
    expect(pixels[3]).toBe(255);
  });
});

describe('computeAverageLuminance', () => {
  it('returns ~0 for black pixels', () => {
    const pixels = Buffer.alloc(4 * 4 * 4); // 4x4 black RGBA
    for (let i = 0; i < 16; i++) pixels[i * 4 + 3] = 255; // set alpha
    const luminance = computeAverageLuminance(pixels, 4, 4, 1);
    expect(luminance).toBe(0);
  });

  it('returns ~255 for white pixels', () => {
    const pixels = Buffer.alloc(4 * 4 * 4);
    pixels.fill(255);
    const luminance = computeAverageLuminance(pixels, 4, 4, 1);
    expect(luminance).toBeCloseTo(255, 0);
  });

  it('classifies dark themes correctly (luminance < 128)', () => {
    // Typical dark theme background: #1a1a1a
    const base64 = createSolidPng(8, 8, 0x1a, 0x1a, 0x1a);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height, 1);
    expect(luminance).toBeLessThan(128);
  });

  it('classifies light themes correctly (luminance > 128)', () => {
    // Typical light theme background: #f8f8f8
    const base64 = createSolidPng(8, 8, 0xf8, 0xf8, 0xf8);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height, 1);
    expect(luminance).toBeGreaterThan(128);
  });

  it('respects the sampleStep parameter', () => {
    // 8x8 image, sampleStep=4 should sample 4 pixels (corners of 4x4 grid)
    const pixels = Buffer.alloc(8 * 8 * 4);
    pixels.fill(255); // all white
    const luminance = computeAverageLuminance(pixels, 8, 8, 4);
    expect(luminance).toBeCloseTo(255, 0);
  });
});

describe('end-to-end theme detection', () => {
  it('detects dark apps (Discord-like background #36393f)', () => {
    const base64 = createSolidPng(16, 16, 0x36, 0x39, 0x3f);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height);
    expect(luminance).toBeLessThan(128);
  });

  it('detects light apps (typical white background)', () => {
    const base64 = createSolidPng(16, 16, 0xff, 0xff, 0xff);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height);
    expect(luminance).toBeGreaterThan(128);
  });

  it('detects Slack dark theme (#1a1d21)', () => {
    const base64 = createSolidPng(16, 16, 0x1a, 0x1d, 0x21);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height);
    expect(luminance).toBeLessThan(128);
  });

  it('detects Slack light theme (#f8f8f8)', () => {
    const base64 = createSolidPng(16, 16, 0xf8, 0xf8, 0xf8);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height);
    expect(luminance).toBeGreaterThan(128);
  });
});
