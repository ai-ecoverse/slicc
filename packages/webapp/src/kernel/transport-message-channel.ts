/**
 * KernelTransport over a MessagePort — Phase 2.
 *
 * In standalone, the kernel host runs in a DedicatedWorker spawned by the
 * page. The page and the worker each hold one end of a `MessageChannel`
 * (or use the worker's implicit message port directly). This adapter
 * wraps a `MessagePort` into a `KernelTransport` so the same bridge /
 * client code that works over chrome.runtime in extension also works
 * over MessagePort in standalone, with no call-site changes.
 *
 * Worker safety: this file is included in `tsconfig.webapp-worker.json`
 * and must not reference DOM globals (`window`, `document`, etc.).
 * `MessagePort`, `MessageEvent`, `addEventListener` are part of the
 * `WebWorker` lib so they're available in both page and worker contexts.
 */

import type { KernelTransport } from './transport.js';

/**
 * Wrap a `MessagePort` (or anything structurally compatible — a
 * `DedicatedWorkerGlobalScope.self`, a `Worker`, a port from
 * `MessageChannel`) into a `KernelTransport`.
 *
 * The returned transport:
 *  - Calls `port.start()` once on the first `onMessage` subscription so
 *    queued messages flush. Calling start() multiple times is safe; the
 *    spec defines additional calls as no-ops, but we still gate on a
 *    flag so a port from `Worker.postMessage()` (where start is implicit)
 *    isn't double-pumped.
 *  - Returns an unsubscribe function from `onMessage` that calls
 *    `removeEventListener` so the port can be reused or torn down
 *    without leaks.
 *  - Wraps `send` over `postMessage`. Transferable lists are not
 *    supported by this signature (today's bridge/client don't need
 *    them); a follow-up phase can add a `sendWithTransfer` overload if
 *    a tool needs zero-copy delivery.
 */
export function createMessageChannelTransport<In, Out>(
  port: MessagePortLike
): KernelTransport<In, Out> {
  let started = false;
  const startOnce = (): void => {
    if (started) return;
    started = true;
    // `Worker` (in the page) and `DedicatedWorkerGlobalScope.self` (in
    // the worker) don't expose `start()`, but MessagePort instances
    // returned from MessageChannel do. The interface check keeps both
    // working without branching at the call site.
    if (typeof (port as MessagePort).start === 'function') {
      (port as MessagePort).start();
    }
  };

  return {
    onMessage: (handler) => {
      const listener = (event: MessageEvent): void => {
        handler(event.data as In);
      };
      port.addEventListener('message', listener as EventListener);
      startOnce();
      return () => {
        port.removeEventListener('message', listener as EventListener);
      };
    },
    send: (message) => {
      port.postMessage(message);
    },
  };
}

/**
 * Structural type of the things we know how to wrap. `MessagePort`,
 * `Worker`, and `DedicatedWorkerGlobalScope` all satisfy this shape.
 * Declared locally so `tsconfig.webapp-worker.json` (which has only the
 * `WebWorker` lib) doesn't have to drag in the full DOM `Worker` type.
 */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: EventListener): void;
  removeEventListener(type: 'message', listener: EventListener): void;
  /** Optional — only `MessagePort` from `MessageChannel` exposes start(). */
  start?: () => void;
}
