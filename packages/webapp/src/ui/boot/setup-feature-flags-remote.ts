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
