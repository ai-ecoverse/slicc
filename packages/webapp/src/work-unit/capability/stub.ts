/**
 * Shared stub broker. Every method is an explicit operation (no handler
 * map). Unlisted ops return {@link CapabilityUnavailable}; the page adapter
 * opts `localNodeServer` in at composition time.
 */

import {
  type ApprovalCapability,
  type ApprovalOperation,
  type BrowserCapability,
  type BrowserOperation,
  type CapabilityBroker,
  type CapabilityDomain,
  capabilityUnavailable,
  type DeviceCapability,
  type DeviceOperation,
  type MountCapability,
  type MountOperation,
  type NetworkCapability,
  type NetworkOperation,
  type SecretCapability,
  type SecretOperation,
} from './types.js';

export interface StubCapabilityBrokerOptions {
  adapter: 'page' | 'node';
  browserAllowlist?: readonly BrowserOperation[];
  networkAllowlist?: readonly NetworkOperation[];
  secretAllowlist?: readonly SecretOperation[];
  deviceAllowlist?: readonly DeviceOperation[];
  mountAllowlist?: readonly MountOperation[];
  approvalAllowlist?: readonly ApprovalOperation[];
}

function deny(
  adapter: string,
  capability: CapabilityDomain,
  operation: string
): ReturnType<typeof capabilityUnavailable> {
  return capabilityUnavailable(
    capability,
    operation,
    `${adapter} adapter does not implement ${capability}.${operation}`
  );
}

export function createStubCapabilityBroker(options: StubCapabilityBrokerOptions): CapabilityBroker {
  const adapter = options.adapter;
  const browserAllowlist = options.browserAllowlist ?? [];
  const networkAllowlist = options.networkAllowlist ?? [];
  const secretAllowlist = options.secretAllowlist ?? [];
  const deviceAllowlist = options.deviceAllowlist ?? [];
  const mountAllowlist = options.mountAllowlist ?? [];
  const approvalAllowlist = options.approvalAllowlist ?? [];

  const browser: BrowserCapability = {
    allowlist: browserAllowlist,
    supports: (op) => browserAllowlist.includes(op),
    listTargets: () => Promise.resolve(deny(adapter, 'browser', 'listTargets')),
    createTarget: () => Promise.resolve(deny(adapter, 'browser', 'createTarget')),
    navigate: () => Promise.resolve(deny(adapter, 'browser', 'navigate')),
    screenshot: () => Promise.resolve(deny(adapter, 'browser', 'screenshot')),
    evaluate: () => Promise.resolve(deny(adapter, 'browser', 'evaluate')),
  };

  const network: NetworkCapability = {
    allowlist: networkAllowlist,
    supports: (op) => networkAllowlist.includes(op),
    localNodeServer: () =>
      Promise.resolve(
        networkAllowlist.includes('localNodeServer')
          ? { ok: true, value: { available: true } }
          : deny(adapter, 'network', 'localNodeServer')
      ),
    crossOriginFetch: () => Promise.resolve(deny(adapter, 'network', 'crossOriginFetch')),
    websocket: () => Promise.resolve(deny(adapter, 'network', 'websocket')),
  };

  const secrets: SecretCapability = {
    allowlist: secretAllowlist,
    supports: (op) => secretAllowlist.includes(op),
    listMaskedEnv: () => Promise.resolve(deny(adapter, 'secrets', 'listMaskedEnv')),
    get: () => Promise.resolve(deny(adapter, 'secrets', 'get')),
    set: () => Promise.resolve(deny(adapter, 'secrets', 'set')),
    delete: () => Promise.resolve(deny(adapter, 'secrets', 'delete')),
  };

  const devices: DeviceCapability = {
    allowlist: deviceAllowlist,
    supports: (op) => deviceAllowlist.includes(op),
    usbRequest: () => Promise.resolve(deny(adapter, 'devices', 'usbRequest')),
    serialRequest: () => Promise.resolve(deny(adapter, 'devices', 'serialRequest')),
    hidRequest: () => Promise.resolve(deny(adapter, 'devices', 'hidRequest')),
  };

  const mounts: MountCapability = {
    allowlist: mountAllowlist,
    supports: (op) => mountAllowlist.includes(op),
    signRequest: () => Promise.resolve(deny(adapter, 'mounts', 'signRequest')),
    pickDirectory: () => Promise.resolve(deny(adapter, 'mounts', 'pickDirectory')),
    recover: () => Promise.resolve(deny(adapter, 'mounts', 'recover')),
  };

  const approvals: ApprovalCapability = {
    allowlist: approvalAllowlist,
    supports: (op) => approvalAllowlist.includes(op),
    request: () => Promise.resolve(deny(adapter, 'approvals', 'request')),
    resolve: () => Promise.resolve(deny(adapter, 'approvals', 'resolve')),
  };

  return { adapter, browser, network, secrets, devices, mounts, approvals };
}
