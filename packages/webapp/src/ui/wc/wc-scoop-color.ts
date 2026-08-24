/**
 * Stable scoop accent colors, shared by the switcher chips, the thread
 * context tint, and scoop-originating lick tags — anything that paints a
 * scoop's hue must hash the same way or the colors drift apart.
 */

export const CONE_COLOR = '#b07823';
export const SCOOP_PALETTE = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];

/**
 * Stable palette pick for a unit chip, keyed by name. Roots (cones) all
 * share {@link CONE_COLOR}; callers derive `isRoot` from the ownership edge
 * (`isRootUnit` on a record, `summaryIsRoot` on a wire summary) — the role
 * is never read off the record (#2279).
 */
export function scoopColor(scoop: { isRoot: boolean; name: string }): string {
  if (scoop.isRoot) return CONE_COLOR;
  let hash = 0;
  for (const ch of scoop.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SCOOP_PALETTE[hash % SCOOP_PALETTE.length];
}
