/**
 * `setup-onboarding.ts` — boot stage that wraps the welcome
 * detection caller body shared by `mainStandaloneWorker`
 * (~main.ts:3355–3369) and `mainExtension` (~main.ts:1759–1784).
 * Behavior is unchanged — identical handler body extracted into a
 * single helper so both boot paths invoke the same code.
 *
 * The fast-forward final-lick helper itself (`fireFastForwardFinalLick`
 * in `main.ts`) stays top-level: it's invoked from the connect-ready
 * dip handlers (not from the boot path), and the dispatch wrapping
 * differs per float (standalone uses `dispatchWelcomeLickOnce` against
 * `client.sendSprinkleLick`, extension against the same client surface
 * but via the extension's own ledger). Only the welcome detection
 * caller body — which is byte-for-byte identical between the two
 * floats — moves here.
 */

import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import { detectWelcomeFirstRun } from '../../scoops/welcome-detection.js';
import type { OnboardingSetupDeps } from './types.js';

/**
 * Drive the first-run flow locally. The deterministic onboarding
 * orchestrator owns the welcome dip + intro lines until the user
 * configures a provider — handing it to the cone would fatal with
 * "No API key configured for provider …" before the wizard even
 * appears. The persistent dedup ledger guards against reload
 * double-fires (see `DEDUPED_WELCOME_ACTIONS` in `main.ts`).
 *
 * No-op when a tray-join URL is stored: a follower instance is
 * driven by its leader's chat history and should never re-render
 * the welcome flow.
 *
 * Mirrors the standalone and extension caller bodies exactly: when
 * detection insists this is genuinely a fresh boot (no
 * `/shared/.welcomed` marker AND no welcome lick in chat history)
 * but the in-memory ledger has a stale `first-run` entry from a
 * previous install whose state was wiped (clear-site-data, IndexedDB
 * nuke, manual VFS reset), suppressing here would leave the user
 * with no welcome and no deterministic onboarding path. Trust the
 * install state over the ledger and clear the stale entry. The
 * ledger still protects against intra-session double-fires (the
 * detection promise can resolve twice during a noisy boot), because
 * we re-add it before handing off.
 */
export function runFirstRunDetection(deps: OnboardingSetupDeps): void {
  const { vfs, storage, firedWelcomeActions, persistFiredWelcomeActions, getOrchestrator, log } =
    deps;

  if (hasStoredTrayJoinUrl(storage)) return;

  detectWelcomeFirstRun(vfs)
    .then((result) => {
      if (!result.isFirstRun) return;
      if (firedWelcomeActions.has('first-run')) {
        log.info('Clearing stale welcome dedup entry — install state is fresh');
        firedWelcomeActions.delete('first-run');
        persistFiredWelcomeActions(firedWelcomeActions);
      }
      firedWelcomeActions.add('first-run');
      persistFiredWelcomeActions(firedWelcomeActions);
      getOrchestrator().handleFirstRun();
    })
    .catch((err) => log.warn('Welcome detection failed', err));
}
