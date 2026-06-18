// Electron-overlay rewire (Wave 2 of the thin-extension migration).
//
// The bundled entry script that Electron injects into target pages used to mount
// the legacy `<slicc-electron-overlay>` element (the launcher + sidebar + tab
// protocol all in one class). It now mounts the new `<slicc-launcher>` web
// component from `@slicc/webcomponents` — the simpler floating-button +
// sidebar-iframe shell with corner persistence and a double-click focus event.
//
// The exposed global API (`window.__SLICC_ELECTRON_OVERLAY__.inject` /
// `.remove`) is unchanged so `node-server/src/electron-main.ts`'s `injectOverlay`
// keeps working with no behaviour regression.

import { type LauncherCorner, normalizeLauncherCorner, SliccLauncher } from '@slicc/webcomponents';

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
