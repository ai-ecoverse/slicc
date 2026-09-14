import { createLazyOps, guardCapability } from './boundary.js';
import { composeCapabilityBroker } from './compose.js';
import type { ExtensionCapabilityTransports, ExtensionOps } from './extension-ops.js';
import type { CapabilityBroker, PageGestureChannel } from './types.js';

export type {
  ExtensionCapabilityTransports,
  ExtensionFetchResult,
  SecretsControlMessage,
} from './extension-ops.js';

export interface ExtensionCapabilityBrokerOptions extends Partial<ExtensionCapabilityTransports> {
  adapter: 'extension-direct' | 'extension-delegate';
  pageGestures?: PageGestureChannel;
}

export function createExtensionCapabilityBroker(
  options: ExtensionCapabilityBrokerOptions
): CapabilityBroker {
  const load = createLazyOps<ExtensionOps>(() =>
    import('./extension-ops.js').then((module) => module.createExtensionOps(options))
  );

  return composeCapabilityBroker({
    adapter: options.adapter,
    pageGestures: options.pageGestures,
    network: {
      crossOriginFetch: (request) =>
        guardCapability('network', 'crossOriginFetch', async () =>
          (await load()).crossOriginFetch(request)
        ),
    },
    secrets: {
      listMaskedEnv: () =>
        guardCapability('secrets', 'listMaskedEnv', async () =>
          (await load()).secrets.listMaskedEnv()
        ),
      getMasked: (request) =>
        guardCapability('secrets', 'getMasked', async () =>
          (await load()).secrets.getMasked(request)
        ),
      set: (request) =>
        guardCapability('secrets', 'set', async () => (await load()).secrets.set(request)),
      delete: (request) =>
        guardCapability('secrets', 'delete', async () => (await load()).secrets.delete(request)),
    },
    mounts: {
      signRequest: (request) =>
        guardCapability('mounts', 'signRequest', async () => (await load()).signRequest(request)),
    },
    approvals: {
      request: (request) =>
        guardCapability('approvals', 'request', async () =>
          (await load()).requestApproval(request)
        ),
    },
  });
}
