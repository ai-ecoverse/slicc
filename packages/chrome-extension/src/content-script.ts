// Dormant MAIN-world `<slicc-launcher>` module — retained for legacy compatibility.
//
// This file is NO LONGER a manifest `content_scripts[]` entry and does NOT
// auto-inject on every page. The every-page injection it once performed was
// disabled (commit f989f6f48) because most pages don't need it and the bare
// `?cherry=1` iframe it mounted never connected to the extension leader.
//
// On-demand per-page cherry sidebar injection is now PROGRAMMATIC via
// `chrome.scripting.executeScript` on toolbar-icon click — see
// `cherry-sidebar-main.ts` (MAIN-world launcher + connected `mountSlicc`) and
// `relay-isolated.ts` (ISOLATED-world SW relay). The framing relaxation for the
// `?cherry=1` cherry-follower `sub_frame` on sliccy.ai still comes from the
// static DNR ruleset in `dnr-frame-ancestors.json`.
//
// Historical note: MV3 content-script ISOLATED worlds expose `customElements`
// as `null` (Chrome 146), so a launcher content script had to register + mount
// in the page MAIN world; the on-demand path injects the MAIN-world entry the
// same way. This module is kept only for backward compatibility during the
// thin-extension rollout and can be removed once on-demand injection is stable.

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
