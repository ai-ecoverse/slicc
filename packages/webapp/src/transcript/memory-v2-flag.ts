/**
 * Memory v2 gate for shell/transcript code.
 *
 * Lives in `transcript/` (unranked) so `shell/` can check the flag without a
 * shell → core layer back-edge. Callers above `core/` may still import
 * `isFeatureEnabled('memory-v2')` directly.
 */

import { isFeatureEnabled } from '../core/feature-flags.js';

/** True when searchable session history (and related Memory v2 surfaces) are on. */
export function isMemoryV2Enabled(): boolean {
  return isFeatureEnabled('memory-v2');
}
