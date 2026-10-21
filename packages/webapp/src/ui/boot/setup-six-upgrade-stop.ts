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

export async function setupSixUpgradeStop(
  doc: Document,
  opts: { locks?: SixLockManager | null; channel?: SixChannel | null } = {}
): Promise<boolean> {
  installSixUpgradeStopListener(doc, opts.channel);
  const claim = await claimSixKernelLock(
    opts.locks === undefined ? defaultSixLockManager() : opts.locks
  );
  if (!claim) {
    await stopSixPageForUpgrade();
    return true;
  }
  holdSixKernelLock(claim.release);
  return isSixStoppedForUpgrade();
}
