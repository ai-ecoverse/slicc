import { createLogger } from '../base/logger.js';
import type { ExtensionMessage } from './messages.js';
import { decodeBinaryForTransport, encodeBinaryForTransport } from './transport-binary-codec.js';
import type { KernelTransport } from './types.js';

const log = createLogger('panel-transport');

function isExtMsg(msg: unknown): msg is ExtensionMessage {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

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

        handler(decodeBinaryForTransport(message) as ExtensionMessage);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },

    send: (payload, _transfer) => {
      const encoded = encodeBinaryForTransport(payload);
      chrome.runtime
        .sendMessage({
          source: 'offscreen' as const,
          payload: encoded,
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/receiving end does not exist/i.test(msg)) return;

          log.error('Offscreen → panel transport send failed', { error: msg });
        });
    },
  };
}

export function createPanelChromeRuntimeTransport<Out>(): KernelTransport<ExtensionMessage, Out> {
  return {
    onMessage: (handler) => {
      const listener = (
        message: unknown,
        _sender: ChromeMessageSender,
        _sendResponse: (response?: unknown) => void
      ): boolean => {
        if (!isExtMsg(message)) return false;

        handler(decodeBinaryForTransport(message) as ExtensionMessage);
        return false;
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },

    send: (payload, _transfer) => {
      const encoded = encodeBinaryForTransport(payload);
      chrome.runtime
        .sendMessage({
          source: 'panel' as const,
          payload: encoded,
        })
        .catch((err: unknown) => {
          log.error('failed to send to offscreen', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  };
}
