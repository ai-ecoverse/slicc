/**
 * Sprinkle Manager Proxy — lightweight proxy for the offscreen document.
 *
 * The real SprinkleManager runs in the side panel (it needs DOM access).
 * This proxy exposes the same interface but relays operations via
 * chrome.runtime messaging so the `sprinkle` shell command works from
 * scoops (whose bash runs in the offscreen document).
 *
 * Uses chrome.runtime.sendMessage (offscreen → SW broadcast → panel)
 * with sendResponse for request/response pattern.
 */

import type { SprinkleManager } from '../ui/sprinkle-manager.js';

interface Sprinkle {
  name: string;
  title: string;
  path: string;
}

const TIMEOUT = 8000;

/**
 * Creates a proxy that implements the SprinkleManager interface
 * by relaying operations to the side panel via chrome.runtime messaging.
 */
export function createSprinkleManagerProxy(): SprinkleManager {

  function request(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('sprinkle operation timed out'));
      }, TIMEOUT);

      (chrome as any).runtime.sendMessage(
        { source: 'offscreen', payload: { type: 'sprinkle-op', op, ...args } },
        (response: { result?: unknown; error?: string } | undefined) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('no response from side panel'));
            return;
          }
          if (response.error) reject(new Error(response.error));
          else resolve(response.result);
        },
      );
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
 * Listens for chrome.runtime messages with type 'sprinkle-op' and
 * uses sendResponse to return results.
 */
export function registerSprinkleOpsHandler(mgr: SprinkleManager): void {
  (chrome as any).runtime.onMessage.addListener(
    (message: any, _sender: any, sendResponse: (response: any) => void) => {
      // Accept from any source (offscreen sends with source: 'offscreen')
      const payload = message?.payload;
      if (payload?.type !== 'sprinkle-op') return false;

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
          sendResponse({ result });
        } catch (err) {
          sendResponse({ error: err instanceof Error ? err.message : String(err) });
        }
      })();

      return true; // Keep sendResponse channel open for async response
    },
  );
}
