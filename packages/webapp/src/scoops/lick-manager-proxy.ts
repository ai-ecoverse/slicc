/**
 * LickManager Proxy — enables the side panel terminal to call LickManager
 * operations that live in the kernel bridge (extension offscreen document).
 *
 * Uses BroadcastChannel (same extension origin) for request/response.
 *
 * Two sides:
 * - **Host** (kernel bridge): `startLickManagerHost(lickManager)` — listens for ops
 * - **Proxy** (crontask/webhook commands): `createLickManagerProxy()` — sends ops,
 *   awaits results
 */

import type { CronTaskEntry, LickManager, WebhookEntry } from './lick-manager-proxy-types.js';

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

/**
 * Surface the proxy exposes to callers. Listing operations are async
 * here (no sync sibling) — `BroadcastChannel` round-trips need a tick,
 * so a `listX(): X[]` signature would have to lie at runtime. Callers
 * should `await listCronTasksAsync()` / `await listWebhooksAsync()`.
 */
interface LickManagerProxyMethods {
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

/** Issue a single op against the offscreen host and resolve with the result. */
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
      // Defense-in-depth: `BroadcastChannel.postMessage` only throws on
      // `DataCloneError` (non-structured-cloneable args). Today the
      // arg lists are all primitives so this is unreachable, but
      // catching here means a future arg-shape change (e.g. accepting
      // a Function for a filter) surfaces a distinct error instead of
      // hanging until the 5s timeout. Realistic offscreen-document-
      // dead failure mode still routes through the timeout path.
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

/** Create a proxy that forwards LickManager calls to the offscreen host. */
export function createLickManagerProxy(): LickManagerProxyMethods {
  return {
    createCronTask: (name, cron, scoop?, filter?) =>
      request('createCronTask', [name, cron, scoop, filter]) as Promise<CronTaskEntry>,
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
