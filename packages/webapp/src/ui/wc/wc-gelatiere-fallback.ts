/**
 * Gelatiere card settlement for floats WITHOUT the onboarding interceptor.
 *
 * The suggestion stream's card licks (`gelatiere-dismiss` / `-install` / `-try`)
 * are normally settled by `setup-welcome-flow.ts`, which `wc-live` wires only
 * outside the `cherry` and `hosted-leader` runtime modes — onboarding has no
 * business there, but the suggestion cards still render. Without this
 * fallback those floats forward every card click to the cone unsettled:
 * install/try leaves the card open (the cone-side skill assumes the page
 * already stamped it) and dismiss needlessly wakes the cone.
 *
 * The forward/consume DECISION is synchronous (the lick pipeline cannot
 * wait); the settlement write is fire-and-forget through the lazily imported
 * store module, which must stay off the first-load path — it drags the
 * bundled GELATIERE.md along.
 */

import type { LickEvent } from '@slicc/shared-ts';
import type { GelatiereVfs } from '../../base/gelatiere-store.js';
import type { BootStageLogger } from '../boot/types.js';

/** Card action → whether the lick stops page-side (dismiss) or goes on to the cone. */
const CARD_ACTIONS: Record<string, { consume: boolean; mode: 'dismiss' | 'take' }> = {
  'gelatiere-dismiss': { consume: true, mode: 'dismiss' },
  'gelatiere-install': { consume: false, mode: 'take' },
  'gelatiere-try': { consume: false, mode: 'take' },
};

export interface GelatiereFallbackDeps {
  openVfs(): Promise<GelatiereVfs>;
  log: BootStageLogger;
}

/**
 * Build the fallback interceptor. Returns `true` when the lick was consumed
 * page-side and must not reach the cone — the same contract as
 * `interceptWelcomeLick`.
 */
export function makeGelatiereCardFallback(
  deps: GelatiereFallbackDeps
): (event: LickEvent) => boolean {
  return (event: LickEvent): boolean => {
    if (event.type !== 'sprinkle') return false;
    // 'inline' is the stream rendered as a chat dip; 'suggestions' is the
    // same stream opened as a rail sprinkle; 'welcome' predates the split
    // (the stream used to live inside the onboarding sprinkle).
    if (
      event.sprinkleName !== 'welcome' &&
      event.sprinkleName !== 'inline' &&
      event.sprinkleName !== 'suggestions'
    ) {
      return false;
    }
    const body = event.body as { action?: unknown; data?: unknown } | null;
    const action = typeof body?.action === 'string' ? body.action : '';
    const handling = CARD_ACTIONS[action];
    if (!handling) return false;
    const data = body?.data as { id?: unknown } | undefined;
    const id = typeof data?.id === 'string' && data.id ? data.id : null;
    if (id) {
      void deps
        .openVfs()
        .then(async (vfs) => {
          const store = await import('../../base/gelatiere-store.js');
          return handling.mode === 'dismiss'
            ? store.dismissGelatiereSuggestion(vfs, id)
            : store.takeGelatiereSuggestion(vfs, id);
        })
        .catch((err) => deps.log.warn('gelatiere card settlement failed', err));
    }
    return handling.consume;
  };
}
