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

async function handlePageCdpIncoming(
  msg: WorkerCdpMessage,
  realTransport: CDPTransport,
  transport: KernelTransport<WorkerCdpMessage, WorkerCdpMessage>,
  eventListeners: Map<string, CDPEventListener>,
  reconnect: (() => Promise<void>) | null,
  announcedResets: () => number
): Promise<void> {
  const env = msg as { type?: string };
  if (!env?.type) return;

  if (env.type === 'cdp-cmd') {
    const cmd = msg as CdpCmdMsg;

    const sentAt = cmd.gen ?? announcedResets();
    if (sentAt < announcedResets()) {
      transport.send({
        type: 'cdp-response',
        id: cmd.id,
        error: 'dropped: command crossed a CDP connection reset in flight',
      } satisfies CdpResponseMsg);
      return;
    }
    try {
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
    if (eventListeners.has(sub.event)) return;
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

function resubscribeRealTransport(
  realTransport: CDPTransport,
  eventListeners: Map<string, CDPEventListener>
): void {
  for (const [event, listener] of eventListeners) {
    realTransport.off(event, listener);
    realTransport.on(event, listener);
  }
}

const CONNECTING_SETTLE_TIMEOUT_MS = 10_000;

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
  reconnect?: () => Promise<void>;
}

export function startPageCdpForwarder(
  port: MessagePortLike,
  realTransport: CDPTransport,
  options: PageCdpForwarderOptions = {}
): () => void {
  const transport = createMessageChannelTransport<WorkerCdpMessage, WorkerCdpMessage>(port);

  let reconnectInFlight: Promise<void> | null = null;
  const reconnectOnce = options.reconnect
    ? (): Promise<void> => {
        if (!reconnectInFlight) {
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

  const eventListeners = new Map<string, CDPEventListener>();

  const unsubscribeIncoming = transport.onMessage((msg): void => {
    void handlePageCdpIncoming(
      msg,
      realTransport,
      transport,
      eventListeners,
      reconnectOnce,
      () => resetsAnnounced
    );
  });

  let lastRelayed: ConnectionState = realTransport.state;
  let resetsAnnounced = 0;
  const unsubscribeState = realTransport.onStateChange?.((state, reason) => {
    if (state === lastRelayed) return;
    lastRelayed = state;
    if (state === 'disconnected') {
      resetsAnnounced += 1;
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
