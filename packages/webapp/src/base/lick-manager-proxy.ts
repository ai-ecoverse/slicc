import type {
  CronTaskEntry,
  LickManager,
  LickTargetResolution,
  WebhookEntry,
} from './lick-manager-proxy-types.js';

const CHANNEL_NAME = 'slicc-lick-manager';
const TIMEOUT = 5000;

export function startLickManagerHost(lickManager: LickManager): void {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.onmessage = async (event: MessageEvent) => {
    const msg = event.data;
    if (msg?.type !== 'lick-op') return;

    const { id, op, args } = msg;
    try {
      let result: unknown;
      switch (op) {
        case 'createCronTask':
          result = await lickManager.createCronTask(args[0], args[1], args[2], args[3]);
          break;
        case 'listCronTasks':
          result = lickManager.listCronTasks();
          break;
        case 'deleteCronTask':
          result = await lickManager.deleteCronTask(args[0]);
          break;
        case 'createWebhook':
          result = await lickManager.createWebhook(args[0], args[1], args[2]);
          break;
        case 'listWebhooks':
          result = lickManager.listWebhooks();
          break;
        case 'deleteWebhook':
          result = await lickManager.deleteWebhook(args[0]);
          break;
        case 'resolveLickTarget':
          result = lickManager.resolveLickTarget?.(args[0]) ?? { status: 'unverifiable' };
          break;
        default:
          throw new Error(`Unknown lick-manager op: ${op}`);
      }
      ch.postMessage({ type: 'lick-op-response', id, result });
    } catch (err) {
      ch.postMessage({
        type: 'lick-op-response',
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

interface LickManagerProxyMethods {
  resolveLickTarget(target: string): Promise<LickTargetResolution>;
  createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry>;
  deleteCronTask(id: string): Promise<boolean>;
  createWebhook(name: string, scoop?: string, filter?: string): Promise<WebhookEntry>;
  deleteWebhook(id: string): Promise<boolean>;
}

function request(op: string, args: unknown[] = []): Promise<unknown> {
  const id = `lm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.close();
      reject(
        new Error(
          `LickManager '${op}' timed out after ${TIMEOUT}ms — is the offscreen document running and has startLickManagerHost() been called?`
        )
      );
    }, TIMEOUT);

    ch.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type !== 'lick-op-response' || msg.id !== id) return;
      clearTimeout(timer);
      ch.close();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    };

    try {
      ch.postMessage({ type: 'lick-op', id, op, args });
    } catch (err) {
      clearTimeout(timer);
      ch.close();
      reject(
        new Error(
          `LickManager '${op}' postMessage failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
  });
}

export function createLickManagerProxy(): LickManagerProxyMethods {
  return {
    resolveLickTarget: (target) =>
      request('resolveLickTarget', [target]) as Promise<LickTargetResolution>,
    createCronTask: (name, cron, scoop?, filter?) =>
      request('createCronTask', [name, cron, scoop, filter]) as Promise<CronTaskEntry>,
    deleteCronTask: (id) => request('deleteCronTask', [id]) as Promise<boolean>,
    createWebhook: (name, scoop?, filter?) =>
      request('createWebhook', [name, scoop, filter]) as Promise<WebhookEntry>,
    deleteWebhook: (id) => request('deleteWebhook', [id]) as Promise<boolean>,
  };
}

export function listCronTasksAsync(): Promise<CronTaskEntry[]> {
  return request('listCronTasks') as Promise<CronTaskEntry[]>;
}

export function listWebhooksAsync(): Promise<WebhookEntry[]> {
  return request('listWebhooks') as Promise<WebhookEntry[]>;
}
