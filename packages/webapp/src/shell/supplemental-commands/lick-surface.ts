import type {
  CronTaskEntry,
  LickManager,
  WebhookEntry,
} from '../../base/lick-manager-proxy-types.js';
import { hasLocalNodeServer } from '../float-topology.js';

/**
 * The kernel-host globals this module reads. Named rather than a
 * `Record<string, unknown>` bag so the cast below states the one shape it
 * actually expects — `createKernelHost` publishes exactly this key
 * (`kernel/host.ts`, step 8).
 */
interface LickManagerGlobals {
  __slicc_lickManager?: LickManager | null;
}

/** Get the LickManager from globalThis (published by `createKernelHost`). */
function getDirectLickManager(): LickManager | null {
  return (globalThis as unknown as LickManagerGlobals).__slicc_lickManager ?? null;
}

/** Fallback for a realm without the direct worker LickManager — proxy through BroadcastChannel instead. */
let LickProxy: ReturnType<
  typeof import('../../base/lick-manager-proxy.js').createLickManagerProxy
> | null = null;
async function getLickProxy() {
  if (LickProxy) return LickProxy;
  const { createLickManagerProxy } = await import('../../base/lick-manager-proxy.js');
  LickProxy = createLickManagerProxy();
  return LickProxy;
}

/**
 * The lick-registration surface both `webhook` and `crontask` drive. Listing
 * is async on both sides (the proxy needs a BroadcastChannel round-trip), so
 * the shape does not vary with the realm the command happens to run in.
 */
export interface LickManagerSurface {
  createWebhook: (name: string, scoop?: string, filter?: string) => Promise<WebhookEntry>;
  deleteWebhook: (id: string) => Promise<boolean>;
  listWebhooks: () => Promise<WebhookEntry[]>;
  createCronTask: (name: string, cron: string, scoop?: string) => Promise<CronTaskEntry>;
  deleteCronTask: (id: string) => Promise<boolean>;
  listCronTasks: () => Promise<CronTaskEntry[]>;
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
export async function getLickManagerSurface(): Promise<LickManagerSurface | null> {
  const direct = getDirectLickManager();
  if (direct) {
    return {
      createWebhook: (name, scoop?, filter?) => direct.createWebhook(name, scoop, filter),
      deleteWebhook: (id) => direct.deleteWebhook(id),
      listWebhooks: async () => direct.listWebhooks(),
      createCronTask: (name, cron, scoop?) => direct.createCronTask(name, cron, scoop),
      deleteCronTask: (id) => direct.deleteCronTask(id),
      listCronTasks: async () => direct.listCronTasks(),
    };
  }
  if (hasLocalNodeServer()) return null;
  const proxy = await getLickProxy();
  const { listCronTasksAsync, listWebhooksAsync } = await import(
    '../../base/lick-manager-proxy.js'
  );
  return {
    createWebhook: (name, scoop?, filter?) => proxy.createWebhook(name, scoop, filter),
    deleteWebhook: (id) => proxy.deleteWebhook(id),
    listWebhooks: () => listWebhooksAsync(),
    createCronTask: (name, cron, scoop?) => proxy.createCronTask(name, cron, scoop),
    deleteCronTask: (id) => proxy.deleteCronTask(id),
    listCronTasks: () => listCronTasksAsync(),
  };
}
