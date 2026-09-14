import { composeCapabilityBroker } from './compose.js';
import type { CapabilityBroker, PageGestureChannel } from './types.js';

export interface ConnectCapabilityBrokerOptions {
  pageGestures?: PageGestureChannel;
}

export function createConnectCapabilityBroker(
  options: ConnectCapabilityBrokerOptions = {}
): CapabilityBroker {
  return composeCapabilityBroker({
    adapter: 'connect',
    pageGestures: options.pageGestures,
  });
}
