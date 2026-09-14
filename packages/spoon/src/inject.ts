import { type LauncherCorner, normalizeLauncherCorner } from './launcher-state.js';
import { SliccLauncher } from './slicc-launcher.js';

export const SLICC_LAUNCHER_HOST_ID = 'slicc-electron-overlay-root';

export interface InjectSliccLauncherOptions {
  open?: boolean;
  appUrl?: string | null;
  corner?: string | null;

  statusMessage?: string | null;

  activeTab?: string | null;
}

export function injectSliccLauncher(
  targetDocument: Document = document,
  options: InjectSliccLauncherOptions = {}
): SliccLauncher {
  const existing = targetDocument.getElementById(SLICC_LAUNCHER_HOST_ID);
  let launcher: SliccLauncher;

  if (existing instanceof SliccLauncher) {
    launcher = existing;
  } else {
    existing?.remove();
    launcher = targetDocument.createElement('slicc-launcher') as SliccLauncher;
  }

  launcher.id = SLICC_LAUNCHER_HOST_ID;

  if (!launcher.isConnected) {
    (targetDocument.body ?? targetDocument.documentElement).appendChild(launcher);
  }

  if (options.appUrl !== undefined) {
    launcher.appUrl = options.appUrl ?? '';
  }
  if (options.statusMessage !== undefined) {
    launcher.statusMessage = options.statusMessage ?? '';
  }
  if (typeof options.open === 'boolean') {
    launcher.open = options.open;
  }
  if (options.corner !== undefined) {
    const next: LauncherCorner = normalizeLauncherCorner(options.corner);
    launcher.corner = next;
  }

  return launcher;
}

export function removeSliccLauncher(targetDocument: Document = document): void {
  targetDocument.getElementById(SLICC_LAUNCHER_HOST_ID)?.remove();
}
