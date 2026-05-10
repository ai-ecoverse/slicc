/**
 * PanelCdpProxy — CDPTransport implementation for the extension side panel.
 *
 * Routes CDP commands through the offscreen document (which has CDP access
 * via OffscreenCdpProxy → service worker → chrome.debugger).
 *
 * Command path:  Panel → Offscreen → Service Worker → chrome.debugger
 * Response path: Offscreen → Panel (panel-cdp-response)
 * Event path:    Service Worker → Panel (cdp-event broadcast)
 *
 * Implementation lives in `kernel/cdp-bridge.ts`'s `CdpTransportBridge`;
 * this class is a thin configuration of the wire shape and inbound
 * filter. Behavior is byte-identical to the prior hand-rolled version
 * (verified by the existing tests).
 */

import type {
  PanelCdpCommandMsg,
  PanelCdpResponseMsg,
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

function buildPanelCdpOptions(): CdpBridgeOptions {
  return {
    label: 'PanelCdpProxy',
    buildCommandEnvelope: (id, method, params, sessionId) => {
      const cmd: PanelCdpCommandMsg = {
        type: 'panel-cdp-command',
        id,
        method,
        params,
        sessionId,
      };
      return {
        source: 'panel' as const,
        payload: cmd,
      };
    },
    sendEnvelope: (envelope) => chrome.runtime.sendMessage(envelope).then(() => undefined),
    subscribeIncoming: (handler) => {
      const listener = (message: unknown): void => {
        try {
          if (!isExtMsg(message)) return;
          // Panel accepts panel-cdp-response from offscreen and cdp-event
          // from service-worker; everything else is ignored at parse time.
          if (message.source !== 'offscreen' && message.source !== 'service-worker') return;
          handler(message);
        } catch (err) {
          console.error('[panel-cdp-proxy] Error in message handler:', err);
        }
      };
      chrome.runtime.onMessage.addListener(listener as (m: unknown) => void);
      return () => chrome.runtime.onMessage.removeListener(listener as (m: unknown) => void);
    },
    parseResponse: (envelope): ParsedCdpResponse | null => {
      if (!isExtMsg(envelope)) return null;
      if (envelope.source !== 'offscreen') return null;
      const payload = envelope.payload as { type?: string };
      if (payload?.type !== 'panel-cdp-response') return null;
      const resp = envelope.payload as PanelCdpResponseMsg;
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
    onListenerError: (event, err) => {
      console.error(`[panel-cdp-proxy] Listener error for event "${event}":`, err);
    },
    onUnknownResponseId: (id) => {
      console.warn(`[panel-cdp-proxy] Ignoring CDP response with unknown id ${id}`);
    },
  };
}

export class PanelCdpProxy extends CdpTransportBridge {
  constructor() {
    super(buildPanelCdpOptions());
  }
}
