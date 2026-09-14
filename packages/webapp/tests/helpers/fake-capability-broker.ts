import {
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  capabilityUnavailable,
} from '../../src/work-unit/capability/index.js';

const notUsed = (op: `${CapabilityDomain}.${string}`) => {
  const [capability, operation] = op.split('.') as [CapabilityDomain, string];
  return async () => capabilityUnavailable(capability, operation, `${op}: not used by this test`);
};

export interface FakeCapabilityBrokerOptions {
  listMaskedEnv?: CapabilityResult<{ entries: readonly unknown[] }>;
  localNodeServer?: CapabilityResult<{ available: boolean }>;
  signRequest?: (
    request: Parameters<CapabilityBroker['mounts']['signRequest']>[0]
  ) => CapabilityResult<unknown>;
}

export function createFakeCapabilityBroker(
  options: FakeCapabilityBrokerOptions = {}
): CapabilityBroker {
  const listMaskedEnv = options.listMaskedEnv ?? { ok: true, value: { entries: [] } };
  const localNodeServer = options.localNodeServer ?? { ok: true, value: { available: false } };
  const signRequest = options.signRequest;
  return {
    adapter: 'node-rest',
    secrets: {
      allowlist: ['listMaskedEnv'],
      supports: (op) => op === 'listMaskedEnv',
      listMaskedEnv: async () => listMaskedEnv as never,
      getMasked: notUsed('secrets.getMasked'),
      set: notUsed('secrets.set'),
      delete: notUsed('secrets.delete'),
    },
    network: {
      allowlist: ['localNodeServer'],
      supports: (op) => op === 'localNodeServer',
      localNodeServer: async () => localNodeServer as never,
      crossOriginFetch: notUsed('network.crossOriginFetch'),
      websocket: notUsed('network.websocket'),
    },
    browser: {
      allowlist: [],
      supports: () => false,
      listTargets: notUsed('browser.listTargets'),
      createTarget: notUsed('browser.createTarget'),
      navigate: notUsed('browser.navigate'),
      screenshot: notUsed('browser.screenshot'),
      evaluate: notUsed('browser.evaluate'),
    },
    devices: {
      allowlist: [],
      supports: () => false,
      usbRequest: notUsed('devices.usbRequest'),
      serialRequest: notUsed('devices.serialRequest'),
      hidRequest: notUsed('devices.hidRequest'),
    },
    mounts: {
      allowlist: signRequest ? ['signRequest'] : [],
      supports: (op) => op === 'signRequest' && signRequest !== undefined,
      signRequest: signRequest
        ? ((async (request: Parameters<CapabilityBroker['mounts']['signRequest']>[0]) =>
            signRequest(request)) as CapabilityBroker['mounts']['signRequest'])
        : notUsed('mounts.signRequest'),
      pickDirectory: notUsed('mounts.pickDirectory'),
      recover: notUsed('mounts.recover'),
    },
    approvals: {
      allowlist: [],
      supports: () => false,
      request: notUsed('approvals.request'),
      resolve: notUsed('approvals.resolve'),
    },
  } as CapabilityBroker;
}
