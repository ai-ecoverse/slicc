/**
 * `realm-rpc.ts` — request/response client used INSIDE a realm to
 * call back to the kernel host over a `MessagePort` (or a
 * `MessagePort`-shaped object — `DedicatedWorkerGlobalScope` and
 * `Worker` both satisfy the same surface from each side).
 *
 * The protocol is the same on both sides: one global handler keys
 * pending promises off the request `id`, postMessage requests, the
 * other side answers via `realm-rpc-res`. Lifted from the
 * `cdp-bridge.ts` + `transport-message-channel.ts` pattern.
 */

import type {
  RealmEventMsg,
  RealmRpcChannel,
  RealmRpcRequest,
  RealmRpcResponse,
} from './realm-types.js';

/**
 * Structural slice of a port-like object that both sides need:
 * - `postMessage` to send
 * - `addEventListener('message', …)` to receive
 * - optional `start()` to unparked queued messages (real
 *   `MessagePort` requires it; `Worker` / `DedicatedWorkerGlobalScope`
 *   are auto-started)
 */
export interface RealmPortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
}

/**
 * In-realm RPC client. Constructed once per realm boot; pass it to
 * the `fs` / `exec` / `fetch` shims as their transport. Calls to
 * `dispose()` reject every pending request — used during realm
 * shutdown so dangling `await rpc.call(...)` promises don't hang.
 */
export class RealmRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /**
   * Per-channel push subscribers for `realm-event` fan-out. Mirrors the
   * `panel-rpc-event` Map<channel, Set<handler>> shape one layer down.
   * Multiple in-realm callers can subscribe to the same channel; each
   * receives every payload posted on it. Cleared on `dispose()` so a
   * realm-shutdown drops every subscription without an explicit
   * detach from the caller.
   */
  private readonly eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();
  private readonly handler: (event: MessageEvent) => void;
  private disposed = false;

  constructor(private readonly port: RealmPortLike) {
    this.handler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type === 'realm-rpc-res') {
        const res = event.data as RealmRpcResponse;
        const slot = this.pending.get(res.id);
        if (!slot) return;
        this.pending.delete(res.id);
        if (typeof res.error === 'string') {
          slot.reject(new Error(res.error));
        } else {
          slot.resolve(res.result);
        }
        return;
      }
      if (data?.type === 'realm-event') {
        const evt = event.data as RealmEventMsg;
        const subs = this.eventSubscribers.get(evt.channel);
        if (!subs) return;
        for (const sub of [...subs]) {
          try {
            sub(evt.payload);
          } catch {
            // Subscriber failures must not poison the dispatch loop —
            // mirrors the swallow-in-fan-out pattern in `panel-rpc.ts`.
          }
        }
      }
    };
    port.addEventListener('message', this.handler);
    port.start?.();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  call<T = unknown>(channel: RealmRpcChannel, op: string, args: unknown[] = []): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('realm-rpc: client disposed'));
    }
    const id = this.nextId++;
    const request: RealmRpcRequest = { type: 'realm-rpc-req', id, channel, op, args };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.port.postMessage(request);
    });
  }

  /**
   * Subscribe to host-pushed `realm-event` messages on a named channel.
   * Returns an unsubscribe; the realm side does not call back to the
   * host on detach — turning the relay on/off is the caller's job (e.g.
   * the HID bridge pairs this with `hid.subscribeInputReports`/
   * `hid.unsubscribeInputReports` RPC calls). Subscribers added after
   * `dispose()` are no-ops.
   */
  onEvent(channel: string, handler: (payload: unknown) => void): () => void {
    if (this.disposed) return () => {};
    let subs = this.eventSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.eventSubscribers.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      const set = this.eventSubscribers.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.eventSubscribers.delete(channel);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.removeEventListener('message', this.handler);
    const err = new Error('realm-rpc: client disposed');
    for (const slot of this.pending.values()) slot.reject(err);
    this.pending.clear();
    this.eventSubscribers.clear();
  }
}
