/**
 * Sprinkle Manager Proxy — lightweight proxy for the offscreen document.
 *
 * The real SprinkleManager runs in the side panel (it needs DOM access).
 * This proxy exposes the same interface but relays operations via
 * chrome.runtime messaging (broadcast pattern with ID matching, same
 * as the CDP proxy pattern used throughout the extension).
 *
 * Flow: offscreen → broadcast request → panel handles → broadcast response → offscreen
 */

import type { SprinkleManager } from '../ui/sprinkle-manager.js';

interface Sprinkle {
  name: string;
  title: string;
  path: string;
}

const TIMEOUT = 8000;

/**
 * Creates a proxy that implements the SprinkleManager interface.
 * Runs in the offscreen document.
 */
export function createSprinkleManagerProxy(): SprinkleManager {

  function request(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        (chrome as any).runtime.onMessage.removeListener(handler);
        reject(new Error('sprinkle operation timed out'));
      }, TIMEOUT);

      function handler(message: any): void {
        if (message?.source !== 'panel') return;
        if (message?.payload?.type !== 'sprinkle-op-response') return;
        if (message?.payload?.id !== id) return;
        (chrome as any).runtime.onMessage.removeListener(handler);
        clearTimeout(timer);
        if (message.payload.error) reject(new Error(message.payload.error));
        else resolve(message.payload.result);
      }

      (chrome as any).runtime.onMessage.addListener(handler);

      // Broadcast the request — panel will pick it up
      (chrome as any).runtime.sendMessage({
        source: 'offscreen',
        payload: { type: 'sprinkle-op', id, op, ...args },
      }).catch(() => {});
    });
  }

  // Cached state from last refresh — enables synchronous available()/opened()
  let cachedAvailable: Sprinkle[] = [];
  let cachedOpened: string[] = [];

  return {
    async refresh(): Promise<void> {
      cachedAvailable = (await request('list') as Sprinkle[]) ?? [];
      cachedOpened = (await request('opened') as string[]) ?? [];
    },
    async open(name: string, _zone?: string): Promise<void> {
      await request('open', { name });
    },
    close(name: string): void {
      request('close', { name }).catch(() => {});
    },
    available(): Sprinkle[] {
      return cachedAvailable;
    },
    opened(): string[] {
      return cachedOpened;
    },
    sendToSprinkle(name: string, data: unknown): void {
      request('send', { name, data }).catch(() => {});
    },
  } as unknown as SprinkleManager;
}

/**
 * Registers the handler on the side panel that executes sprinkle
 * operations on the real SprinkleManager. Call this in mainExtension().
 *
 * Listens for sprinkle-op messages and broadcasts the response back.
 */
export function registerSprinkleOpsHandler(mgr: SprinkleManager): void {
  (chrome as any).runtime.onMessage.addListener(
    (message: any) => {
      // Accept sprinkle-op from offscreen
      if (message?.source !== 'offscreen') return;
      const payload = message?.payload;
      if (payload?.type !== 'sprinkle-op') return;

      const id = payload.id;

      (async () => {
        try {
          let result: unknown;
          switch (payload.op) {
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
              await mgr.open(payload.name);
              result = true;
              break;
            case 'close':
              mgr.close(payload.name);
              result = true;
              break;
            case 'send':
              mgr.sendToSprinkle(payload.name, payload.data);
              result = true;
              break;
          }
          (chrome as any).runtime.sendMessage({
            source: 'panel',
            payload: { type: 'sprinkle-op-response', id, result },
          }).catch(() => {});
        } catch (err) {
          (chrome as any).runtime.sendMessage({
            source: 'panel',
            payload: { type: 'sprinkle-op-response', id, error: err instanceof Error ? err.message : String(err) },
          }).catch(() => {});
        }
      })();
    },
  );
}
