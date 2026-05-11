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

import type { RealmRpcChannel, RealmRpcRequest, RealmRpcResponse } from './realm-types.js';

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
  private readonly handler: (event: MessageEvent) => void;
  private disposed = false;

  constructor(private readonly port: RealmPortLike) {
    this.handler = (event: MessageEvent): void => {
      const data = event.data as { type?: string };
      if (data?.type !== 'realm-rpc-res') return;
      const res = event.data as RealmRpcResponse;
      const slot = this.pending.get(res.id);
      if (!slot) return;
      this.pending.delete(res.id);
      if (typeof res.error === 'string') {
        slot.reject(new Error(res.error));
      } else {
        slot.resolve(res.result);
      }
    };
    port.addEventListener('message', this.handler);
    port.start?.();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port.removeEventListener('message', this.handler);
    const err = new Error('realm-rpc: client disposed');
    for (const slot of this.pending.values()) slot.reject(err);
    this.pending.clear();
  }
}
