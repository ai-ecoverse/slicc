/**
 * Local feature-flag overrides for worker-side callers (the `flags` shell
 * command). The page's `localStorage` is the source of truth; this module
 * is the worker-side read/write of the same key `feature-flags.ts` uses.
 *
 * Shell lives below `core/` in the layer stack, so the command reaches
 * these helpers through `kernel/` instead of importing `core/` itself.
 */

import {
  FEATURE_FLAG_STORAGE_KEY,
  type FeatureFlagId,
  getFeatureValue,
  listFlags,
  noBundledSkillSeed,
  readFeatureFlagOverrides,
  setFeatureFlagOverride,
} from '../core/feature-flags.js';

export { noBundledSkillSeed };

export function knownFeatureFlagId(id: string): FeatureFlagId | null {
  const found = listFlags().find((flag) => flag.id === id);
  return found ? found.id : null;
}

export function featureFlagIds(): readonly string[] {
  return listFlags().map((flag) => flag.id);
}

/** Resolved value (`on` / `off`, or another registered string). */
export function resolvedFeatureFlag(id: FeatureFlagId): string | undefined {
  return getFeatureValue(id);
}

/**
 * Write a local override in this realm. Throws when the registry refuses
 * it (not user-toggleable on the active float) so the caller does not
 * report success for a no-op.
 */
export function setLocalFeatureFlag(id: FeatureFlagId, value: 'on' | 'off'): void {
  setFeatureFlagOverride(id, value);
  if (readFeatureFlagOverrides()[id] !== value) {
    throw new Error(`flag ${id} cannot be overridden on this float`);
  }
}

/**
 * Copy the page's post-write overrides JSON into this realm's storage.
 * The panel-RPC response and the page→worker storage forward are different
 * channels; mirroring here makes the next read in this realm see the value
 * before that forward arrives.
 */
export function mirrorFeatureFlagOverrides(overridesJson: string): void {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('this realm has no localStorage to apply the override');
  }
  storage.setItem(FEATURE_FLAG_STORAGE_KEY, overridesJson);
}
