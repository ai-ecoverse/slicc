import type { ComputerLastShot, ComputerSize } from '@slicc/shared-ts';

export const SIZE_PRESETS = { low: 256, medium: 768, high: 1536 } as const;
export type SizePresetName = keyof typeof SIZE_PRESETS;

export interface ScaleMapping {
  nativeWidth: number;
  nativeHeight: number;
  shotWidth: number;
  shotHeight: number;
  scale: number;
}

export function parseSizeSpec(spec: string | undefined): number {
  if (!spec) return SIZE_PRESETS.medium;
  if (spec in SIZE_PRESETS) return SIZE_PRESETS[spec as SizePresetName];
  const m = /^(\d+)(?:x\d+)?$/u.exec(spec);
  if (m) {
    const n = Number.parseInt(m[1], 10);
    if (n > 0) return n;
  }
  return SIZE_PRESETS.medium;
}

export function scaleFromNative(native: ComputerSize, maxWidth: number): ScaleMapping {
  if (native.width <= 0 || native.height <= 0) {
    return {
      nativeWidth: native.width,
      nativeHeight: native.height,
      shotWidth: native.width,
      shotHeight: native.height,
      scale: 1,
    };
  }
  const scale = native.width > maxWidth ? maxWidth / native.width : 1;
  return {
    nativeWidth: native.width,
    nativeHeight: native.height,
    shotWidth: Math.max(1, Math.round(native.width * scale)),
    shotHeight: Math.max(1, Math.round(native.height * scale)),
    scale,
  };
}

export function scaleFromEncoded(native: ComputerSize, encoded: ComputerSize): ScaleMapping {
  const nativeWidth = native.width > 0 ? native.width : encoded.width;
  const nativeHeight = native.height > 0 ? native.height : encoded.height;
  const shotWidth = encoded.width;
  const shotHeight = encoded.height;
  const scale = nativeWidth > 0 ? shotWidth / nativeWidth : 1;
  return {
    nativeWidth,
    nativeHeight,
    shotWidth,
    shotHeight,
    scale: scale > 0 ? scale : 1,
  };
}

export function formatScaleLine(mapping: ScaleMapping): string {
  const s =
    mapping.scale === 1 ? '1' : mapping.scale.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
  return `${mapping.nativeWidth}x${mapping.nativeHeight} → ${mapping.shotWidth}x${mapping.shotHeight} (scale ${s})`;
}

export function toLastShot(mapping: ScaleMapping, at: number): ComputerLastShot {
  return {
    width: mapping.shotWidth,
    height: mapping.shotHeight,
    scale: mapping.scale,
    at,
  };
}

export function mapPoint(
  x: number,
  y: number,
  lastShot: ComputerLastShot | undefined,
  native: boolean
): { x: number; y: number } {
  if (native || !lastShot || lastShot.scale === 0) return { x, y };
  return {
    x: Math.round(x / lastShot.scale),
    y: Math.round(y / lastShot.scale),
  };
}

export function mapNativeToCss(
  x: number,
  y: number,
  devicePixelRatio: number
): { x: number; y: number } {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (dpr === 1) return { x, y };
  return {
    x: Math.round(x / dpr),
    y: Math.round(y / dpr),
  };
}

export function roundTrip(x: number, y: number, scale: number): { x: number; y: number } {
  if (scale === 0) return { x, y };
  const shotX = Math.round(x * scale);
  const shotY = Math.round(y * scale);
  return { x: Math.round(shotX / scale), y: Math.round(shotY / scale) };
}

export function mapDisplayedToNative(
  x: number,
  y: number,
  displayed: ComputerSize,
  native: ComputerSize
): { x: number; y: number } {
  if (displayed.width <= 0 || displayed.height <= 0) return { x: 0, y: 0 };
  const nx = native.width > 0 ? native.width : displayed.width;
  const ny = native.height > 0 ? native.height : displayed.height;
  return {
    x: Math.max(0, Math.min(nx - 1, Math.round((x / displayed.width) * nx))),
    y: Math.max(0, Math.min(ny - 1, Math.round((y / displayed.height) * ny))),
  };
}
