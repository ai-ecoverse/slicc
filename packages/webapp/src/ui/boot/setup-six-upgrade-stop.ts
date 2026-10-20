/**
 * `setup-six-upgrade-stop.ts` — the boot step that lets seven's upgrade stop
 * this six page (slicc#4051, `six-upgrade-stop.ts`). Runs in `main.ts` before
 * service-worker registration and before any kernel spawns, so a page that
 * boots while the exporter waits for or holds {@link SIX_KERNEL_LOCK} shows
 * the moved notice and registers nothing: six's `llm-proxy-sw.js` would take
 * scope `/` from seven's service worker.
 */

import {
  claimSixKernelLock,
  defaultSixLockManager,
  holdSixKernelLock,
  installSixUpgradeStopListener,
  isSixStoppedForUpgrade,
  type SixChannel,
  type SixLockManager,
  stopSixPageForUpgrade,
} from '../six-upgrade-stop.js';

export { SIX_KERNEL_LOCK } from '../six-upgrade-stop.js';

/**
 * Listen for the stop, then take the page's shared lock. Resolves true when
 * the page must not boot (the upgrade is running and the notice is shown).
 */
export async function setupSixUpgradeStop(
  doc: Document,
  opts: { locks?: SixLockManager | null; channel?: SixChannel | null } = {}
): Promise<boolean> {
  installSixUpgradeStopListener(doc, opts.channel);
  const claim = await claimSixKernelLock(
    opts.locks === undefined ? defaultSixLockManager() : opts.locks
  );
  if (!claim) {
    stopSixPageForUpgrade();
    return true;
  }
  holdSixKernelLock(claim.release);
  return isSixStoppedForUpgrade();
}
