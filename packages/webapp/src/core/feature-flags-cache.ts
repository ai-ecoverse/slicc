import {
  type FeatureFlagFloat,
  type FeatureFlagValues,
  initFeatureFlags,
  type UntrustedFlagValues,
  updateCentralFlagValues,
} from './feature-flags.js';

export const FEATURE_FLAGS_REMOTE_STORAGE_KEY = 'slicc_feature_flags_remote';

export interface FeatureFlagsRemoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function featureFlagsRemoteCacheKey(float: FeatureFlagFloat): string {
  return `${FEATURE_FLAGS_REMOTE_STORAGE_KEY}:${float}`;
}

/**
 * The float this realm adopted cached values for, remembered so a later
 * storage write can be re-adopted without the writer's caller knowing which
 * float it is. Null in a realm that never read the cache.
 */
let adoptedFloat: FeatureFlagFloat | null = null;

export function initFeatureFlagsFromRemoteCache(
  float: FeatureFlagFloat,
  storage?: FeatureFlagsRemoteStorage | null
): void {
  const resolvedStorage = resolveFeatureFlagsRemoteStorage(storage);
  adoptedFloat = float;
  initFeatureFlags(float, readCachedFlags(resolvedStorage, float) ?? {});
}

/**
 * Re-read the cached `/api/flags` payload after a storage write replaced it.
 *
 * The kernel worker adopts central values ONCE, from the `localStorage`
 * snapshot the page hands it at init — but the page's own `/api/flags` read
 * can land after that snapshot was taken, and a periodic re-read certainly
 * does. The write is mirrored into the worker's storage shim either way; this
 * is what makes the worker act on it, so an operator's kill switch reaches the
 * realm that runs the unattended work rather than sitting in a Map nobody
 * re-reads.
 *
 * `key` is the key that was written; pass `undefined` for a wholesale change
 * (a `clear()`), which always re-adopts. Everything else is filtered out here
 * so the caller can hand every storage op to this function — the overwhelming
 * majority are unrelated keys and cost one string compare.
 *
 * Host-pushed overrides survive (see {@link updateCentralFlagValues}).
 * Returns whether values were re-adopted.
 */
export function readoptFeatureFlagsFromCache(
  key?: string,
  storage?: FeatureFlagsRemoteStorage | null
): boolean {
  if (!adoptedFloat) return false;
  if (key !== undefined && key !== featureFlagsRemoteCacheKey(adoptedFloat)) return false;
  const resolvedStorage = resolveFeatureFlagsRemoteStorage(storage);
  updateCentralFlagValues(adoptedFloat, readCachedFlags(resolvedStorage, adoptedFloat) ?? {});
  return true;
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
