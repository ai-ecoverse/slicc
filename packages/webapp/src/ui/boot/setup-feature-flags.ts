import type { FeatureFlagFloat } from '../../core/feature-flags.js';
import { initFeatureFlagsFromRemoteCache } from '../../core/feature-flags-cache.js';
import type { RuntimeConfigStorage } from '../../scoops/tray-runtime-config.js';
import { resolveUiRuntimeMode, type UiRuntimeMode } from '../runtime-mode.js';

export interface FeatureFlagsBootOptions {
  locationHref: string;
  storage?: RuntimeConfigStorage | null;
  envBaseUrl?: string | null;
  isDev: boolean;
}

interface FeatureFlagsPageBootOptions extends FeatureFlagsBootOptions {
  isExtension: boolean;
}

export function setupFeatureFlags(float: FeatureFlagFloat, options: FeatureFlagsBootOptions): void {
  initFeatureFlagsFromRemoteCache(float, options.storage);
  void import('./setup-feature-flags-remote.js')
    .then(({ refreshFeatureFlagsForPage }) => refreshFeatureFlagsForPage(float, options))
    .catch(() => {
      // Remote hydration is best-effort; bundled defaults and the cache stay active.
    });
}

export function setupFeatureFlagsForPage(options: FeatureFlagsPageBootOptions): UiRuntimeMode {
  const runtimeMode = resolveUiRuntimeMode(
    options.locationHref,
    options.isExtension,
    options.storage
  );
  setupFeatureFlags(runtimeMode, options);
  return runtimeMode;
}
