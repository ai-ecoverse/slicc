/**
 * Page-side session-end hook for the gelatiere (`scoops/gelatiere-unit.ts`).
 *
 * "New chat" is the moment a session ends, so the freezer calls
 * {@link notifyGelatiereOfSessionEnd} once the archive is settled (and,
 * under `agentic-memory`, once the curator has finished — two agents mining
 * the same archive at once would double the bill). The hook does not run a
 * pass itself: it sends the gelatiere unit a `session-settled` lick and the
 * unit does the work in its own conversation. The interval in
 * `/shared/GELATIERE.md` (a day by default) caps how often a session end
 * may trigger a pass; the nightly crontask is independent of it.
 */

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
  /** The cone whose session just ended. */
  cone?: { folder: string; jid?: string };
  /** The archive that was written, when the freezer has its name. */
  archive?: string;
  /** Gate override for tests; defaults to the `memory-v2` feature flag. */
  isEnabled?: () => boolean;
  now?: () => Date;
}

/** The body of the `session-settled` lick the gelatiere receives. */
export interface GelatiereSessionSettledBody {
  action: 'session-settled';
  data: { cone?: string; archive?: string };
}

/**
 * The interval gate is a read → check → stamp sequence over the shared state
 * file. Two cones settling sessions in the same tick would both read the
 * same "due" state before either stamped it, and both would lick — two
 * billable passes for one interval. Every call queues behind the previous
 * one on this chain so the second read sees the first stamp.
 */
let gate: Promise<unknown> = Promise.resolve();

/**
 * Lick the gelatiere if the flag is on, the unit exists, and a pass is due.
 * Resolves `true` when a lick was sent. Never throws — the freezer's clear
 * must not wait on, or fail on, this. Concurrent callers are serialized
 * (see {@link gate}).
 */
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
    // The interval gate's write half. Stamped HERE, where the trigger was
    // decided — a pass that (legitimately) suggests nothing never runs
    // `gelatiere suggest`, so `lastPassAt` alone would let every subsequent
    // "New chat" re-lick a billable pass.
    await recordGelatiereTrigger(deps.vfs, now);
    deps.log.info('gelatiere told a session ended', { cone: deps.cone?.folder });
    return true;
  } catch (err) {
    deps.log.warn('gelatiere session-end notification failed', err);
    return false;
  }
}
