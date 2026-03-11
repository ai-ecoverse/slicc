import {
  DEFAULT_EXTENSION_TAB_ID,
  type ExtensionTabId,
  normalizeExtensionTabId,
} from './tabbed-ui.js';

export const ELECTRON_OVERLAY_LAUNCHER_CORNERS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type ElectronOverlayLauncherCorner = (typeof ELECTRON_OVERLAY_LAUNCHER_CORNERS)[number];

export const DEFAULT_ELECTRON_OVERLAY_LAUNCHER_CORNER: ElectronOverlayLauncherCorner = 'top-right';
export const ELECTRON_OVERLAY_LAUNCHER_DRAG_THRESHOLD_PX = 6;
export const ELECTRON_OVERLAY_LAUNCHER_FLICK_THRESHOLD_PX = 12;
export const ELECTRON_OVERLAY_LAUNCHER_FLICK_THRESHOLD_PX_PER_MS = 0.6;

export interface ElectronOverlayShellState {
  open: boolean;
  activeTab: ExtensionTabId;
  corner: ElectronOverlayLauncherCorner;
}

export function normalizeElectronOverlayLauncherCorner(
  corner: string | null | undefined,
  fallback: ElectronOverlayLauncherCorner = DEFAULT_ELECTRON_OVERLAY_LAUNCHER_CORNER,
): ElectronOverlayLauncherCorner {
  return ELECTRON_OVERLAY_LAUNCHER_CORNERS.includes(corner as ElectronOverlayLauncherCorner)
    ? (corner as ElectronOverlayLauncherCorner)
    : fallback;
}

export function createElectronOverlayShellState(
  init: Partial<ElectronOverlayShellState> = {},
): ElectronOverlayShellState {
  return {
    open: init.open ?? false,
    activeTab: normalizeExtensionTabId(init.activeTab, DEFAULT_EXTENSION_TAB_ID),
    corner: normalizeElectronOverlayLauncherCorner(init.corner),
  };
}

export function toggleElectronOverlay(
  state: ElectronOverlayShellState,
): ElectronOverlayShellState {
  return {
    ...state,
    open: !state.open,
  };
}

export function setElectronOverlayOpen(
  state: ElectronOverlayShellState,
  open: boolean,
): ElectronOverlayShellState {
  return state.open === open ? state : { ...state, open };
}

export function setElectronOverlayTab(
  state: ElectronOverlayShellState,
  tab: string | null | undefined,
): ElectronOverlayShellState {
  const activeTab = normalizeExtensionTabId(tab, state.activeTab);
  return state.activeTab === activeTab ? state : { ...state, activeTab };
}

export function setElectronOverlayCorner(
  state: ElectronOverlayShellState,
  corner: string | null | undefined,
): ElectronOverlayShellState {
  const nextCorner = normalizeElectronOverlayLauncherCorner(corner, state.corner);
  return state.corner === nextCorner ? state : { ...state, corner: nextCorner };
}

export function shouldSnapElectronOverlayLauncher(
  distancePx: number,
  velocityPxPerMs: number,
): boolean {
  return (
    distancePx >= ELECTRON_OVERLAY_LAUNCHER_DRAG_THRESHOLD_PX ||
    (distancePx >= ELECTRON_OVERLAY_LAUNCHER_FLICK_THRESHOLD_PX &&
      velocityPxPerMs >= ELECTRON_OVERLAY_LAUNCHER_FLICK_THRESHOLD_PX_PER_MS)
  );
}

export interface ResolveElectronOverlayLauncherCornerInput {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
  velocityXPxPerMs?: number;
  velocityYPxPerMs?: number;
  flickProjectionMs?: number;
}

export function resolveElectronOverlayLauncherCorner({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
  velocityXPxPerMs = 0,
  velocityYPxPerMs = 0,
  flickProjectionMs = 180,
}: ResolveElectronOverlayLauncherCornerInput): ElectronOverlayLauncherCorner {
  const projectedX = clamp(clientX + velocityXPxPerMs * flickProjectionMs, 0, viewportWidth);
  const projectedY = clamp(clientY + velocityYPxPerMs * flickProjectionMs, 0, viewportHeight);
  const horizontal = projectedX < viewportWidth / 2 ? 'left' : 'right';
  const vertical = projectedY < viewportHeight / 2 ? 'top' : 'bottom';
  return `${vertical}-${horizontal}` as ElectronOverlayLauncherCorner;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}