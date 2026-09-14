import { isFeatureEnabled } from '../core/feature-flags.js';

export function isMemoryV2Enabled(): boolean {
  return isFeatureEnabled('memory-v2');
}
