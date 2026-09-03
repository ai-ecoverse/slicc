/**
 * The single place a float topology becomes a {@link CapabilityBroker}
 * (#2276 slice B).
 *
 * `kernel/host.ts` resolves the topology ONCE at composition time and calls
 * this; nothing below the host probes the float again. The topology is passed
 * in rather than resolved here so `work-unit/` never imports `shell/`'s
 * resolver — and so the assignment at the call site is the compile-time proof
 * that `FloatTopology` and {@link CapabilityAdapterId} still name the same
 * four transports.
 */

import { createConnectCapabilityBroker } from './connect-adapter.js';
import { createExtensionCapabilityBroker } from './extension-adapter.js';
import { createRestCapabilityBroker } from './rest-adapter.js';
import type { CapabilityAdapterId, CapabilityBroker, PageGestureChannel } from './types.js';

export interface CapabilityBrokerForTopologyOptions {
  /**
   * Gesture-bound ops (directory picker, device choosers). Identical in every
   * topology, so the host injects one channel rather than each adapter
   * growing its own.
   */
  pageGestures?: PageGestureChannel;
}

/** Build the broker for a resolved float topology. */
export function createCapabilityBrokerForTopology(
  topology: CapabilityAdapterId,
  options: CapabilityBrokerForTopologyOptions = {}
): CapabilityBroker {
  const { pageGestures } = options;
  switch (topology) {
    case 'node-rest':
      return createRestCapabilityBroker({ pageGestures });
    case 'extension-direct':
    case 'extension-delegate':
      return createExtensionCapabilityBroker({ adapter: topology, pageGestures });
    case 'connect':
      return createConnectCapabilityBroker({ pageGestures });
  }
}
