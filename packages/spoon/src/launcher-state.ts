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
export const LAUNCHER_STORAGE_KEY = 'slicc-launcher-corner';

export const LAUNCHER_FOLLOWER_STATUSES = ['disconnected', 'connected', 'error'] as const;
export type LauncherFollowerStatus = (typeof LAUNCHER_FOLLOWER_STATUSES)[number];
export const DEFAULT_LAUNCHER_FOLLOWER_STATUS: LauncherFollowerStatus = 'disconnected';
export const LAUNCHER_FOLLOWER_STATUS_ATTR = 'follower-status';

const CORNER_SET = new Set<string>(LAUNCHER_CORNERS);
const FOLLOWER_STATUS_SET = new Set<string>(LAUNCHER_FOLLOWER_STATUSES);

export function normalizeLauncherCorner(
  corner: string | null | undefined,
  fallback: LauncherCorner = DEFAULT_LAUNCHER_CORNER
): LauncherCorner {
  return corner && CORNER_SET.has(corner) ? (corner as LauncherCorner) : fallback;
}

export function normalizeLauncherFollowerStatus(
  status: string | null | undefined,
  fallback: LauncherFollowerStatus = DEFAULT_LAUNCHER_FOLLOWER_STATUS
): LauncherFollowerStatus {
  return status && FOLLOWER_STATUS_SET.has(status) ? (status as LauncherFollowerStatus) : fallback;
}

export function shouldSnapLauncher(distancePx: number): boolean {
  return distancePx >= LAUNCHER_DRAG_THRESHOLD_PX;
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
