/**
 * Pure state helpers for `<slicc-launcher>` — corner normalization, drag-snap
 * thresholds, and the corner-resolution math. Kept DOM-free so they can be
 * unit-tested independently of the custom element.
 */

export const LAUNCHER_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'top',
  'right',
  'bottom',
  'left',
] as const;

export type LauncherCorner = (typeof LAUNCHER_CORNERS)[number];

export const DEFAULT_LAUNCHER_CORNER: LauncherCorner = 'top-right';
export const LAUNCHER_OFFSET_PX = 18;
export const LAUNCHER_DRAG_THRESHOLD_PX = 6;
export const LAUNCHER_FLICK_THRESHOLD_PX = 12;
export const LAUNCHER_FLICK_THRESHOLD_PX_PER_MS = 0.6;
export const LAUNCHER_STORAGE_KEY = 'slicc-launcher-corner';

const CORNER_SET = new Set<string>(LAUNCHER_CORNERS);

/** Coerce a string into a valid launcher corner, falling back to `fallback`. */
export function normalizeLauncherCorner(
  corner: string | null | undefined,
  fallback: LauncherCorner = DEFAULT_LAUNCHER_CORNER
): LauncherCorner {
  return corner && CORNER_SET.has(corner) ? (corner as LauncherCorner) : fallback;
}

/** Whether a pointer movement is sufficient to leave click territory and snap. */
export function shouldSnapLauncher(distancePx: number, velocityPxPerMs: number): boolean {
  return (
    distancePx >= LAUNCHER_DRAG_THRESHOLD_PX ||
    (distancePx >= LAUNCHER_FLICK_THRESHOLD_PX &&
      velocityPxPerMs >= LAUNCHER_FLICK_THRESHOLD_PX_PER_MS)
  );
}

export interface ResolveCornerInput {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  velocityXPxPerMs?: number;
  velocityYPxPerMs?: number;
  flickProjectionMs?: number;
}

/**
 * Pick the launcher's snap target from the release position, projecting the
 * pointer forward by current velocity so a fast flick lands in the corner the
 * user "threw" toward. Splits the viewport into a 3×3 grid: middle cells use
 * the closest edge midpoint, outer cells use the matching corner.
 */
export function resolveLauncherCorner({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
  velocityXPxPerMs = 0,
  velocityYPxPerMs = 0,
  flickProjectionMs = 180,
}: ResolveCornerInput): LauncherCorner {
  const projectedX = clamp(clientX + velocityXPxPerMs * flickProjectionMs, 0, viewportWidth);
  const projectedY = clamp(clientY + velocityYPxPerMs * flickProjectionMs, 0, viewportHeight);
  const nx = projectedX / viewportWidth;
  const ny = projectedY / viewportHeight;
  const inMiddleX = nx > 1 / 3 && nx < 2 / 3;
  const inMiddleY = ny > 1 / 3 && ny < 2 / 3;
  if (inMiddleX && inMiddleY) {
    const distTop = ny;
    const distBottom = 1 - ny;
    const distLeft = nx;
    const distRight = 1 - nx;
    const min = Math.min(distTop, distBottom, distLeft, distRight);
    if (min === distTop) return 'top';
    if (min === distBottom) return 'bottom';
    if (min === distLeft) return 'left';
    return 'right';
  }
  if (inMiddleX) return ny < 0.5 ? 'top' : 'bottom';
  if (inMiddleY) return nx < 0.5 ? 'left' : 'right';
  const horizontal = nx < 0.5 ? 'left' : 'right';
  const vertical = ny < 0.5 ? 'top' : 'bottom';
  return `${vertical}-${horizontal}` as LauncherCorner;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
