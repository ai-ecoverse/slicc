/**
 * `WorkerCdpProxy` — `CDPTransport` over a `MessagePort`.
 *
 * In standalone, the kernel host runs in a DedicatedWorker; CDP
 * commands originate there but the real `CDPClient` (WebSocket →
 * `node-server` `/cdp`) lives on the page. This proxy forwards CDP
 * commands and events between the two over a dedicated `MessagePort`
 * (paired with `startPageCdpForwarder` on the page).
 *
 * Worker-safe: imports only the bridge, the leaf MessageChannel
 * transport, and CDP types (all pure). Included in
 * `tsconfig.webapp-worker.json`.
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
 *     { type: 'cdp-reset',    reason? }  — page CDP client dropped
 *     { type: 'cdp-ready' }              — page CDP client reconnected
 *
 * `cdp-reset` / `cdp-ready` exist because the worker cannot see the page's
 * connection. The page's `CDPClient` WebSocket closes several times a day
 * (the standalone proxy's Chrome leg overflows and takes the client with it);
 * Chrome discards every session minted on it. Without a signal across the hop
 * `WorkerCdpProxy.state` stays `'connected'` forever, so the worker-side
 * `BrowserAPI.ensureConnected()` never clears its cached `sessionId` and every
 * later command fails against a session that no longer exists — the "the CDP
 * connection has gone stale, I need to reload the tab" symptom of issue #2417.
 * On `cdp-reset` the proxy rejects its pending commands and flips `state` to
 * `'disconnected'`, which is exactly what `ensureConnected()` watches for; the
 * next `connect()` (re-callable after a reset) flips it back. `cdp-ready` is
 * logged only — see `CdpTransportBridge.handleControl` for why it must not
 * flip the state by itself.
 *
 * The pre-subscribe protocol (cdp-subscribe / cdp-unsubscribe) is
 * needed because the page only forwards events the worker has actually
 * registered listeners for — there's no "broadcast every CDP event"
 * affordance on the underlying `CDPTransport`. Whenever the bridge's
 * listener Map crosses 0→1 or 1→0 for a given method, the proxy
 * emits the corresponding subscribe/unsubscribe message; the page
 * forwarder mirrors that into `realTransport.on` / `realTransport.off`.
 * Those 0→1 edges never repeat for listeners the worker keeps across a
 * reset, so the forwarder re-registers its own listener map on `cdp-ready`
 * instead of waiting for the worker to re-subscribe.
 */

import type { CDPPayload } from '@slicc/shared-ts';

import type { CDPTransport } from '../cdp/transport.js';
import type { CDPEventListener, ConnectionState } from '../cdp/types.js';
import {
  type CdpBridgeOptions,
  CdpTransportBridge,
  type ParsedCdpControl,
  type ParsedCdpEvent,
  type ParsedCdpResponse,
} from './cdp-bridge.js';
import type { KernelTransport } from './transport.js';
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
  /** Per-method CDP params; shape is known only to the caller that issued the method. */
  params?: CDPPayload;
  sessionId?: string;
}

export interface CdpResponseMsg {
  type: 'cdp-response';
  id: number;
  /** Per-method CDP result; shape is known only to the caller that issued the method. */
  result?: CDPPayload;
  error?: string;
}

export interface CdpEventMsg {
  type: 'cdp-event';
  method: string;
  /** Per-method CDP event params; shape depends on `method`. */
  params?: CDPPayload;
}

export interface CdpSubscribeMsg {
  type: 'cdp-subscribe';
  event: string;
}

export interface CdpUnsubscribeMsg {
  type: 'cdp-unsubscribe';
  event: string;
}

/**
 * The page's CDP connection dropped: every session minted on it is gone.
 * `reason` is diagnostic (a WebSocket close reason, a supersede).
 */
export interface CdpResetMsg {
  type: 'cdp-reset';
  reason?: string;
}

/** The page's CDP connection is back and the worker's subscriptions are re-registered. */
export interface CdpReadyMsg {
  type: 'cdp-ready';
}

export type WorkerToPageCdpMsg = CdpCmdMsg | CdpSubscribeMsg | CdpUnsubscribeMsg;
export type PageToWorkerCdpMsg = CdpResponseMsg | CdpEventMsg | CdpResetMsg | CdpReadyMsg;
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
      parseControl: (env): ParsedCdpControl | null => {
        const msg = env as { type?: string; reason?: unknown };
        if (msg?.type === 'cdp-reset') {
          return typeof msg.reason === 'string'
            ? { kind: 'reset', reason: msg.reason }
            : { kind: 'reset' };
        }
        if (msg?.type === 'cdp-ready') return { kind: 'ready' };
        return null;
      },
      onUpstreamReset: (reason) => {
        console.warn('[WorkerCdpProxy] page CDP connection reset; sessions are stale', reason);
      },
      onUpstreamReady: () => {
        console.info('[WorkerCdpProxy] page CDP connection restored');
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

/** Run a single inbound worker→page CDP wire message against the real transport. */
async function handlePageCdpIncoming(
  msg: WorkerCdpMessage,
  realTransport: CDPTransport,
  transport: KernelTransport<WorkerCdpMessage, WorkerCdpMessage>,
  eventListeners: Map<string, CDPEventListener>
): Promise<void> {
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
  }
}

/**
 * Re-register every event subscription the worker asked for on the real
 * transport.
 *
 * `CDPClient.disconnect()` / a reconnect can drop listener registrations, and
 * the worker never re-sends `cdp-subscribe` for listeners it still holds (the
 * bridge only emits that on the 0→1 edge). Without this, events stop flowing
 * worker-ward after a page-client reconnect and stay stopped. `off` before
 * `on` keeps it idempotent for transports that don't dedupe.
 */
function resubscribeRealTransport(
  realTransport: CDPTransport,
  eventListeners: Map<string, CDPEventListener>
): void {
  for (const [event, listener] of eventListeners) {
    realTransport.off(event, listener);
    realTransport.on(event, listener);
  }
}

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

  // Sync listener — async cmd handling is fire-and-forget via void (noMisusedPromises).
  const unsubscribeIncoming = transport.onMessage((msg): void => {
    void handlePageCdpIncoming(msg, realTransport, transport, eventListeners);
  });

  // Relay the real transport's connection state across the hop. A drop is
  // invisible to the worker otherwise — see the wire-format note in the file
  // header. `lastRelayed` collapses the repeat notifications a close produces
  // (`cleanup()` then `handleClose()`) into a single `cdp-reset`.
  let lastRelayed: ConnectionState = realTransport.state;
  const unsubscribeState = realTransport.onStateChange?.((state, reason) => {
    if (state === lastRelayed) return;
    lastRelayed = state;
    if (state === 'disconnected') {
      transport.send({
        type: 'cdp-reset',
        reason: reason ?? 'page CDP client disconnected',
      } satisfies CdpResetMsg);
      return;
    }
    if (state === 'connected') {
      resubscribeRealTransport(realTransport, eventListeners);
      transport.send({ type: 'cdp-ready' } satisfies CdpReadyMsg);
    }
  });

  return () => {
    unsubscribeIncoming();
    unsubscribeState?.();
    for (const [event, listener] of eventListeners) {
      realTransport.off(event, listener);
    }
    eventListeners.clear();
  };
}
