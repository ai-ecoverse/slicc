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
  let ops: Promise<ExtensionOps> | null = null;
  const load = (): Promise<ExtensionOps> => {
    ops ??= import('./extension-ops.js').then((module) => module.createExtensionOps(options));
    return ops;
  };

  return composeCapabilityBroker({
    adapter: options.adapter,
    pageGestures: options.pageGestures,
    network: { crossOriginFetch: async (request) => (await load()).crossOriginFetch(request) },
    secrets: {
      listMaskedEnv: async () => (await load()).secrets.listMaskedEnv(),
      get: async (request) => (await load()).secrets.get(request),
      set: async (request) => (await load()).secrets.set(request),
      delete: async (request) => (await load()).secrets.delete(request),
    },
    mounts: { signRequest: async (request) => (await load()).signRequest(request) },
    approvals: { request: async (request) => (await load()).requestApproval(request) },
  });
}
