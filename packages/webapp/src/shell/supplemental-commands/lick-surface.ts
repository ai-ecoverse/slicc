import type {
  CronTaskEntry,
  LickManager,
  LickTargetResolution,
  WebhookEntry,
} from '../../base/lick-manager-proxy-types.js';
import { hasLocalNodeServer } from '../float-topology.js';

interface LickManagerGlobals {
  __slicc_lickManager?: LickManager | null;
}

function getDirectLickManager(): LickManager | null {
  return (globalThis as unknown as LickManagerGlobals).__slicc_lickManager ?? null;
}

let LickProxy: ReturnType<
  typeof import('../../base/lick-manager-proxy.js').createLickManagerProxy
> | null = null;
async function getLickProxy() {
  if (LickProxy) return LickProxy;
  const { createLickManagerProxy } = await import('../../base/lick-manager-proxy.js');
  LickProxy = createLickManagerProxy();
  return LickProxy;
}

export interface LickManagerSurface {
  resolveLickTarget: (target: string) => Promise<LickTargetResolution>;
  createWebhook: (name: string, scoop?: string, filter?: string) => Promise<WebhookEntry>;
  deleteWebhook: (id: string) => Promise<boolean>;
  listWebhooks: () => Promise<WebhookEntry[]>;
  createCronTask: (name: string, cron: string, scoop?: string) => Promise<CronTaskEntry>;
  deleteCronTask: (id: string) => Promise<boolean>;
  listCronTasks: () => Promise<CronTaskEntry[]>;
}

export async function getLickManagerSurface(): Promise<LickManagerSurface | null> {
  const direct = getDirectLickManager();
  if (direct) {
    return {
      resolveLickTarget: async (target) =>
        direct.resolveLickTarget?.(target) ?? { status: 'unverifiable' },
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
    resolveLickTarget: (target) => proxy.resolveLickTarget(target),
    createWebhook: (name, scoop?, filter?) => proxy.createWebhook(name, scoop, filter),
    deleteWebhook: (id) => proxy.deleteWebhook(id),
    listWebhooks: () => listWebhooksAsync(),
    createCronTask: (name, cron, scoop?) => proxy.createCronTask(name, cron, scoop),
    deleteCronTask: (id) => proxy.deleteCronTask(id),
    listCronTasks: () => listCronTasksAsync(),
  };
}
