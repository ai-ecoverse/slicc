/**
 * OffscreenCdpProxy — CDPTransport implementation for the offscreen document.
 *
 * Routes CDP commands through chrome.runtime messages to the service worker,
 * which has chrome.debugger access. Receives CDP events back from the service
 * worker via the same messaging channel.
 *
 * Implementation lives in `kernel/cdp-bridge.ts`'s `CdpTransportBridge`;
 * this class is a thin configuration of the wire shape and inbound
 * filter. Behavior is byte-identical to the prior hand-rolled version
 * (verified by the existing test suite, which is unchanged).
 */

import type {
  CdpCommandMsg,
  CdpResponseMsg,
  CdpEventMsg,
  ExtensionMessage,
} from '../../../chrome-extension/src/messages.js';
import {
  CdpTransportBridge,
  type CdpBridgeOptions,
  type ParsedCdpResponse,
  type ParsedCdpEvent,
} from '../kernel/cdp-bridge.js';

function isExtMsg(msg: unknown): msg is ExtensionMessage {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

function buildOffscreenCdpOptions(): CdpBridgeOptions {
  return {
    label: 'OffscreenCdpProxy',
    buildCommandEnvelope: (id, method, params, sessionId) => {
      const cmd: CdpCommandMsg = {
        type: 'cdp-command',
        id,
        method,
        params,
        sessionId,
      };
      return {
        source: 'offscreen' as const,
        payload: cmd,
      };
    },
    sendEnvelope: (envelope) =>
      // Returns a Promise<void> that resolves when the message has been delivered.
      // chrome.runtime.sendMessage rejects on transport-level errors (no
      // listener, panel closed, etc.) — those bubble up to the bridge.
      chrome.runtime.sendMessage(envelope).then(() => undefined),
    subscribeIncoming: (handler) => {
      const listener = (message: unknown): void => {
        if (!isExtMsg(message)) return;
        if (message.source !== 'service-worker') return;
        handler(message);
      };
      chrome.runtime.onMessage.addListener(listener as (m: unknown) => void);
      return () => chrome.runtime.onMessage.removeListener(listener as (m: unknown) => void);
    },
    parseResponse: (envelope): ParsedCdpResponse | null => {
      if (!isExtMsg(envelope)) return null;
      if (envelope.source !== 'service-worker') return null;
      const payload = envelope.payload as { type?: string };
      if (payload?.type !== 'cdp-response') return null;
      const resp = envelope.payload as CdpResponseMsg;
      return { id: resp.id, result: resp.result, error: resp.error };
    },
    parseEvent: (envelope): ParsedCdpEvent | null => {
      if (!isExtMsg(envelope)) return null;
      if (envelope.source !== 'service-worker') return null;
      const payload = envelope.payload as { type?: string };
      if (payload?.type !== 'cdp-event') return null;
      const evt = envelope.payload as CdpEventMsg;
      return { method: evt.method, params: evt.params };
    },
    // Today's OffscreenCdpProxy silently swallowed listener errors and
    // unknown response ids — preserve that.
  };
}

export class OffscreenCdpProxy extends CdpTransportBridge {
  constructor() {
    super(buildOffscreenCdpOptions());
  }
}
