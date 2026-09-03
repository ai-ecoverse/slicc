/**
 * `extension-direct` / `extension-delegate` CapabilityBroker adapter
 * (#2276 slice B).
 *
 * The two topologies differ ONLY in how a message reaches the extension's
 * service worker, so one adapter covers both and the topology is a
 * default-transport choice, not a different shape.
 *
 * This module is BOOT-CRITICAL — `kernel/host.ts` composes a broker before
 * the orchestrator restores scoops — so it holds only the broker's shape.
 * The Port / message implementation lives in `extension-ops.ts` behind a
 * first-use dynamic import, which also keeps the bridge clients
 * (`secrets-bridge-client`, `mount-bridge-client`) and the sudo brokers it
 * reaches for off the kernel worker's eager closure.
 */

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
  /** Which extension topology this broker was composed for. */
  adapter: 'extension-direct' | 'extension-delegate';
  pageGestures?: PageGestureChannel;
}

/** Create the broker for an extension topology. */
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
