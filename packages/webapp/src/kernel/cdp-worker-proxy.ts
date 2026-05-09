/**
 * `WorkerCdpProxy` — `CDPTransport` over a `MessagePort`.
 *
 * Phase 2 step 5. In standalone, the kernel host runs in a
 * DedicatedWorker; CDP commands originate there but the real
 * `CDPClient` (WebSocket → `node-server` `/cdp`) lives on the page.
 * This proxy forwards CDP commands and events between the two over a
 * dedicated `MessagePort` (paired with `startPageCdpForwarder` on the
 * page).
 *
 * Worker-safe: imports only the bridge, the leaf MessageChannel
 * transport, and CDP types (all pure). Included in
 * `tsconfig.webapp-worker.json` once kernel-worker.ts adds it to its
 * compilation graph.
 *
 * Wire format (worker ⇄ page):
 *
 *   worker → page
 *     { type: 'cdp-cmd',         id, method, params?, sessionId? }
 *     { type: 'cdp-subscribe',   event }   — first listener added
 *     { type: 'cdp-unsubscribe', event }   — last listener removed
 *
 *   page → worker
 *     { type: 'cdp-response', id, result?, error? }
 *     { type: 'cdp-event',    method, params? }
 *
 * The pre-subscribe protocol (cdp-subscribe / cdp-unsubscribe) is
 * needed because the page only forwards events the worker has actually
 * registered listeners for — there's no "broadcast every CDP event"
 * affordance on the underlying `CDPTransport`. Whenever the bridge's
 * listener Map crosses 0→1 or 1→0 for a given method, the proxy
 * emits the corresponding subscribe/unsubscribe message; the page
 * forwarder mirrors that into `realTransport.on` / `realTransport.off`.
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { CDPEventListener } from '../cdp/types.js';
import {
  CdpTransportBridge,
  type CdpBridgeOptions,
  type ParsedCdpResponse,
  type ParsedCdpEvent,
} from './cdp-bridge.js';
import {
  createMessageChannelTransport,
  type MessagePortLike,
} from './transport-message-channel.js';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface CdpCmdMsg {
  type: 'cdp-cmd';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CdpResponseMsg {
  type: 'cdp-response';
  id: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface CdpEventMsg {
  type: 'cdp-event';
  method: string;
  params?: Record<string, unknown>;
}

export interface CdpSubscribeMsg {
  type: 'cdp-subscribe';
  event: string;
}

export interface CdpUnsubscribeMsg {
  type: 'cdp-unsubscribe';
  event: string;
}

export type WorkerToPageCdpMsg = CdpCmdMsg | CdpSubscribeMsg | CdpUnsubscribeMsg;
export type PageToWorkerCdpMsg = CdpResponseMsg | CdpEventMsg;
export type WorkerCdpMessage = WorkerToPageCdpMsg | PageToWorkerCdpMsg;

// ---------------------------------------------------------------------------
// Worker-side proxy
// ---------------------------------------------------------------------------

export class WorkerCdpProxy extends CdpTransportBridge {
  constructor(port: MessagePortLike) {
    const transport = createMessageChannelTransport<WorkerCdpMessage, WorkerCdpMessage>(port);
    const opts: CdpBridgeOptions = {
      label: 'WorkerCdpProxy',
      buildCommandEnvelope: (id, method, params, sessionId) =>
        ({
          type: 'cdp-cmd',
          id,
          method,
          params,
          sessionId,
        }) satisfies CdpCmdMsg,
      sendEnvelope: (envelope) => {
        transport.send(envelope as WorkerCdpMessage);
        return Promise.resolve();
      },
      subscribeIncoming: (handler) => transport.onMessage(handler),
      parseResponse: (env): ParsedCdpResponse | null => {
        const msg = env as { type?: string; id?: unknown };
        if (msg?.type !== 'cdp-response') return null;
        // Guard against malformed envelopes with a missing or
        // non-numeric id — without this, `pendingCommands.get(undefined)`
        // misses and the response is silently dropped.
        if (typeof msg.id !== 'number' || !Number.isFinite(msg.id)) {
          console.warn('[WorkerCdpProxy] dropping cdp-response with invalid id', msg);
          return null;
        }
        const r = env as CdpResponseMsg;
        return { id: r.id, result: r.result, error: r.error };
      },
      parseEvent: (env): ParsedCdpEvent | null => {
        const msg = env as { type?: string; method?: unknown };
        if (msg?.type !== 'cdp-event') return null;
        if (typeof msg.method !== 'string') {
          console.warn('[WorkerCdpProxy] dropping cdp-event with invalid method', msg);
          return null;
        }
        const e = env as CdpEventMsg;
        return { method: e.method, params: e.params };
      },
      onSubscribeEvent: (event) => {
        transport.send({ type: 'cdp-subscribe', event } satisfies CdpSubscribeMsg);
      },
      onUnsubscribeEvent: (event) => {
        transport.send({ type: 'cdp-unsubscribe', event } satisfies CdpUnsubscribeMsg);
      },
    };
    super(opts);
  }
}

// ---------------------------------------------------------------------------
// Page-side forwarder
//
// Lives on the page in standalone. Receives commands and subscribe /
// unsubscribe messages from the worker; calls into the real
// `CDPTransport` (WebSocket-backed `CDPClient`) for execution; pushes
// responses and subscribed events back over the wire.
//
// Returns a stop function that tears down the forwarder.
// ---------------------------------------------------------------------------

export function startPageCdpForwarder(
  port: MessagePortLike,
  realTransport: CDPTransport
): () => void {
  const transport = createMessageChannelTransport<WorkerCdpMessage, WorkerCdpMessage>(port);

  // Track listeners we've registered on `realTransport` per event so we
  // can off() them on unsubscribe. Also track the active subscription
  // count — the worker may add listeners locally without the page knowing,
  // but the bridge's onSubscribeEvent only fires on the FIRST add, so
  // we expect 0/1 transitions per event method here.
  const eventListeners = new Map<string, CDPEventListener>();

  const unsubscribeIncoming = transport.onMessage(async (msg) => {
    const env = msg as { type?: string };
    if (!env?.type) return;

    if (env.type === 'cdp-cmd') {
      const cmd = msg as CdpCmdMsg;
      try {
        const result = await realTransport.send(cmd.method, cmd.params, cmd.sessionId);
        transport.send({
          type: 'cdp-response',
          id: cmd.id,
          result,
        } satisfies CdpResponseMsg);
      } catch (err) {
        transport.send({
          type: 'cdp-response',
          id: cmd.id,
          error: err instanceof Error ? err.message : String(err),
        } satisfies CdpResponseMsg);
      }
      return;
    }

    if (env.type === 'cdp-subscribe') {
      const sub = msg as CdpSubscribeMsg;
      if (eventListeners.has(sub.event)) return; // idempotent
      const listener: CDPEventListener = (params) => {
        transport.send({
          type: 'cdp-event',
          method: sub.event,
          params,
        } satisfies CdpEventMsg);
      };
      eventListeners.set(sub.event, listener);
      realTransport.on(sub.event, listener);
      return;
    }

    if (env.type === 'cdp-unsubscribe') {
      const unsub = msg as CdpUnsubscribeMsg;
      const listener = eventListeners.get(unsub.event);
      if (!listener) return;
      eventListeners.delete(unsub.event);
      realTransport.off(unsub.event, listener);
      return;
    }
  });

  return () => {
    unsubscribeIncoming();
    for (const [event, listener] of eventListeners) {
      realTransport.off(event, listener);
    }
    eventListeners.clear();
  };
}
