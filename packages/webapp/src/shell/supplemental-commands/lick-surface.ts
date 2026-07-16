import { hasLocalNodeServer } from '../../core/float-topology.js';

/** Get the LickManager from globalThis (published by `createKernelHost`). */
function getDirectLickManager(): import('../../scoops/lick-manager.js').LickManager | null {
  return (
    ((globalThis as unknown as Record<string, unknown>).__slicc_lickManager as
      | import('../../scoops/lick-manager.js').LickManager
      | null) ?? null
  );
}

/** Fallback for a realm without the direct worker LickManager — proxy through BroadcastChannel instead. */
let LickProxy: ReturnType<
  typeof import('../../scoops/lick-manager-proxy.js').createLickManagerProxy
> | null = null;
async function getLickProxy() {
  if (LickProxy) return LickProxy;
  const { createLickManagerProxy } = await import('../../scoops/lick-manager-proxy.js');
  LickProxy = createLickManagerProxy();
  return LickProxy;
}

/**
 * Return the configured manager surface. In standalone the kernel-host
 * singleton is the source of truth; in extension we fall back to the
 * BroadcastChannel proxy.
 *
 * Returns null only in standalone if the kernel host hasn't booted yet
 * — callers surface a clear "kernel host has not booted" error rather
 * than letting the (irrelevant in standalone) proxy timeout eat 5s.
 * When only the proxy surface is available it may still be booting / unloaded,
 * which manifests as the proxy's 5s timeout (named per-op via the proxy's error message).
 */
export async function getLickManagerSurface(): Promise<{
  createWebhook: (
    name: string,
    scoop?: string,
    filter?: string
  ) => Promise<import('../../scoops/lick-manager.js').WebhookEntry>;
  deleteWebhook: (id: string) => Promise<boolean>;
  listWebhooks: () => Promise<import('../../scoops/lick-manager.js').WebhookEntry[]>;
} | null> {
  const direct = getDirectLickManager();
  if (direct) {
    return {
      createWebhook: (name, scoop?, filter?) => direct.createWebhook(name, scoop, filter),
      deleteWebhook: (id) => direct.deleteWebhook(id),
      listWebhooks: async () => direct.listWebhooks(),
    };
  }
  if (hasLocalNodeServer()) return null;
  const proxy = await getLickProxy();
  const { listWebhooksAsync } = await import('../../scoops/lick-manager-proxy.js');
  return {
    createWebhook: (name, scoop?, filter?) => proxy.createWebhook(name, scoop, filter),
    deleteWebhook: (id) => proxy.deleteWebhook(id),
    listWebhooks: () => listWebhooksAsync(),
  };
}
