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

export function resolvedFeatureFlag(id: FeatureFlagId): string | undefined {
  return getFeatureValue(id);
}

export function setLocalFeatureFlag(id: FeatureFlagId, value: 'on' | 'off'): void {
  setFeatureFlagOverride(id, value);
  if (readFeatureFlagOverrides()[id] !== value) {
    throw new Error(`flag ${id} cannot be overridden on this float`);
  }
}

export function mirrorFeatureFlagOverrides(overridesJson: string): void {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('this realm has no localStorage to apply the override');
  }
  storage.setItem(FEATURE_FLAG_STORAGE_KEY, overridesJson);
}
