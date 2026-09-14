import { createConnectCapabilityBroker } from './connect-adapter.js';
import { createExtensionCapabilityBroker } from './extension-adapter.js';
import { createRestCapabilityBroker } from './rest-adapter.js';
import type { CapabilityAdapterId, CapabilityBroker, PageGestureChannel } from './types.js';

export interface CapabilityBrokerForTopologyOptions {
  pageGestures?: PageGestureChannel;
}

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
