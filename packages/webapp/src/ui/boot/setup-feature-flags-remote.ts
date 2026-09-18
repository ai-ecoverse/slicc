import type { FeatureFlagFloat } from '../../core/feature-flags.js';
import { refreshFeatureFlagsFromRemote } from '../../core/feature-flags-remote.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  normalizeTrayWorkerBaseUrl,
  type RuntimeConfigStorage,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import type { FeatureFlagsBootOptions } from './setup-feature-flags.js';

export function refreshFeatureFlagsForPage(
  float: FeatureFlagFloat,
  options: FeatureFlagsBootOptions
): Promise<void> {
  return refreshFeatureFlagsFromRemote(float, {
    workerBaseUrl: resolveFeatureFlagsWorkerBaseUrl(options),
    storage: options.storage,
  });
}

export const FEATURE_FLAGS_REFRESH_INTERVAL_MS = 30 * 60_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function scheduleFeatureFlagsRefresh(
  float: FeatureFlagFloat,
  options: FeatureFlagsBootOptions,
  intervalMs: number = FEATURE_FLAGS_REFRESH_INTERVAL_MS
): () => void {
  stopFeatureFlagsRefresh();
  refreshTimer = setInterval(() => {
    void refreshFeatureFlagsForPage(float, options);
  }, intervalMs);
  return stopFeatureFlagsRefresh;
}

export function stopFeatureFlagsRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function resolveFeatureFlagsWorkerBaseUrl(options: FeatureFlagsBootOptions): string {
  const stored = readStoredWorkerBaseUrl(options.storage);
  const env = normalizeTrayWorkerBaseUrl(options.envBaseUrl ?? null);
  if (stored) return stored;
  if (env) return env;

  if (!options.isDev) {
    try {
      const location = new URL(options.locationHref);
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        return location.origin;
      }
    } catch {}
  }
  return options.isDev
    ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
    : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL;
}

function readStoredWorkerBaseUrl(storage: RuntimeConfigStorage | null | undefined): string | null {
  try {
    return normalizeTrayWorkerBaseUrl(storage?.getItem(TRAY_WORKER_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}
