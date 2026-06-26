// Content script that injects the SLICC launcher overlay into every page.
//
// The launcher is the `<slicc-launcher>` web component from
// `@slicc/webcomponents` (Wave 2 of the thin-extension migration): a floating
// button + sidebar-iframe shell with corner persistence. Clicking the button
// opens the sliccy.ai webapp inside the iframe in cherry-follower mode, so
// this content script ships no webapp bundle — only the launcher web
// component itself. The framing block (`frame-ancestors 'none'` on every
// non-cherry SPA response) is relaxed for the `?cherry=1` cherry-follower
// `sub_frame` on sliccy.ai via the static DNR ruleset in
// `dnr-frame-ancestors.json` — scoped to the cherry surface so the override
// can't make arbitrary sliccy.ai subframes (e.g. the leader UI) frameable.
//
// Mirrors the Electron injection precedent in `@ai-ecoverse/spoon`'s
// `overlay-entry.ts` / `inject.ts`. The launcher lives in its own self-contained
// package, so importing the spoon barrel pulls in ONLY the launcher + glue (no
// other `slicc-*` component side-effect `define()` registrations).
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

import { SliccLauncher } from '@ai-ecoverse/spoon';

/** Hosted (production) cherry-follower URL. Read by `dnr-frame-ancestors.test.ts`
 *  as a source-text literal to verify the production URL invariant — keep the
 *  exact `const PROD_SLICC_APP_URL =` declaration form so the regex match
 *  still picks it up after renames. */
const PROD_SLICC_APP_URL = 'https://www.sliccy.ai/?cherry=1';
/** Local wrangler dev-server cherry-follower URL. Selected when the extension
 *  was built with `SLICC_EXT_DEV=1` (see `vite.config.ts` `__SLICC_EXT_DEV__`),
 *  which is the same signal that strips the manifest `key` and widens
 *  `externally_connectable` to localhost. Points at the two-service dev
 *  harness UI origin (wrangler on :8787), not the thin-bridge backend port. */
const DEV_SLICC_APP_URL = 'http://localhost:8787/?cherry=1';
/** Hosted (production) SLICC origin. */
const PROD_SLICC_APP_ORIGIN = 'https://www.sliccy.ai';
/** Local wrangler dev-server SLICC origin (paired with `DEV_SLICC_APP_URL`). */
const DEV_SLICC_APP_ORIGIN = 'http://localhost:8787';

const SLICC_LAUNCHER_HOST_ID = 'slicc-electron-overlay-root';

/** Pure resolver — returns the cherry-follower URL the launcher should point
 *  its iframe at. Parameterized on the build-time `__SLICC_EXT_DEV__` flag so
 *  unit tests can exercise both branches without rebuilding. */
export function getSliccAppUrl(isExtDev: boolean): string {
  return isExtDev ? DEV_SLICC_APP_URL : PROD_SLICC_APP_URL;
}

/** Pure resolver — returns the canonical SLICC app origin used by the
 *  defensive in-script injection guard. Dev builds compare against
 *  `http://localhost:8787` so the leader-served-from-wrangler page does not
 *  self-inject the launcher. */
export function getSliccAppOrigin(isExtDev: boolean): string {
  return isExtDev ? DEV_SLICC_APP_ORIGIN : PROD_SLICC_APP_ORIGIN;
}

const SLICC_APP_URL = getSliccAppUrl(__SLICC_EXT_DEV__);

/** SLICC app origin. The launcher MUST NOT inject on this origin — the leader
 *  tab (`https://www.sliccy.ai/?slicc=leader` in prod, `http://localhost:8787/?slicc=leader`
 *  in dev) IS the real SLICC UI, and a cherry iframe loaded from the same
 *  origin already runs the webapp; injecting the launcher on top would
 *  self-recurse. Mirrors `BRIDGE_ALLOWED_ORIGINS` in `bridge-sw.ts` as the
 *  single canonical origin check. The manifest's `content_scripts[].exclude_matches`
 *  is the primary gate; this constant exists for the defensive in-script guard
 *  so future `all_frames` or programmatic injection paths still skip the SLICC
 *  origin. */
export const SLICC_APP_ORIGIN = getSliccAppOrigin(__SLICC_EXT_DEV__);

export function shouldInjectLauncher(origin: string): boolean {
  return origin !== SLICC_APP_ORIGIN;
}

export function injectLauncher(): void {
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

export function bootstrap(origin: string): void {
  if (!shouldInjectLauncher(origin)) return;
  try {
    injectLauncher();
  } catch (e) {
    console.error('[slicc-launcher] Injection failed:', e);
  }
}

bootstrap(location.origin);
