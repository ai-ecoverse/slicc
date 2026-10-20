/**
 * `six-step-aside.ts` — six's half of "one-way per browser" on www
 * (slicc#4051, ai-ecoverse/slicc-bios#648). Once seven has moved this
 * browser's profile in place it sets `localStorage['slicc-os.six'] =
 * 'upgraded'`. From then on six's page on the hosted origin replaces itself
 * with seven's UI at `/os/`, from `/`, `/join/<token>` and every other route
 * that serves six's app, before it registers `/preview-sw.js` or
 * `/llm-proxy-sw.js`: two apps can't share scope `/`, and six's `/preview/`
 * serves agent-written HTML unsandboxed on the origin seven now owns.
 *
 * Hosted origin only. The CLI's browser profile and the extension's own
 * pages keep Export for SLICC 7; seven never sets the marker there.
 */

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';

/** Set by seven once this browser's six profile has moved. */
export const SIX_UPGRADED_KEY = 'slicc-os.six';
export const SIX_UPGRADED_VALUE = 'upgraded';
/** Seven's UI on www. */
export const SEVEN_OS_URL_PATH = '/os/';

export interface StepAsideWindow {
  location: { origin: string; replace(url: string): void };
  localStorage?: Pick<Storage, 'getItem'> | null;
}

function readMarker(win: StepAsideWindow): string | null {
  try {
    return win.localStorage?.getItem(SIX_UPGRADED_KEY) ?? null;
  } catch {
    return null;
  }
}

/** True on the hosted origin once seven has taken this browser over. */
export function shouldStepAsideForSeven(win: StepAsideWindow): boolean {
  return win.location.origin === SLICC_HOSTED_ORIGIN && readMarker(win) === SIX_UPGRADED_VALUE;
}

/**
 * Replace the page with `/os/` when six must step aside. Returns true when it
 * did; the caller stops booting (no service worker, no kernel).
 */
export function stepAsideForSeven(win: StepAsideWindow): boolean {
  if (!shouldStepAsideForSeven(win)) return false;
  win.location.replace(SEVEN_OS_URL_PATH);
  return true;
}
