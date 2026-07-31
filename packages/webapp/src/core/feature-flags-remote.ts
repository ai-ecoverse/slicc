import {
  type FeatureFlagFloat,
  type FeatureFlagValues,
  initFeatureFlags,
} from './feature-flags.js';

export const FEATURE_FLAGS_REMOTE_STORAGE_KEY = 'slicc_feature_flags_remote';
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

interface FeatureFlagsRemoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FeatureFlagsRemoteOptions {
  workerBaseUrl: string;
  fetchImpl?: typeof fetch;
  storage?: FeatureFlagsRemoteStorage | null;
  timeoutMs?: number;
}

export function featureFlagsRemoteCacheKey(float: FeatureFlagFloat): string {
  return `${FEATURE_FLAGS_REMOTE_STORAGE_KEY}:${float}`;
}

/**
 * Resolve flags from the last-known-good cache synchronously, then refresh once
 * in the background. The returned promise always fulfills, so boot may safely
 * fire-and-forget it without creating an unhandled rejection.
 */
export function hydrateFeatureFlagsFromRemote(
  float: FeatureFlagFloat,
  options: FeatureFlagsRemoteOptions
): Promise<void> {
  const storage = options.storage === undefined ? getStorage() : options.storage;
  initFeatureFlags(float, readCachedFlags(storage, float) ?? {});
  return refreshFeatureFlags(float, options, storage);
}

async function refreshFeatureFlags(
  float: FeatureFlagFloat,
  options: FeatureFlagsRemoteOptions,
  storage: FeatureFlagsRemoteStorage | null | undefined
): Promise<void> {
  try {
    const url = new URL('/api/flags', `${options.workerBaseUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('float', float);
    const flags = await fetchFlags(
      url.toString(),
      options.fetchImpl ?? fetch,
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    if (!flags) return;
    writeCachedFlags(storage, float, flags);
    // The response is an envelope. Its echoed `float` is informational and may
    // be "default"; the page's resolveUiRuntimeMode() result remains authoritative.
    initFeatureFlags(float, flags);
  } catch {
    // Remote configuration is best-effort; cached values/defaults stay active.
  }
}

async function fetchFlags(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<FeatureFlagValues | null> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const request = fetchImpl(url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return readFlagsPayload(await response.json());
      })
      .catch(() => null);
    return await Promise.race([request, timedOut]);
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function readFlagsPayload(value: unknown): FeatureFlagValues | null {
  if (!isRecord(value) || !isRecord(value.flags)) return null;
  if (Object.values(value.flags).some((flagValue) => typeof flagValue !== 'string')) return null;
  return value.flags as FeatureFlagValues;
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

function writeCachedFlags(
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

function readFlagsRecord(value: unknown): FeatureFlagValues | null {
  if (!isRecord(value)) return null;
  if (Object.values(value).some((flagValue) => typeof flagValue !== 'string')) return null;
  return value as FeatureFlagValues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStorage(): FeatureFlagsRemoteStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Partial<FeatureFlagsRemoteStorage> })
      .localStorage;
    if (typeof storage?.getItem !== 'function' || typeof storage.setItem !== 'function') return;
    return storage as FeatureFlagsRemoteStorage;
  } catch {
    return undefined;
  }
}
