import {
  type FeatureFlagFloat,
  type FeatureFlagValues,
  initFeatureFlags,
  type UntrustedFlagValues,
} from './feature-flags.js';
import {
  type FeatureFlagsRemoteStorage,
  initFeatureFlagsFromRemoteCache,
  resolveFeatureFlagsRemoteStorage,
  writeFeatureFlagsRemoteCache,
} from './feature-flags-cache.js';

export {
  FEATURE_FLAGS_REMOTE_STORAGE_KEY,
  featureFlagsRemoteCacheKey,
} from './feature-flags-cache.js';

const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

export interface FeatureFlagsRemoteOptions {
  workerBaseUrl: string;
  fetchImpl?: typeof fetch;
  storage?: FeatureFlagsRemoteStorage | null;
  timeoutMs?: number;
}

export function hydrateFeatureFlagsFromRemote(
  float: FeatureFlagFloat,
  options: FeatureFlagsRemoteOptions
): Promise<void> {
  initFeatureFlagsFromRemoteCache(float, options.storage);
  return refreshFeatureFlagsFromRemote(float, options);
}

export async function refreshFeatureFlagsFromRemote(
  float: FeatureFlagFloat,
  options: FeatureFlagsRemoteOptions
): Promise<void> {
  const storage = resolveFeatureFlagsRemoteStorage(options.storage);
  try {
    const url = new URL('/api/flags', `${options.workerBaseUrl.replace(/\/+$/, '')}/`);
    url.searchParams.set('float', float);
    const flags = await fetchFlags(
      url.toString(),
      options.fetchImpl ?? fetch,
      options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
    );
    if (!flags) return;
    writeFeatureFlagsRemoteCache(storage, float, flags);

    initFeatureFlags(float, flags);
  } catch {}
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
  if (!isPlainObject(value)) return null;
  const flags = value.flags;
  if (!isPlainObject(flags)) return null;
  if (Object.values(flags).some((flagValue) => typeof flagValue !== 'string')) return null;
  return flags as FeatureFlagValues;
}

function isPlainObject(value: unknown): value is UntrustedFlagValues {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
