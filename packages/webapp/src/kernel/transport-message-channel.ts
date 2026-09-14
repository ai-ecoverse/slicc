import type { KernelTransport } from './transport.js';

export function createMessageChannelTransport<In, Out>(
  port: MessagePortLike
): KernelTransport<In, Out> {
  let started = false;
  const startOnce = (): void => {
    if (started) return;
    started = true;

    if (typeof (port as MessagePort).start === 'function') {
      (port as MessagePort).start();
    }
  };

  return {
    onMessage: (handler) => {
      const listener = (event: MessageEvent): void => {
        handler(event.data as In);
      };
      port.addEventListener('message', listener as EventListener);
      startOnce();
      return () => {
        port.removeEventListener('message', listener as EventListener);
      };
    },
    send: (message, transfer) => {
      if (transfer && transfer.length > 0) {
        port.postMessage(message, transfer);
      } else {
        port.postMessage(message);
      }
    },
  };
}

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: EventListener): void;
  removeEventListener(type: 'message', listener: EventListener): void;

  start?: () => void;
}

import type {
  ExtensionMessage,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from './messages.js';

export function createBridgeMessageChannelTransport(
  port: MessagePortLike
): KernelTransport<ExtensionMessage, OffscreenToPanelMessage> {
  const inner = createMessageChannelTransport<ExtensionMessage, ExtensionMessage>(port);
  return {
    onMessage: (handler) => inner.onMessage(handler),
    send: (payload, transfer) => {
      inner.send({ source: 'offscreen', payload } as ExtensionMessage, transfer);
    },
  };
}

export function createPanelMessageChannelTransport(
  port: MessagePortLike
): KernelTransport<ExtensionMessage, PanelToOffscreenMessage> {
  const inner = createMessageChannelTransport<ExtensionMessage, ExtensionMessage>(port);
  return {
    onMessage: (handler) => inner.onMessage(handler),
    send: (payload, transfer) => {
      inner.send({ source: 'panel', payload } as ExtensionMessage, transfer);
    },
  };
}
