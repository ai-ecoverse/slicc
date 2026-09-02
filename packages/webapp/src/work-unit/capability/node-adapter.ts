/**
 * Node-shaped CapabilityBroker stub (#2276).
 *
 * Shape-only: every operation returns {@link import('./types.js').CapabilityUnavailable}.
 * The real node-server adapter is a follow-up slice of #2276.
 */

import { createStubCapabilityBroker } from './stub.js';
import type { CapabilityBroker } from './types.js';

export function createNodeCapabilityBroker(): CapabilityBroker {
  return createStubCapabilityBroker({ adapter: 'node' });
}
