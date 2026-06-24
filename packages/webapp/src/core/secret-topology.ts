/**
 * Topology resolver for the secret-CRUD / feed / scrub control legs (EXT7).
 *
 * Replaces the scattered `isExtension = !!chrome.runtime.id` heuristic, which
 * misclassifies the thin-extension hosted-leader tab (where `chrome.runtime.id`
 * is undefined) as CLI and routes secret writes to a node-server REST endpoint
 * that isn't there. The four topologies map 1:1 onto the secret transports the
 * call sites switch over in Wave 2.
 *
 * Pure + side-effect-free: reads ambient globals only, never mutates them.
 */

import { getExtensionDelegateId } from '../shell/proxied-fetch.js';

export type SecretTopology = 'extension-direct' | 'extension-delegate' | 'connect' | 'node-rest';

/**
 * Resolve the secret transport topology for the current realm. First match
 * wins:
 *
 * 1. **extension-direct** — real extension page / offscreen doc
 *    (`chrome.runtime.id` truthy); same-extension `sendMessage` works.
 * 2. **extension-delegate** — thin-ext hosted leader tab / kernel worker
 *    (a delegate id was wired at boot). **Wins over node-rest even when a
 *    `localApiBaseUrl` is also set** — the delegate check precedes the default.
 * 3. **connect** — `?connect=1` provider-login popup; replica writes no-op.
 * 4. **node-rest** — default (CLI / Electron / swift; same-origin or
 *    `localApiBaseUrl`).
 */
export function resolveSecretTopology(): SecretTopology {
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
