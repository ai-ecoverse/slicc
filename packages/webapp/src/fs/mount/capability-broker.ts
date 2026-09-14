import type { CapabilityBroker } from '../../work-unit/capability/index.js';

let mountCapabilityBroker: CapabilityBroker | undefined;

export function setMountCapabilityBroker(broker: CapabilityBroker | undefined): void {
  mountCapabilityBroker = broker;
}

export function getMountCapabilityBroker(): CapabilityBroker | undefined {
  return mountCapabilityBroker;
}
