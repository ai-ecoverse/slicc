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

export interface CdpCmdMsg {
  type: 'cdp-cmd';
  id: number;
  method: string;

  params?: CDPPayload;
  sessionId?: string;

  gen?: number;
}

export interface CdpResponseMsg {
  type: 'cdp-response';
  id: number;

  result?: CDPPayload;
  error?: string;
}

export interface CdpEventMsg {
  type: 'cdp-event';
  method: string;

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

export interface CdpResetMsg {
  type: 'cdp-reset';
  reason?: string;
}

export interface CdpReadyMsg {
  type: 'cdp-ready';
}

export type WorkerToPageCdpMsg = CdpCmdMsg | CdpSubscribeMsg | CdpUnsubscribeMsg;
export type PageToWorkerCdpMsg = CdpResponseMsg | CdpEventMsg | CdpResetMsg | CdpReadyMsg;
export type WorkerCdpMessage = WorkerToPageCdpMsg | PageToWorkerCdpMsg;

export class WorkerCdpProxy extends CdpTransportBridge {
  constructor(port: MessagePortLike) {
    const transport = createMessageChannelTransport<WorkerCdpMessage, WorkerCdpMessage>(port);

    let generation = 0;
    const opts: CdpBridgeOptions = {
      label: 'WorkerCdpProxy',
      buildCommandEnvelope: (id, method, params, sessionId) =>
        ({
          type: 'cdp-cmd',
          id,
          method,
          params,
          sessionId,
          gen: generation,
        }) satisfies CdpCmdMsg,
      sendEnvelope: (envelope) => {
        transport.send(envelope as WorkerCdpMessage);
        return Promise.resolve();
      },
      subscribeIncoming: (handler) => transport.onMessage(handler),
      parseResponse: (env): ParsedCdpResponse | null => {
        const msg = env as { type?: string; id?: unknown };
        if (msg?.type !== 'cdp-response') return null;

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
        generation += 1;
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
