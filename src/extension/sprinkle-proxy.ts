/**
 * Sprinkle Manager Proxy — lightweight proxy for the offscreen document.
 *
 * The real SprinkleManager runs in the side panel (it needs DOM access).
 * This proxy exposes the same interface but relays operations via the
 * extension's chrome.runtime messaging. Response handling uses a
 * callback map instead of temporary onMessage listeners.
 */

import type { SprinkleManager } from '../ui/sprinkle-manager.js';

interface Sprinkle {
  name: string;
  title: string;
  path: string;
  autoOpen: boolean;
}

const TIMEOUT = 8000;

/** Pending request callbacks, keyed by request ID. */
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/**
 * Called by the offscreen bridge when it receives a sprinkle-op-response
 * from the side panel. This must be wired in offscreen-bridge.ts.
 */
export function handleSprinkleOpResponse(payload: { id: string; result?: unknown; error?: string }): void {
  const pending = pendingRequests.get(payload.id);
  if (!pending) return;
  pendingRequests.delete(payload.id);
  clearTimeout(pending.timer);
  if (payload.error) pending.reject(new Error(payload.error));
  else pending.resolve(payload.result);
}

/**
 * Creates a proxy that implements the SprinkleManager interface.
 * Runs in the offscreen document.
 */
export function createSprinkleManagerProxy(): SprinkleManager {

  function request(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('sprinkle operation timed out'));
      }, TIMEOUT);

      pendingRequests.set(id, { resolve, reject, timer });

      // Broadcast the request — panel will pick it up via OffscreenClient
      (chrome as any).runtime.sendMessage({
        source: 'offscreen',
        payload: { type: 'sprinkle-op', id, op, ...args },
      }).catch(() => {
        pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error('failed to send sprinkle op'));
      });
    });
  }

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
