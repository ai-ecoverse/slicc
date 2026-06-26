// Injection glue for the `<slicc-launcher>` overlay web component. Mounts (or
// reuses) the launcher in a target document and applies the open/appUrl/corner
// options. The exposed host id (`slicc-electron-overlay-root`) and the
// `window.__SLICC_ELECTRON_OVERLAY__` API surface (see `overlay-entry.ts`) are
// unchanged so `node-server`/`swift-server` Electron injection keep working.

import { type LauncherCorner, normalizeLauncherCorner } from './launcher-state.js';
import { SliccLauncher } from './slicc-launcher.js';

export const SLICC_LAUNCHER_HOST_ID = 'slicc-electron-overlay-root';

export interface InjectSliccLauncherOptions {
  open?: boolean;
  appUrl?: string | null;
  corner?: string | null;
  /** Accepted for backward compatibility with the legacy overlay; ignored. */
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
