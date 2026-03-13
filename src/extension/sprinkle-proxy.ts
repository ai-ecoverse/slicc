/**
 * Sprinkle Manager Proxy — lightweight proxy for the offscreen document.
 *
 * The real SprinkleManager runs in the side panel (it needs DOM access).
 * This proxy exposes the same interface but relays operations via
 * BroadcastChannel so the `sprinkle` shell command works from scoops
 * (whose bash runs in the offscreen document).
 */

import type { SprinkleManager } from '../ui/sprinkle-manager.js';

interface Sprinkle {
  name: string;
  title: string;
  path: string;
}

type SprinkleRequest =
  | { type: 'sprinkle-op'; id: string; op: 'list' }
  | { type: 'sprinkle-op'; id: string; op: 'opened' }
  | { type: 'sprinkle-op'; id: string; op: 'refresh' }
  | { type: 'sprinkle-op'; id: string; op: 'open'; name: string }
  | { type: 'sprinkle-op'; id: string; op: 'close'; name: string }
  | { type: 'sprinkle-op'; id: string; op: 'send'; name: string; data: unknown };

interface SprinkleResponse {
  type: 'sprinkle-op-response';
  id: string;
  result?: unknown;
  error?: string;
}

const TIMEOUT = 5000;

/**
 * Creates a proxy that implements the SprinkleManager interface
 * by relaying operations to the side panel via BroadcastChannel.
 */
export function createSprinkleManagerProxy(): SprinkleManager {
  const bc = new BroadcastChannel('sprinkle-ops');

  function request(req: Record<string, unknown>): Promise<unknown> {
    const id = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        bc.removeEventListener('message', handler);
        reject(new Error('sprinkle operation timed out'));
      }, TIMEOUT);

      function handler(event: MessageEvent): void {
        const msg = event.data as SprinkleResponse;
        if (msg?.type !== 'sprinkle-op-response' || msg.id !== id) return;
        bc.removeEventListener('message', handler);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      }

      bc.addEventListener('message', handler);
      bc.postMessage({ ...req, id, type: 'sprinkle-op' });
    });
  }

  // Cached state from last refresh — enables synchronous available()/opened()
  let cachedAvailable: Sprinkle[] = [];
  let cachedOpened: string[] = [];

  // Return an object that quacks like SprinkleManager
  return {
    async refresh(): Promise<void> {
      // Fetch both lists from the real manager
      cachedAvailable = (await request({ op: 'list' }) as Sprinkle[]) ?? [];
      cachedOpened = (await request({ op: 'opened' }) as string[]) ?? [];
    },
    async open(name: string, _zone?: string): Promise<void> {
      await request({ op: 'open', name });
    },
    close(name: string): void {
      request({ op: 'close', name }).catch(() => {});
    },
    available(): Sprinkle[] {
      return cachedAvailable;
    },
    opened(): string[] {
      return cachedOpened;
    },
    sendToSprinkle(name: string, data: unknown): void {
      request({ op: 'send', name, data }).catch(() => {});
    },
  } as unknown as SprinkleManager;
}

/**
 * Registers the handler on the side panel that executes sprinkle
 * operations on the real SprinkleManager. Call this in mainExtension().
 */
export function registerSprinkleOpsHandler(mgr: SprinkleManager): void {
  const bc = new BroadcastChannel('sprinkle-ops');
  bc.onmessage = (event) => {
    const msg = event.data as SprinkleRequest;
    if (msg?.type !== 'sprinkle-op') return;
    (async () => {
      try {
        let result: unknown;
        switch (msg.op) {
          case 'list':
            await mgr.refresh();
            result = mgr.available();
            break;
          case 'opened':
            result = mgr.opened();
            break;
          case 'refresh':
            await mgr.refresh();
            result = mgr.available().length;
            break;
          case 'open':
            await mgr.open(msg.name);
            result = true;
            break;
          case 'close':
            mgr.close(msg.name);
            result = true;
            break;
          case 'send':
            mgr.sendToSprinkle(msg.name, msg.data);
            result = true;
            break;
        }
        bc.postMessage({ type: 'sprinkle-op-response', id: msg.id, result });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        bc.postMessage({ type: 'sprinkle-op-response', id: msg.id, error: errMsg });
      }
    })();
  };
}
