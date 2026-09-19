import { describe, expect, it } from 'vitest';
import {
  formatScaleLine,
  mapDisplayedToNative,
  mapNativeToCss,
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

  it('maps tab device pixels to CSS using devicePixelRatio', () => {
    expect(mapNativeToCss(1100, 800, 2.5)).toEqual({ x: 440, y: 320 });
    expect(mapNativeToCss(1101, 801, 2.5)).toEqual({ x: 440, y: 320 });
    expect(mapNativeToCss(1100, 800, 1)).toEqual({ x: 1100, y: 800 });
    expect(mapNativeToCss(1100, 800, 0)).toEqual({ x: 1100, y: 800 });
    expect(mapNativeToCss(1100, 800, Number.NaN)).toEqual({ x: 1100, y: 800 });
  });

  it('keeps lastShot scale in advertised native space so DPR conversion is not baked in', () => {
    const mapping = scaleFromEncoded({ width: 5120, height: 2704 }, { width: 614, height: 324 });
    const lastShot = toLastShot(mapping, 1);
    expect(lastShot.scale).toBeCloseTo(614 / 5120);
    const native = mapPoint(132, 96, lastShot, false);
    expect(native).toEqual({ x: 1101, y: 801 });
    expect(mapNativeToCss(native.x, native.y, 2.5)).toEqual({ x: 440, y: 320 });
    expect(mapPoint(1100, 800, lastShot, true)).toEqual({ x: 1100, y: 800 });
    expect(mapNativeToCss(1100, 800, 2.5)).toEqual({ x: 440, y: 320 });
  });

  it('round-trips native points through the shot scale', () => {
    expect(roundTrip(200, 100, 0.5)).toEqual({ x: 200, y: 100 });
  });

  it('maps displayed CSS pixels onto native computer pixels', () => {
    const displayed = { width: 100, height: 50 };
    const native = { width: 8, height: 8 };
    expect(mapDisplayedToNative(50, 25, displayed, native)).toEqual({ x: 4, y: 4 });
    expect(mapDisplayedToNative(-1, 999, displayed, native)).toEqual({ x: 0, y: 7 });
    expect(mapDisplayedToNative(10, 10, displayed, { width: 0, height: 0 })).toEqual({
      x: 10,
      y: 10,
    });
    expect(mapDisplayedToNative(1, 1, { width: 0, height: 0 }, native)).toEqual({
      x: 0,
      y: 0,
    });
  });
});
