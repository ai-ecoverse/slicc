import {
  type FeatureFlagFloat,
  type FeatureFlagValues,
  initFeatureFlags,
  type UntrustedFlagValues,
} from './feature-flags.js';

export const FEATURE_FLAGS_REMOTE_STORAGE_KEY = 'slicc_feature_flags_remote';

export interface FeatureFlagsRemoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function featureFlagsRemoteCacheKey(float: FeatureFlagFloat): string {
  return `${FEATURE_FLAGS_REMOTE_STORAGE_KEY}:${float}`;
}

export function initFeatureFlagsFromRemoteCache(
  float: FeatureFlagFloat,
  storage?: FeatureFlagsRemoteStorage | null
): void {
  const resolvedStorage = resolveFeatureFlagsRemoteStorage(storage);
  initFeatureFlags(float, readCachedFlags(resolvedStorage, float) ?? {});
}

export function writeFeatureFlagsRemoteCache(
  storage: FeatureFlagsRemoteStorage | null | undefined,
  float: FeatureFlagFloat,
  flags: FeatureFlagValues
): void {
  try {
    storage?.setItem(featureFlagsRemoteCacheKey(float), JSON.stringify(flags));
  } catch {
    // Storage is best-effort; the fetched values remain active in memory.
  }
}

export function resolveFeatureFlagsRemoteStorage(
  storage?: FeatureFlagsRemoteStorage | null
): FeatureFlagsRemoteStorage | null | undefined {
  if (storage !== undefined) return storage;
  try {
    const globalStorage = (globalThis as { localStorage?: Partial<FeatureFlagsRemoteStorage> })
      .localStorage;
    if (
      typeof globalStorage?.getItem !== 'function' ||
      typeof globalStorage.setItem !== 'function'
    ) {
      return undefined;
    }
    return globalStorage as FeatureFlagsRemoteStorage;
  } catch {
    return undefined;
  }
}

function readCachedFlags(
  storage: FeatureFlagsRemoteStorage | null | undefined,
  float: FeatureFlagFloat
): FeatureFlagValues | null {
  try {
    const raw = storage?.getItem(featureFlagsRemoteCacheKey(float));
    return raw ? readFlagsRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function readFlagsRecord(value: unknown): FeatureFlagValues | null {
  if (!isRecord(value)) return null;
  if (Object.values(value).some((flagValue) => typeof flagValue !== 'string')) return null;
  return value as FeatureFlagValues;
}

function isRecord(value: unknown): value is UntrustedFlagValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
