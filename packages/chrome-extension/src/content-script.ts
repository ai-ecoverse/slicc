// Content script that injects the SLICC launcher overlay into every page.
//
// The launcher is the `<slicc-launcher>` web component from
// `@slicc/webcomponents` (Wave 2 of the thin-extension migration): a floating
// button + sidebar-iframe shell with corner persistence. Clicking the button
// opens the sliccy.ai webapp inside the iframe, so this content script ships
// no webapp bundle — only the launcher web component itself.
//
// Mirrors the Electron injection precedent in
// `packages/webapp/src/ui/electron-overlay-entry.ts` /
// `packages/webapp/src/ui/slicc-launcher-inject.ts`, but imports the launcher
// module directly (not via the barrel) so esbuild does not drag every other
// `slicc-*` component along through their side-effect `define()` registrations.

import { SliccLauncher } from '@slicc/webcomponents/src/launcher/slicc-launcher.js';

const SLICC_APP_URL = 'https://sliccy.ai';
const SLICC_LAUNCHER_HOST_ID = 'slicc-electron-overlay-root';

function injectLauncher(): void {
  const existing = document.getElementById(SLICC_LAUNCHER_HOST_ID);
  let launcher: SliccLauncher;

  if (existing instanceof SliccLauncher) {
    launcher = existing;
  } else {
    existing?.remove();
    launcher = document.createElement('slicc-launcher') as SliccLauncher;
  }

  launcher.id = SLICC_LAUNCHER_HOST_ID;
  launcher.appUrl = SLICC_APP_URL;

  if (!launcher.isConnected) {
    (document.body ?? document.documentElement).appendChild(launcher);
  }
}

try {
  injectLauncher();
} catch (e) {
  console.error('[slicc-launcher] Injection failed:', e);
}
