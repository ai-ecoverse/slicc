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

/** Resolve and fetch worker flags after the synchronous cache-backed boot path. */
export function refreshFeatureFlagsForPage(
  float: FeatureFlagFloat,
  options: FeatureFlagsBootOptions
): Promise<void> {
  return refreshFeatureFlagsFromRemote(float, {
    workerBaseUrl: resolveFeatureFlagsWorkerBaseUrl(options),
    storage: options.storage,
  });
}

/**
 * How often a live page re-reads central flags.
 *
 * Without this, a page read `/api/flags` once at boot and then ran on that
 * answer forever — fine while every flag only gated something a user was
 * looking at, and not fine now that compact-on-idle runs LLM rounds in a
 * session nobody is watching. An operator who flips the kill switch has to be
 * able to stop those rounds in tabs that are already open, not only in the
 * ones opened next.
 *
 * Half an hour matches the idle window the feature itself uses, so a cone can
 * miss at most one round; the worker's response is edge-cached for 300 s, so
 * anything much shorter would mostly re-read the same bytes.
 */
export const FEATURE_FLAGS_REFRESH_INTERVAL_MS = 30 * 60_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start (or restart) the periodic re-read. Returns the stopper, and is safe to
 * call twice — a second call replaces the first timer rather than running two.
 *
 * The values it fetches reach the kernel worker the same way every other page
 * setting does: the cache write goes through `installPageStorageSync` into the
 * worker's storage shim, where `readoptFeatureFlagsFromCache` picks it up.
 */
export function scheduleFeatureFlagsRefresh(
  float: FeatureFlagFloat,
  options: FeatureFlagsBootOptions,
  intervalMs: number = FEATURE_FLAGS_REFRESH_INTERVAL_MS
): () => void {
  stopFeatureFlagsRefresh();
  refreshTimer = setInterval(() => {
    // `refreshFeatureFlagsFromRemote` never rejects: a failed read leaves the
    // last-known-good values in place rather than reverting to defaults.
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

/**
 * Resolve the public worker origin without resolveApiUrl(): that helper targets
 * node-server in thin-bridge mode, while `/api/flags` exists only on the worker.
 */
export function resolveFeatureFlagsWorkerBaseUrl(options: FeatureFlagsBootOptions): string {
  const stored = readStoredWorkerBaseUrl(options.storage);
  const env = normalizeTrayWorkerBaseUrl(options.envBaseUrl ?? null);
  if (stored) return stored;
  if (env) return env;

  // Vite development origins do not host the worker API. Built hosted pages
  // (standalone thin bridge, hosted leader, follower, and Cherry) do, so their
  // HTTP(S) origin is the most accurate fallback, including custom deployments.
  if (!options.isDev) {
    try {
      const location = new URL(options.locationHref);
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        return location.origin;
      }
    } catch {
      // Fall through to the bundled production origin.
    }
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
