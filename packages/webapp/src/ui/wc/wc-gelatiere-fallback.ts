import type { LickEvent } from '@slicc/shared-ts';
import type { GelatiereVfs } from '../../base/gelatiere-store.js';
import type { BootStageLogger } from '../boot/types.js';

const CARD_ACTIONS: Record<string, { consume: boolean; mode: 'dismiss' | 'take' }> = {
  'gelatiere-dismiss': { consume: true, mode: 'dismiss' },
  'gelatiere-install': { consume: false, mode: 'take' },
  'gelatiere-try': { consume: false, mode: 'take' },
};

export interface GelatiereFallbackDeps {
  openVfs(): Promise<GelatiereVfs>;
  log: BootStageLogger;
}

export function makeGelatiereCardFallback(
  deps: GelatiereFallbackDeps
): (event: LickEvent) => boolean {
  return (event: LickEvent): boolean => {
    if (event.type !== 'sprinkle') return false;

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
