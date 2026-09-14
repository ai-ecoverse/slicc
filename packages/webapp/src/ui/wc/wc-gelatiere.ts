import { GELATIERE_SPRINKLE_NAME, isGelatiereUnit } from '../../base/gelatiere-constants.js';
import {
  type GelatiereVfs,
  isPassDue,
  loadGelatiereConfig,
  readGelatiereState,
  recordGelatiereTrigger,
} from '../../base/gelatiere-store.js';
import { isFeatureEnabled } from '../../core/feature-flags.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';

export interface WcGelatiereDeps {
  client: Pick<OffscreenClient, 'sendSprinkleLick' | 'getScoops'>;
  vfs: GelatiereVfs;
  log: BootStageLogger;

  cone?: { folder: string; jid?: string };

  archive?: string;

  isEnabled?: () => boolean;
  now?: () => Date;
}

export interface GelatiereSessionSettledBody {
  action: 'session-settled';
  data: { cone?: string; archive?: string };
}

let gate: Promise<unknown> = Promise.resolve();

export function notifyGelatiereOfSessionEnd(deps: WcGelatiereDeps): Promise<boolean> {
  const turn = gate.then(() => announceSessionEnd(deps));
  gate = turn.catch(() => undefined);
  return turn;
}

async function announceSessionEnd(deps: WcGelatiereDeps): Promise<boolean> {
  const enabled = deps.isEnabled ?? (() => isFeatureEnabled('memory-v2'));
  if (!enabled()) return false;
  try {
    const unit = deps.client.getScoops().find(isGelatiereUnit);
    if (!unit) {
      deps.log.debug('gelatiere unit not registered; session end not announced');
      return false;
    }
    const [config, state] = await Promise.all([
      loadGelatiereConfig(deps.vfs),
      readGelatiereState(deps.vfs),
    ]);
    const now = (deps.now ?? (() => new Date()))();
    if (!isPassDue(state, now, config.intervalHours)) {
      deps.log.debug('gelatiere pass not due; session end not announced');
      return false;
    }
    const body: GelatiereSessionSettledBody = {
      action: 'session-settled',
      data: {
        ...(deps.cone ? { cone: deps.cone.folder } : {}),
        ...(deps.archive ? { archive: deps.archive } : {}),
      },
    };
    deps.client.sendSprinkleLick(GELATIERE_SPRINKLE_NAME, body, unit.folder);

    await recordGelatiereTrigger(deps.vfs, now);
    deps.log.info('gelatiere told a session ended', { cone: deps.cone?.folder });
    return true;
  } catch (err) {
    deps.log.warn('gelatiere session-end notification failed', err);
    return false;
  }
}
