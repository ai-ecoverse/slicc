/**
 * Sprinkle Manager Proxy — lightweight proxy for the offscreen document.
 *
 * The real SprinkleManager runs in the side panel (it needs DOM access).
 * This proxy exposes the same interface but relays operations via the
 * extension's chrome.runtime messaging. Response handling uses a
 * callback map instead of temporary onMessage listeners.
 */

import type {
  SprinkleEntry,
  SprinkleManagerProxySurface,
  SprinkleSendReport,
  SprinkleSendTarget,
} from '../shell/sprinkle-manager-handle.js';

/**
 * Arguments a `sprinkle-op` request can carry. Named rather than an open
 * string-keyed bag so the ops and their payloads stay checkable — the op
 * vocabulary is fixed and small.
 */
interface SprinkleOpArgs {
  name?: string;
  data?: unknown;
  target?: SprinkleSendTarget;
}

const TIMEOUT = 8000;
interface ChromeRuntimeApi {
  sendMessage(message: unknown): Promise<unknown>;
}

/** Pending request callbacks, keyed by request ID. */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Called by the kernel bridge when it receives a sprinkle-op-response
 * from the side panel. This must be wired in kernel/facade.ts.
 */
export function handleSprinkleOpResponse(payload: {
  id: string;
  result?: unknown;
  error?: string;
}): void {
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
export function createSprinkleManagerProxy(): SprinkleManagerProxySurface {
  function request(op: string, args: SprinkleOpArgs = {}): Promise<unknown> {
    const id = `sp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('sprinkle operation timed out'));
      }, TIMEOUT);

      pendingRequests.set(id, { resolve, reject, timer });

      // Broadcast the request — panel will pick it up via OffscreenClient
      (chrome as unknown as { runtime: ChromeRuntimeApi }).runtime
        .sendMessage({ source: 'offscreen', payload: { type: 'sprinkle-op', id, op, ...args } })
        .catch(() => {
          pendingRequests.delete(id);
          clearTimeout(timer);
          reject(new Error('failed to send sprinkle op'));
        });
    });
  }

  let cachedAvailable: SprinkleEntry[] = [];
  let cachedOpened: string[] = [];

  return {
    async refresh(): Promise<void> {
      cachedAvailable = ((await request('list')) as SprinkleEntry[]) ?? [];
      cachedOpened = ((await request('opened')) as string[]) ?? [];
    },
    async open(name: string, _zone?: string): Promise<void> {
      await request('open', { name });
    },
    async reload(name: string): Promise<void> {
      await request('reload', { name });
    },
    close(name: string): void {
      request('close', { name }).catch(() => {});
    },
    available(): SprinkleEntry[] {
      return cachedAvailable;
    },
    opened(): string[] {
      return cachedOpened;
    },
    async sendToSprinkle(
      name: string,
      data: unknown,
      target?: SprinkleSendTarget
    ): Promise<SprinkleSendReport> {
      // Awaited so `sprinkle send` can report real reach and fail when the
      // push reached nothing (issue #2166).
      const result = (await request('send', { name, data, target })) as SprinkleSendReport | null;
      return result ?? { leader: false, followers: [] };
    },
    async openNewAutoOpenSprinkles(): Promise<void> {
      await request('openNewAutoOpen');
    },
    async restoreOpenSprinkles(): Promise<void> {
      // No-op in proxy — side panel handles restore directly
    },
  };
}
