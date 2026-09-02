/**
 * Browser/page CapabilityBroker stub (#2276).
 *
 * Composed by `createKernelHost`. The only live operation in this slice is
 * `network.localNodeServer`, whose allowlist bit is snapshotted at
 * composition time — scoops never probe the float.
 */

import { createStubCapabilityBroker } from './stub.js';
import type { CapabilityBroker } from './types.js';

export interface PageCapabilityBrokerOptions {
  /**
   * Whether this float has a reachable local node-server REST surface.
   * The kernel host passes `hasLocalNodeServer()` here once; omitted
   * means the op is unavailable.
   */
  localNodeServer?: boolean;
}

export function createPageCapabilityBroker(
  options: PageCapabilityBrokerOptions = {}
): CapabilityBroker {
  return createStubCapabilityBroker({
    adapter: 'page',
    networkAllowlist: options.localNodeServer === true ? ['localNodeServer'] : [],
  });
}
