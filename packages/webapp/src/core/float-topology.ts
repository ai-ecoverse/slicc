/**
 * Float-topology resolver — the canonical "which float am I?" discriminator.
 *
 * Generalizes the secrets-only `resolveSecretTopology()` (EXT7) so the lick
 * legs (lick-ws bridge, webhook, crontask) share ONE extension detector
 * instead of the dead `KernelHostConfig.isExtension` flag / the naive
 * `!!chrome.runtime.id` heuristic — both permanently false in the extension
 * hosted-leader tab. Pure + side-effect-free: reads ambient globals only.
 */

import { getExtensionDelegateId } from '../shell/proxied-fetch.js';

export type FloatTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest';

/**
 * Resolve the current realm's float topology. First match wins:
 * 1. **extension-direct** — real `chrome-extension://` page (`chrome.runtime.id`).
 *    No such kernel ships today (offscreen + side panel removed in `54eb0811`);
 *    kept for completeness and treated as "no node-server" by callers.
 * 2. **extension-delegate** — thin-ext hosted leader tab / its kernel worker
 *    (a delegate id was wired at boot). Wins over node-rest even when a
 *    `localApiBaseUrl` is also set.
 * 3. **connect** — `?connect=1` provider-login popup (no kernel).
 * 4. **node-rest** — default: a reachable local node-server (standalone
 *    thin-bridge, electron, hosted/cloud cone, serve-only).
 */
export function resolveFloatTopology(): FloatTopology {
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
    return 'extension-direct';
  }
  if (getExtensionDelegateId()) {
    return 'extension-delegate';
  }
  if ((globalThis as Record<string, unknown>).__slicc_connect_mode) {
    return 'connect';
  }
  return 'node-rest';
}

/**
 * True iff this float has a reachable local node-server REST / `/licks-ws`
 * surface (topology `node-rest`). The lick legs use this to choose
 * REST / lick-ws (true) vs the worker `LickManager` + tray worker (false —
 * extension-delegate, and the unreachable extension-direct).
 */
export function hasLocalNodeServer(): boolean {
  return resolveFloatTopology() === 'node-rest';
}
