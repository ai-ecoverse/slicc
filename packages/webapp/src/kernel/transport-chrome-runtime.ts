/**
 * KernelTransport adapters over chrome.runtime.
 *
 * Both adapters deliver the **raw envelope** (`ExtensionMessage`) to their
 * onMessage handler so the bridge / client can keep their `msg.source`
 * filter and the bridge can keep its `sprinkle-op-response` peek logic.
 * The MessageChannel transport (`transport-message-channel.ts`) follows
 * the same shape.
 */

import type { ExtensionMessage } from '../../../chrome-extension/src/messages.js';
import { createLogger } from '../core/logger.js';
import type { KernelTransport } from './types.js';

const log = createLogger('panel-transport');

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
        .catch((err: unknown) => {
          // "Receiving end does not exist" is expected when no panel is
          // open. Other errors (extension-context-invalidated after a SW
          // restart, message length exceeded on a large compaction
          // snapshot, serialization errors on non-cloneable payloads in
          // tool_use_start / tool_result) are real and worth logging —
          // they'd otherwise leave the panel out of sync with the live
          // agent with no diagnostic anywhere.
          const msg = err instanceof Error ? err.message : String(err);
          if (/receiving end does not exist/i.test(msg)) return;
          // `error` not `warn` — prod default log level is ERROR. The
          // documented failure modes (extension-context-invalidated,
          // message length exceeded, serialization failures) are all
          // real bugs requiring investigation; suppressing them in
          // prod leaves the panel quietly out of sync.
          log.error('Offscreen → panel transport send failed', { error: msg });
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
          // Panel-side: log because send failures matter for UX. Routed
          // through the webapp logger so the prefix and dedup match the
          // rest of the panel's diagnostics; under DEBUG=0 this is
          // silent in production and visible during development.
          log.error('failed to send to offscreen', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}
