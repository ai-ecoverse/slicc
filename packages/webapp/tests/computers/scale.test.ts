import { describe, expect, it } from 'vitest';
import {
  formatScaleLine,
  mapPoint,
  parseSizeSpec,
  roundTrip,
  SIZE_PRESETS,
  scaleFromEncoded,
  scaleFromNative,
  toLastShot,
} from '../../src/computers/scale.js';

describe('computer scale', () => {
  it('defaults --size to medium 768 and accepts presets', () => {
    expect(parseSizeSpec(undefined)).toBe(SIZE_PRESETS.medium);
    expect(parseSizeSpec('low')).toBe(256);
    expect(parseSizeSpec('high')).toBe(1536);
    expect(parseSizeSpec('640')).toBe(640);
    expect(parseSizeSpec('640x480')).toBe(640);
  });

  it('scales native pixels down when wider than maxWidth', () => {
    const mapping = scaleFromNative({ width: 1920, height: 1080 }, 768);
    expect(mapping.shotWidth).toBe(768);
    expect(mapping.shotHeight).toBe(432);
    expect(mapping.scale).toBeCloseTo(768 / 1920);
    expect(formatScaleLine(mapping)).toBe('1920x1080 → 768x432 (scale 0.4)');
  });

  it('derives scale from actual native and encoded dimensions', () => {
    const mapping = scaleFromEncoded({ width: 1000, height: 500 }, { width: 768, height: 384 });
    expect(mapping.nativeWidth).toBe(1000);
    expect(mapping.shotWidth).toBe(768);
    expect(mapping.scale).toBeCloseTo(0.768);
    expect(formatScaleLine(mapping)).toBe('1000x500 → 768x384 (scale 0.77)');
    const honest = scaleFromEncoded({ width: 1000, height: 500 }, { width: 1000, height: 500 });
    expect(honest.scale).toBe(1);
    expect(formatScaleLine(honest)).toBe('1000x500 → 1000x500 (scale 1)');
  });

  it('maps screenshot-space points back unless --native', () => {
    const lastShot = toLastShot(scaleFromNative({ width: 1000, height: 500 }, 500), 1);
    expect(mapPoint(100, 50, lastShot, false)).toEqual({ x: 200, y: 100 });
    expect(mapPoint(100, 50, lastShot, true)).toEqual({ x: 100, y: 50 });
  });

  it('round-trips native points through the shot scale', () => {
    expect(roundTrip(200, 100, 0.5)).toEqual({ x: 200, y: 100 });
  });
});
