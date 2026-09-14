import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import { detectWelcomeFirstRun } from '../../scoops/welcome-detection.js';
import type { OnboardingSetupDeps } from './types.js';

export function runFirstRunDetection(deps: OnboardingSetupDeps): void {
  const { vfs, storage, firedWelcomeActions, persistFiredWelcomeActions, getOrchestrator, log } =
    deps;

  if (hasStoredTrayJoinUrl(storage)) return;

  detectWelcomeFirstRun(vfs)
    .then((result) => {
      if (!result.isFirstRun) return;
      if (firedWelcomeActions.has('first-run')) {
        log.debug('Suppressing welcome re-fire: first-run already in dedup ledger');
        return;
      }
      firedWelcomeActions.add('first-run');
      persistFiredWelcomeActions(firedWelcomeActions);
      getOrchestrator().handleFirstRun();
    })
    .catch((err) => log.warn('Welcome detection failed', err));
}
