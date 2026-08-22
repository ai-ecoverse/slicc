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

import {
  getApiKeyForProvider,
  getSelectedProvider,
  resolveCurrentModel,
} from '../providers/account-store.js';
import type { WorkUnitModel } from './types.js';

/**
 * The globally selected provider + model as a work-unit model, or
 * `undefined` when there is nothing worth stamping yet.
 *
 * A seed is only taken when the selected provider actually has an account on
 * this device. On a fresh profile `getSelectedProvider()` /
 * `resolveCurrentModel()` answer with built-in DEFAULTS (Anthropic's current
 * model) long before the user has added anything, and the cone is bootstrapped
 * at that moment: stamping the default pins the primary cone to a provider the
 * user may never configure, and it then reports `No API key configured for
 * provider "anthropic"` even after they add a different one — because a record
 * model beats the global selection by design.
 *
 * `undefined` is not an error: the unit carries no model, resolves the global
 * selection at run time exactly as before, and the first boot after a real
 * account exists backfills it for good.
 */
export function globalSeedModel(): WorkUnitModel | undefined {
  try {
    const provider = getSelectedProvider();
    if (!provider || !getApiKeyForProvider(provider)) return undefined;
    const id = resolveCurrentModel().id;
    return id ? { provider, id } : undefined;
  } catch {
    // No storage at all (worker shim, tests): nothing to seed from.
    return undefined;
  }
}
