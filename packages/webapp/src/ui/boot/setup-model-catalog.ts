import { createLogger } from '../../base/logger.js';
import {
  type ModelCatalogRefreshResult,
  refreshModelCatalog,
} from '../../core/model-catalog-refresh.js';
import { getModelCatalogProviderIds } from '../../providers/account-store.js';
import type { FeatureFlagsBootOptions } from './setup-feature-flags.js';
import { resolveFeatureFlagsWorkerBaseUrl } from './setup-feature-flags-remote.js';

const log = createLogger('model-catalog');

export const MODEL_CATALOG_CHECK_INTERVAL_MS = 60 * 60_000;

let checkTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshModelCatalogForPage(
  options: FeatureFlagsBootOptions,
  force = false
): Promise<ModelCatalogRefreshResult> {
  const result = await refreshModelCatalog({
    workerBaseUrl: resolveFeatureFlagsWorkerBaseUrl(options),
    providers: getModelCatalogProviderIds(),
    storage: options.storage,
    force,
  });
  if (result.updated.length > 0)
    log.info('Model catalogue refreshed', { providers: result.updated });
  if (result.failed.length > 0)
    log.debug('Model catalogue refresh failed', { providers: result.failed });
  return result;
}

export function setupModelCatalog(
  options: FeatureFlagsBootOptions,
  intervalMs: number = MODEL_CATALOG_CHECK_INTERVAL_MS
): Promise<ModelCatalogRefreshResult> {
  stopModelCatalogRefresh();
  checkTimer = setInterval(() => {
    void refreshModelCatalogForPage(options);
  }, intervalMs);
  return refreshModelCatalogForPage(options);
}

export function stopModelCatalogRefresh(): void {
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
