import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'zlib';

import {
  computeAverageLuminance,
  decodePngPixels,
  detectAppThemeFromScreenshot,
} from '../src/electron-controller.js';

function createSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255
): string {
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const compressed = deflateSync(raw);

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type: string, data: Buffer): Buffer {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);

    chunk.writeUInt32BE(0, 8 + data.length);
    return chunk;
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]).toString('base64');
}

function createFilteredPng(colorType: 2 | 6, rows: readonly Buffer[]): string {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const makeChunk = (type: string, data: Buffer): Buffer => {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    return chunk;
  };
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const width = (rows[0]!.length - 1) / bytesPerPixel;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(Buffer.concat(rows))),
    makeChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

describe('decodePngPixels', () => {
  it('rejects input without a PNG signature', () => {
    expect(() => decodePngPixels(Buffer.from('not a png').toString('base64'))).toThrow(
      'Not a valid PNG'
    );
  });

  it('decodes a solid black PNG', () => {
    const base64 = createSolidPng(4, 4, 0, 0, 0);
    const { width, height, pixels } = decodePngPixels(base64);
    expect(width).toBe(4);
    expect(height).toBe(4);

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

  it('decodes RGB pixels with an opaque alpha channel', () => {
    const { pixels } = decodePngPixels(
      createFilteredPng(2, [Buffer.from([0, 12, 34, 56, 78, 90, 123])])
    );
    expect([...pixels]).toEqual([12, 34, 56, 255, 78, 90, 123, 255]);
  });

  it('applies all four PNG row reconstruction filters', () => {
    for (const filter of [1, 2, 3, 4]) {
      const { pixels } = decodePngPixels(
        createFilteredPng(6, [Buffer.from([filter, 10, 20, 30, 40])])
      );
      expect([...pixels]).toEqual([10, 20, 30, 40]);
    }
  });
});

describe('computeAverageLuminance', () => {
  it('uses a neutral fallback when no pixels can be sampled', () => {
    expect(computeAverageLuminance(Buffer.alloc(0), 0, 0)).toBe(128);
  });

  it('returns ~0 for black pixels', () => {
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) pixels[i * 4 + 3] = 255;
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
    const base64 = createSolidPng(8, 8, 0x1a, 0x1a, 0x1a);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height, 1);
    expect(luminance).toBeLessThan(128);
  });

  it('classifies light themes correctly (luminance > 128)', () => {
    const base64 = createSolidPng(8, 8, 0xf8, 0xf8, 0xf8);
    const { width, height, pixels } = decodePngPixels(base64);
    const luminance = computeAverageLuminance(pixels, width, height, 1);
    expect(luminance).toBeGreaterThan(128);
  });

  it('respects the sampleStep parameter', () => {
    const pixels = Buffer.alloc(8 * 8 * 4);
    pixels.fill(255);
    const luminance = computeAverageLuminance(pixels, 8, 8, 4);
    expect(luminance).toBeCloseTo(255, 0);
  });
});

describe('end-to-end theme detection', () => {
  it('classifies screenshot replies and falls back on decode failure', async () => {
    const ws = new EventEmitter();
    const light = detectAppThemeFromScreenshot(ws as never, () => 41);
    ws.emit(
      'message',
      JSON.stringify({ id: 41, result: { data: createSolidPng(2, 2, 255, 255, 255) } })
    );
    await expect(light).resolves.toBe('light');

    const invalidWs = new EventEmitter();
    const invalid = detectAppThemeFromScreenshot(invalidWs as never, () => 42);
    invalidWs.emit('message', JSON.stringify({ id: 42, result: { data: 'not-a-png' } }));
    await expect(invalid).resolves.toBe('dark');
  });

  it('defaults to dark when screenshot capture times out', async () => {
    vi.useFakeTimers();
    try {
      const ws = new EventEmitter();
      const result = detectAppThemeFromScreenshot(ws as never, () => 43);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(result).resolves.toBe('dark');
      expect(ws.listenerCount('message')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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
