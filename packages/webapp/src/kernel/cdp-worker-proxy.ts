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

import {
  type CdpBridgeOptions,
  CdpTransportBridge,
  type ParsedCdpControl,
  type ParsedCdpEvent,
  type ParsedCdpResponse,
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
// Worker-side proxy — the page side lives in `cdp-page-forwarder.ts`.
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
