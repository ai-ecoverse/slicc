/**
 * Minimal `CapabilityBroker` test double (#2276).
 *
 * A test that constructs `ScoopContext` / calls `initShellAndSkills` without
 * injecting a broker falls back to `createRestCapabilityBroker()`, which
 * makes a REAL `fetch()` — fast-failing today only because the URL stays
 * relative in the node test env; a test that leaves `setLocalApiBaseUrl` set
 * would turn that into a real 10s wait. Inject this instead so secret/network
 * capability reads are deterministic and never touch a transport.
 */
import {
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  capabilityUnavailable,
} from '../../src/work-unit/capability/index.js';

/**
 * A typed `CapabilityUnavailable`, not a throw (round-1 review finding 5):
 * production adapters never let a call escape as an exception, so a fake
 * that throws for an "unused" op would let a test pass against a code path
 * that would crash a real broker's `attempt()`/`guardCapability()` wrapper.
 */
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

/** A broker whose `secrets.listMaskedEnv`, `network.localNodeServer` and `mounts.signRequest` resolve to the given (or empty/unavailable/unused) results; every other operation throws if called. */
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
