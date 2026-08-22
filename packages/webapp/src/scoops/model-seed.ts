/**
 * The one place the GLOBAL model selection is still read (#2310).
 *
 * Model selection is per work unit and lives on the record
 * ({@link RegisteredScoop.model}). The legacy global `selected-model` /
 * `selected-provider` pair survives for exactly two jobs:
 *
 * 1. seeding the primary cone the first time a profile boots, and
 * 2. as the migration source for records saved before `model` existed.
 *
 * Nothing else may reach for it — a global picker is precisely what per-cone
 * model selection replaces.
 */

import { createLogger } from '../base/logger.js';
import { getSelectedProvider, resolveCurrentModel } from '../providers/account-store.js';
import type { WorkUnitModel } from './types.js';

const log = createLogger('model-seed');

/**
 * The globally selected provider + model as a work-unit model, or
 * `undefined` when nothing is selectable yet (no account configured, or no
 * storage — a fresh or headless profile). `undefined` is not an error: the
 * unit simply carries no model and resolves the global selection at run
 * time, and the next boot backfills it.
 */
export function globalSeedModel(): WorkUnitModel | undefined {
  try {
    const provider = getSelectedProvider();
    const id = resolveCurrentModel().id;
    return provider && id ? { provider, id } : undefined;
  } catch (err) {
    log.debug('No global model selection to seed from', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
