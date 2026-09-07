/**
 * `startPageCdpForwarder` — the PAGE side of the kernel-worker CDP hop.
 *
 * Receives commands and subscribe / unsubscribe messages from the worker's
 * `WorkerCdpProxy`; calls into the real `CDPTransport` (WebSocket-backed
 * `CDPClient`) for execution; pushes responses, subscribed events, and
 * connection resets back over the wire. Wire format and rationale:
 * `cdp-worker-proxy.ts`.
 *
 * Lives in its own module so the worker bundle (which imports only
 * `WorkerCdpProxy`) does not carry page-only code in its boot-critical graph.
 */

import type { CDPTransport } from '../cdp/transport.js';
import type { CDPEventListener, ConnectionState } from '../cdp/types.js';
import type {
  CdpCmdMsg,
  CdpEventMsg,
  CdpReadyMsg,
  CdpResetMsg,
  CdpResponseMsg,
  CdpSubscribeMsg,
  CdpUnsubscribeMsg,
  WorkerCdpMessage,
} from './cdp-worker-proxy.js';
import type { KernelTransport } from './transport.js';
import {
  createMessageChannelTransport,
  type MessagePortLike,
} from './transport-message-channel.js';

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
  eventListeners: Map<string, CDPEventListener>,
  reconnect: (() => Promise<void>) | null
): Promise<void> {
  const env = msg as { type?: string };
  if (!env?.type) return;

  if (env.type === 'cdp-cmd') {
    const cmd = msg as CdpCmdMsg;
    try {
      // A command arriving while the page client is down (the proxy closed it
      // with `upstream-reset`, or a plain drop) re-dials first instead of
      // failing with "not connected" until the page's own periodic tab refresh
      // happens to call `ensureConnected()`. A superseded client stays down:
      // re-dialing would evict the newer SLICC tab that took the slot.
      if (reconnect && realTransport.state !== 'connected' && realTransport.superseded !== true) {
        await reconnect();
      }
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

/** How long a forwarded command waits for someone else's in-progress re-dial. */
const CONNECTING_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Resolve when a transport that is currently `'connecting'` reaches
 * `'connected'`; reject if it lands on `'disconnected'` or takes too long.
 * Transports without `onStateChange` are polled.
 */
function awaitConnecting(transport: CDPTransport): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      unsubscribe?.();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('page CDP client is still connecting')),
      CONNECTING_SETTLE_TIMEOUT_MS
    );
    const check = (state: ConnectionState): void => {
      if (state === 'connected') finish();
      else if (state === 'disconnected') finish(new Error('page CDP client failed to reconnect'));
    };
    if (transport.onStateChange) {
      unsubscribe = transport.onStateChange((state) => check(state));
    } else {
      poll = setInterval(() => check(transport.state), 50);
    }
    check(transport.state);
  });
}

export interface PageCdpForwarderOptions {
  /**
   * Re-dial the page-side transport. Called (coalesced — one in-flight
   * attempt at a time) when a worker command arrives while `realTransport`
   * is `'disconnected'` and not superseded. Standalone passes the page
   * `BrowserAPI`'s reconnect so the bridge URL and subprotocol token are
   * replayed; without it the worker waits for the page's next lazy reconnect.
   */
  reconnect?: () => Promise<void>;
}

export function startPageCdpForwarder(
  port: MessagePortLike,
  realTransport: CDPTransport,
  options: PageCdpForwarderOptions = {}
): () => void {
  const transport = createMessageChannelTransport<WorkerCdpMessage, WorkerCdpMessage>(port);

  // Coalesce concurrent commands onto one re-dial; a burst of worker commands
  // after a reset must not open a socket per command (each would evict the
  // previous one over the single /cdp slot).
  let reconnectInFlight: Promise<void> | null = null;
  const reconnectOnce = options.reconnect
    ? (): Promise<void> => {
        if (!reconnectInFlight) {
          // Somebody else (the page BrowserAPI's own lazy reconnect) may already
          // be mid-handshake: `state === 'connecting'`. Dialing again would
          // throw "Cannot connect: state is connecting", so wait for that
          // attempt to settle instead.
          const attempt =
            realTransport.state === 'connecting'
              ? awaitConnecting(realTransport)
              : options.reconnect!();
          reconnectInFlight = attempt.finally(() => {
            reconnectInFlight = null;
          });
        }
        return reconnectInFlight;
      }
    : null;

  // Track listeners we've registered on `realTransport` per event so we
  // can off() them on unsubscribe. Also track the active subscription
  // count — the worker may add listeners locally without the page knowing,
  // but the bridge's onSubscribeEvent only fires on the FIRST add, so
  // we expect 0/1 transitions per event method here.
  const eventListeners = new Map<string, CDPEventListener>();

  // Sync listener — async cmd handling is fire-and-forget via void (noMisusedPromises).
  const unsubscribeIncoming = transport.onMessage((msg): void => {
    void handlePageCdpIncoming(msg, realTransport, transport, eventListeners, reconnectOnce);
  });

  // Relay the real transport's connection state across the hop. A drop is
  // invisible to the worker otherwise — see the wire-format note in the file
  // header. `lastRelayed` collapses repeat notifications of a state the wire
  // already carries into a single `cdp-reset` / `cdp-ready`; because only the
  // FIRST notification of a transition is relayed, the transport must announce
  // a close once, with its final reason (`CDPClient.cleanup` does).
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
