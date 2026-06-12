/**
 * Stable scoop accent colors, shared by the switcher chips, the thread
 * context tint, and scoop-originating lick tags — anything that paints a
 * scoop's hue must hash the same way or the colors drift apart.
 */

import type { RegisteredScoop } from '../../scoops/types.js';

export const CONE_COLOR = '#b07823';
export const SCOOP_PALETTE = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];

/** Stable palette pick for a scoop chip, keyed by name. */
export function scoopColor(scoop: Pick<RegisteredScoop, 'isCone' | 'name'>): string {
  if (scoop.isCone) return CONE_COLOR;
  let hash = 0;
  for (const ch of scoop.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SCOOP_PALETTE[hash % SCOOP_PALETTE.length];
}
