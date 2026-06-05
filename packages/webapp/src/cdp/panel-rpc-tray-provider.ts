/**
 * Worker-side `TrayTargetProvider` that bridges remote-target *driving*
 * to the page over panel-RPC. Wired onto the kernel-worker `BrowserAPI`
 * so `attachToPage("<runtimeId>:<localTargetId>")` builds a
 * `PanelRpcCdpTransport` instead of failing through to a local attach.
 *
 * `getTargets()` returns `[]` on purpose: listing stays on the existing
 * `list-remote-targets` panel-RPC supplement (PR #831). A `[]` here is
 * behaviourally identical to the pre-existing no-provider case, so there
 * is no listing regression — this provider's job is driving, not listing.
 */

import type { PanelRpcClient } from '../kernel/panel-rpc.js';
import type { TrayTargetEntry } from '../scoops/tray-sync-protocol.js';
import type { TrayTargetProvider } from './browser-api.js';
import { PanelRpcCdpTransport } from './panel-rpc-cdp-transport.js';

export function createPanelRpcTrayProvider(
  getPanelRpc: () => PanelRpcClient | null
): TrayTargetProvider {
  const transports = new Map<string, PanelRpcCdpTransport>();
  const keyOf = (runtimeId: string, localTargetId: string): string =>
    `${runtimeId}:${localTargetId}`;

  return {
    getTargets(): TrayTargetEntry[] {
      return [];
    },

    createRemoteTransport(runtimeId: string, localTargetId: string): PanelRpcCdpTransport {
      const key = keyOf(runtimeId, localTargetId);
      let transport = transports.get(key);
      if (!transport) {
        transport = new PanelRpcCdpTransport(getPanelRpc, runtimeId, localTargetId);
        transports.set(key, transport);
      }
      return transport;
    },

    removeRemoteTransport(runtimeId: string, localTargetId: string): void {
      const key = keyOf(runtimeId, localTargetId);
      const transport = transports.get(key);
      if (transport) {
        transport.disconnect();
        transports.delete(key);
      }
    },

    async openRemoteTab(runtimeId: string, url: string): Promise<string> {
      const rpc = getPanelRpc();
      if (!rpc) {
        throw new Error('cdp: no page bridge to the leader tray (panel-RPC client)');
      }
      const { targetId } = await rpc.call('remote-open-tab', { runtimeId, url });
      return targetId;
    },
  };
}
