/**
 * KernelTransport adapters over chrome.runtime — Phase 1.
 *
 * The bytes on the wire don't change: both sides still send and receive the
 * existing `ExtensionMessage` envelopes (`source: 'panel' | 'offscreen' |
 * 'service-worker'`, `payload`). What changes is the call site — the bridge
 * and client no longer reach for `chrome.runtime.onMessage` / `sendMessage`
 * directly; they go through this transport.
 *
 * Both adapters deliver the **raw envelope** (`ExtensionMessage`) to their
 * onMessage handler so the bridge / client can keep their existing
 * `msg.source` filter and the bridge can keep its `sprinkle-op-response`
 * peek logic without behavior change. Phase 2's MessageChannel transport
 * will follow the same shape.
 */

import type { ExtensionMessage } from '../../../chrome-extension/src/messages.js';
import type { KernelTransport } from './types.js';

function isExtMsg(msg: unknown): msg is ExtensionMessage {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

/**
 * Host-side transport (offscreen document). Wraps incoming envelopes from
 * the panel/service-worker (delivered via `chrome.runtime.onMessage`) and
 * outgoing envelopes to the panel (sent via `chrome.runtime.sendMessage`
 * with `source: 'offscreen'`).
 */
export function createOffscreenChromeRuntimeTransport<Out>(): KernelTransport<
  ExtensionMessage,
  Out
> {
  return {
    onMessage: (handler) => {
      const listener = (
        message: unknown,
        _sender: ChromeMessageSender,
        _sendResponse: (response?: unknown) => void
      ): boolean => {
        if (!isExtMsg(message)) return false;
        handler(message);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
    send: (payload) => {
      chrome.runtime
        .sendMessage({
          source: 'offscreen' as const,
          payload,
        })
        .catch(() => {
          // No panel open — expected.
        });
    },
  };
}

/**
 * Panel-side transport (side panel UI). Wraps incoming envelopes from
 * offscreen/service-worker and outgoing envelopes to offscreen with
 * `source: 'panel'`.
 */
export function createPanelChromeRuntimeTransport<Out>(): KernelTransport<ExtensionMessage, Out> {
  return {
    onMessage: (handler) => {
      const listener = (
        message: unknown,
        _sender: ChromeMessageSender,
        _sendResponse: (response?: unknown) => void
      ): boolean => {
        if (!isExtMsg(message)) return false;
        handler(message);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },
    send: (payload) => {
      chrome.runtime
        .sendMessage({
          source: 'panel' as const,
          payload,
        })
        .catch((err: unknown) => {
          // Panel-side: log because send failures matter for UX. Mirrors
          // today's `OffscreenClient.send` log line so behavior is
          // identical — the existing tests pin this on chrome.runtime
          // rejection.
          console.error('[panel-transport] failed to send to offscreen', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}
