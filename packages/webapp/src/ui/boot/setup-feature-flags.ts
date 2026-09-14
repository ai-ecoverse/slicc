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
    .then(({ refreshFeatureFlagsForPage, scheduleFeatureFlagsRefresh }) => {
      // Re-read on a timer as well as at boot: central values are an
      // operator's kill switch, and a tab left open for days has to be able to
      // hear one (compact-on-idle keeps working in exactly such a tab).
      scheduleFeatureFlagsRefresh(float, options);
      return refreshFeatureFlagsForPage(float, options);
    })
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
