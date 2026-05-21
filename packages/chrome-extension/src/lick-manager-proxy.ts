/**
 * LickManager Proxy — enables the side panel terminal to call LickManager
 * operations that live in the offscreen document.
 *
 * Uses BroadcastChannel (same extension origin) for request/response.
 *
 * Two sides:
 * - **Host** (offscreen.ts): `startLickManagerHost(lickManager)` — listens for ops
 * - **Proxy** (crontask/webhook commands): `createLickManagerProxy()` — sends ops,
 *   awaits results
 */

import type { LickManager, CronTaskEntry, WebhookEntry } from './types.js';

const CHANNEL_NAME = 'slicc-lick-manager';
const TIMEOUT = 5000;

/**
 * Resolver for "the current leader tray session's webhook capability
 * URL", or `null` if the host is not a leader / has no active session.
 * The offscreen side reads `getLeaderTrayRuntimeStatus().session?.
 * webhookUrl`; tests supply a stub.
 */
export type TrayWebhookUrlResolver = () => string | null;

// ─── Host (offscreen document) ─────────────────────────────────────────────

export interface LickManagerHostOptions {
  /** Resolve the active leader tray's webhook capability URL. */
  getTrayWebhookUrl?: TrayWebhookUrlResolver;
}

/** Start listening for LickManager proxy requests. Call once in offscreen.ts. */
export function startLickManagerHost(
  lickManager: LickManager,
  options: LickManagerHostOptions = {}
): void {
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.onmessage = async (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || msg.type !== 'lick-op') return;

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
        case 'getTrayWebhookUrl':
          result = options.getTrayWebhookUrl?.() ?? null;
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

// ─── Proxy (side panel terminal) ────────────────────────────────────────────

interface LickManagerProxyMethods {
  createCronTask(
    name: string,
    cron: string,
    scoop?: string,
    filter?: string
  ): Promise<CronTaskEntry>;
  listCronTasks(): CronTaskEntry[];
  deleteCronTask(id: string): Promise<boolean>;
  createWebhook(name: string, scoop?: string, filter?: string): Promise<WebhookEntry>;
  deleteWebhook(id: string): Promise<boolean>;
}

/** Issue a single op against the offscreen host and resolve with the result. */
function request(op: string, args: unknown[] = []): Promise<unknown> {
  const id = `lm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ch = new BroadcastChannel(CHANNEL_NAME);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.close();
      reject(new Error('LickManager operation timed out'));
    }, TIMEOUT);

    ch.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.type !== 'lick-op-response' || msg.id !== id) return;
      clearTimeout(timer);
      ch.close();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    };

    ch.postMessage({ type: 'lick-op', id, op, args });
  });
}

/** Create a proxy that forwards LickManager calls to the offscreen host. */
export function createLickManagerProxy(): LickManagerProxyMethods {
  return {
    createCronTask: (name, cron, scoop?, filter?) =>
      request('createCronTask', [name, cron, scoop, filter]) as Promise<CronTaskEntry>,
    listCronTasks: () => {
      // Synchronous signature but we need async — callers must await
      throw new Error('Use listCronTasksAsync instead');
    },
    deleteCronTask: (id) => request('deleteCronTask', [id]) as Promise<boolean>,
    createWebhook: (name, scoop?, filter?) =>
      request('createWebhook', [name, scoop, filter]) as Promise<WebhookEntry>,
    deleteWebhook: (id) => request('deleteWebhook', [id]) as Promise<boolean>,
  };
}

/** Async version of listCronTasks for proxy use. */
export function listCronTasksAsync(): Promise<CronTaskEntry[]> {
  return request('listCronTasks') as Promise<CronTaskEntry[]>;
}

/** Async version of listWebhooks for proxy use. */
export function listWebhooksAsync(): Promise<WebhookEntry[]> {
  return request('listWebhooks') as Promise<WebhookEntry[]>;
}

/**
 * Fetch the active leader tray's webhook capability URL (without the
 * webhookId suffix), or `null` if the offscreen host is not a leader.
 * The side-panel webhook command appends `/<webhookId>` to construct
 * the per-webhook URL using `getTrayWebhookUrl` from runtime-mode.
 */
export function getTrayWebhookUrlAsync(): Promise<string | null> {
  return request('getTrayWebhookUrl') as Promise<string | null>;
}
