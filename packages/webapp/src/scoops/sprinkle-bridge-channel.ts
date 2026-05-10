/**
 * Sprinkle bridge over a same-origin BroadcastChannel.
 *
 * The real `SprinkleManager` runs on the page (it owns DOM containers,
 * layout callbacks, and the renderer iframes) but the shell that
 * invokes `sprinkle` lives in the kernel-worker. After PR #607 the
 * worker context has no `window.__slicc_sprinkleManager` to call into;
 * this module bridges the two:
 *
 *  - `createSprinkleManagerProxyOverChannel()` is published on the
 *    worker's `globalThis.__slicc_sprinkleManager`. It exposes the
 *    same surface the shell commands use (`refresh`, `available`,
 *    `opened`, `open`, `close`, `sendToSprinkle`,
 *    `openNewAutoOpenSprinkles`) and forwards each call as a request
 *    on the bridge channel.
 *
 *  - `installSprinkleManagerHandlerOverChannel(manager)` runs on the
 *    page (`mainStandaloneWorker`). It listens for those requests and
 *    dispatches to the real `SprinkleManager`, posting responses back
 *    on the same channel.
 *
 * Extension mode keeps using its existing chrome.runtime-based proxy
 * (`packages/chrome-extension/src/sprinkle-proxy.ts`); that route is
 * intentionally untouched here.
 *
 * The wire vocabulary mirrors the extension proxy's so debugging
 * across floats reads the same: `op` ∈ `list | opened | refresh |
 * open | close | send | openNewAutoOpen`.
 */

import type { SprinkleManager } from '../ui/sprinkle-manager.js';
import type { Sprinkle } from '../ui/sprinkle-discovery.js';

/** BroadcastChannel name for sprinkle RPC. Same-origin contexts share it. */
export const SPRINKLE_BRIDGE_CHANNEL = 'slicc-sprinkle-bridge';

/** Request envelope sent worker→page on the bridge channel. */
export interface SprinkleBridgeRequestMsg {
  type: 'sprinkle-op-request';
  id: string;
  op: 'list' | 'opened' | 'refresh' | 'open' | 'close' | 'send' | 'openNewAutoOpen';
  name?: string;
  data?: unknown;
}

/** Response envelope sent page→worker on the bridge channel. */
export interface SprinkleBridgeResponseMsg {
  type: 'sprinkle-op-response';
  id: string;
  result?: unknown;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Worker-side proxy that satisfies the subset of `SprinkleManager` the
 * shell commands consume. Each call posts a request on the bridge
 * channel and resolves when the page handler responds. `available()`
 * and `opened()` are sync getters in the real manager; the proxy
 * caches their last-known values, refreshing on every `refresh()` call.
 */
export function createSprinkleManagerProxyOverChannel(
  options: { timeoutMs?: number } = {}
): SprinkleManager {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof BroadcastChannel !== 'function') {
    // No-op proxy. Lets the shell command surface the same
    // "manager not initialized" error as before instead of throwing
    // an unrelated ReferenceError. Callers detect the proxy as
    // present-but-empty via `available()` / `opened()` returning [].
    return makeNullProxy();
  }

  const channel = new BroadcastChannel(SPRINKLE_BRIDGE_CHANNEL);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as SprinkleBridgeResponseMsg | undefined;
    if (!msg || msg.type !== 'sprinkle-op-response') return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
    else slot.resolve(msg.result);
  });

  let nextId = 0;
  function request(
    op: SprinkleBridgeRequestMsg['op'],
    extras: Partial<SprinkleBridgeRequestMsg> = {}
  ): Promise<unknown> {
    const id = `sp-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`sprinkle op '${op}' timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const req: SprinkleBridgeRequestMsg = { type: 'sprinkle-op-request', id, op, ...extras };
      channel.postMessage(req);
    });
  }

  let cachedAvailable: Sprinkle[] = [];
  let cachedOpened: string[] = [];

  // The shell commands use a small subset of SprinkleManager. Cast
  // through `unknown` because the real class has private fields and
  // many additional public methods we don't proxy (markActivated,
  // restoreOpenSprinkles, …) — callers in the worker realm only need
  // the ones below.
  return {
    async refresh(): Promise<void> {
      try {
        cachedAvailable = ((await request('list')) as Sprinkle[]) ?? [];
      } catch {
        cachedAvailable = [];
      }
      try {
        cachedOpened = ((await request('opened')) as string[]) ?? [];
      } catch {
        cachedOpened = [];
      }
    },
    available(): Sprinkle[] {
      return cachedAvailable;
    },
    opened(): string[] {
      return cachedOpened;
    },
    async open(name: string): Promise<void> {
      await request('open', { name });
    },
    close(name: string): void {
      request('close', { name }).catch(() => {});
    },
    sendToSprinkle(name: string, data: unknown): void {
      request('send', { name, data }).catch(() => {});
    },
    async openNewAutoOpenSprinkles(): Promise<void> {
      await request('openNewAutoOpen');
    },
  } as unknown as SprinkleManager;
}

function makeNullProxy(): SprinkleManager {
  return {
    refresh: async () => {},
    available: () => [],
    opened: () => [],
    open: async () => {
      throw new Error('sprinkle bridge unavailable (no BroadcastChannel)');
    },
    close: () => {},
    sendToSprinkle: () => {},
    openNewAutoOpenSprinkles: async () => {},
  } as unknown as SprinkleManager;
}

/**
 * Page-side handler. Listens for `sprinkle-op-request` messages on the
 * bridge channel and dispatches them to the real `SprinkleManager`.
 * Returns a disposer that closes the channel.
 *
 * The handler is permissive: unknown ops resolve with `null` rather
 * than rejecting, so a worker built against a newer op set still gets
 * a response (the `pending` map drains; the call returns `null`).
 * Errors raised inside the manager are forwarded as `error` strings.
 */
export function installSprinkleManagerHandlerOverChannel(manager: SprinkleManager): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(SPRINKLE_BRIDGE_CHANNEL);

  const respond = (id: string, result?: unknown, error?: string): void => {
    const msg: SprinkleBridgeResponseMsg = { type: 'sprinkle-op-response', id };
    if (typeof error === 'string') msg.error = error;
    else msg.result = result;
    channel.postMessage(msg);
  };

  const handler = (event: MessageEvent): void => {
    const req = event.data as SprinkleBridgeRequestMsg | undefined;
    if (!req || req.type !== 'sprinkle-op-request') return;
    void (async () => {
      try {
        const { op, name, data, id } = req;
        switch (op) {
          case 'list':
            await manager.refresh();
            respond(id, manager.available());
            return;
          case 'opened':
            respond(id, manager.opened());
            return;
          case 'refresh':
            await manager.refresh();
            respond(id, manager.available().length);
            return;
          case 'open':
            await manager.open(name ?? '');
            respond(id, true);
            return;
          case 'close':
            manager.close(name ?? '');
            respond(id, true);
            return;
          case 'send':
            manager.sendToSprinkle(name ?? '', data);
            respond(id, true);
            return;
          case 'openNewAutoOpen':
            await manager.openNewAutoOpenSprinkles();
            respond(id, true);
            return;
          default:
            respond(req.id, null);
            return;
        }
      } catch (err) {
        respond(req.id, undefined, err instanceof Error ? err.message : String(err));
      }
    })();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
