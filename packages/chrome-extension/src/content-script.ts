// Content script that injects the SLICC launcher overlay into every page.
//
// The launcher is the `<slicc-launcher>` web component from
// `@slicc/webcomponents` (Wave 2 of the thin-extension migration): a floating
// button + sidebar-iframe shell with corner persistence. Clicking the button
// opens the sliccy.ai webapp inside the iframe in cherry-follower mode, so
// this content script ships no webapp bundle — only the launcher web
// component itself. The framing block (`frame-ancestors 'none'` on every
// non-cherry SPA response) is relaxed for `sub_frame` requests to sliccy.ai
// via the static DNR ruleset in `dnr-frame-ancestors.json`.
//
// Mirrors the Electron injection precedent in
// `packages/webapp/src/ui/electron-overlay-entry.ts` /
// `packages/webapp/src/ui/slicc-launcher-inject.ts`, but imports the launcher
// module directly (not via the barrel) so esbuild does not drag every other
// `slicc-*` component along through their side-effect `define()` registrations.
//
// **MAIN-world content script** (manifest `content_scripts[].world = "MAIN"`):
// Chrome MV3 content-script ISOLATED worlds expose `customElements` as `null`
// (Chrome 146 verified), so `define('slicc-launcher', …)` would throw and the
// element would never upgrade. Custom-element registries are per-world, so the
// launcher MUST register + mount in the page's MAIN world. Side effect: this
// realm has no `chrome.runtime` / `chrome.tabs` access — that is fine for the
// pure-UI launcher (it loads sliccy.ai by URL in an iframe). The future Wave
// 3b CDP relay, which needs `chrome.runtime`, will live in a SEPARATE content
// script entry that stays in the default ISOLATED world.

import { SliccLauncher } from '@slicc/webcomponents/src/launcher/slicc-launcher.js';

const SLICC_APP_URL = 'https://www.sliccy.ai/?cherry=1';
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
