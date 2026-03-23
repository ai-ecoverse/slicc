/**
 * LickManager Proxy — enables the side panel terminal to call LickManager
 * operations that live in the offscreen document.
 *
 * Uses BroadcastChannel (same extension origin) for request/response.
 *
 * Two sides:
 * - **Host** (offscreen.ts): `startLickManagerHost(lickManager)` — listens for ops
 * - **Proxy** (crontask command): `createLickManagerProxy()` — sends ops, awaits results
 */

import type { LickManager, CronTaskEntry } from './types.js';

const CHANNEL_NAME = 'slicc-lick-manager';
const TIMEOUT = 5000;

// ─── Host (offscreen document) ─────────────────────────────────────────────

/** Start listening for LickManager proxy requests. Call once in offscreen.ts. */
export function startLickManagerHost(lickManager: LickManager): void {
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
}

/** Create a proxy that forwards LickManager calls to the offscreen host. */
export function createLickManagerProxy(): LickManagerProxyMethods {
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

  return {
    createCronTask: (name, cron, scoop?, filter?) =>
      request('createCronTask', [name, cron, scoop, filter]) as Promise<CronTaskEntry>,
    listCronTasks: () => {
      // Synchronous signature but we need async — callers must await
      throw new Error('Use listCronTasksAsync instead');
    },
    deleteCronTask: (id) => request('deleteCronTask', [id]) as Promise<boolean>,
  };
}

/** Async version of listCronTasks for proxy use. */
export function listCronTasksAsync(): Promise<CronTaskEntry[]> {
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
      else resolve(msg.result as CronTaskEntry[]);
    };

    ch.postMessage({ type: 'lick-op', id, op: 'listCronTasks', args: [] });
  });
}
