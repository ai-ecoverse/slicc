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

// ---------------------------------------------------------------------------
// Bridge-shaped MessageChannel helpers (Phase 2 step 5)
//
// The standalone kernel-worker uses an `OffscreenBridge` over a
// `MessageChannel` instead of `chrome.runtime`. The bridge code expects
// raw `ExtensionMessage` envelopes (because it filters by `source` and
// peeks for `sprinkle-op-response`). These helpers wrap a `MessagePort`
// into a transport that:
//   - Receives raw envelopes (passthrough — the page wraps before
//     posting; the worker sees what the page sent).
//   - Sends payloads wrapped in a source-tagged envelope so the
//     existing source filter on the receiver matches.
//
// Same shape as the chrome.runtime adapter — just a different wire.
// Both endpoints (worker-side bridge, page-side client) must use these
// helpers so the envelope contract holds.
// ---------------------------------------------------------------------------

import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../../../chrome-extension/src/messages.js';

/**
 * Worker-side bridge transport. The bridge runs in the kernel worker
 * (or, for testing, anywhere with a `MessagePort`); it tags its
 * outbound messages with `source: 'offscreen'` to match the existing
 * envelope contract.
 */
export function createBridgeMessageChannelTransport(
  port: MessagePortLike
): KernelTransport<ExtensionMessage, OffscreenToPanelMessage> {
  const inner = createMessageChannelTransport<ExtensionMessage, ExtensionMessage>(port);
  return {
    onMessage: (handler) => inner.onMessage(handler),
    send: (payload) => {
      inner.send({ source: 'offscreen', payload } as ExtensionMessage);
    },
  };
}

/**
 * Page-side panel transport over a `MessagePort`. Mirrors the
 * chrome.runtime panel adapter — tags outbound messages with
 * `source: 'panel'` and delivers raw envelopes inbound so the panel
 * client can filter by `source: 'offscreen'`.
 */
export function createPanelMessageChannelTransport(
  port: MessagePortLike
): KernelTransport<ExtensionMessage, PanelToOffscreenMessage> {
  const inner = createMessageChannelTransport<ExtensionMessage, ExtensionMessage>(port);
  return {
    onMessage: (handler) => inner.onMessage(handler),
    send: (payload) => {
      inner.send({ source: 'panel', payload } as ExtensionMessage);
    },
  };
}
