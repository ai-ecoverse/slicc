import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messageListeners: Array<(message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => void> = [];
const sentMessages: unknown[] = [];

const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(async (message: unknown) => {
      sentMessages.push(message);
    }),
    onMessage: {
      addListener: vi.fn((listener: any) => {
        messageListeners.push(listener);
      }),
      removeListener: vi.fn((listener: any) => {
        const index = messageListeners.indexOf(listener);
        if (index >= 0) {
          messageListeners.splice(index, 1);
        }
      }),
    },
  },
};

(globalThis as typeof globalThis & { chrome: typeof mockChrome }).chrome = mockChrome;

const { ServiceWorkerLeaderTraySocket } = await import('./tray-socket-proxy.js');

function getOpenedSocketId(): number {
  const openMessage = sentMessages.find((message) => {
    return typeof message === 'object'
      && message !== null
      && 'payload' in message
      && typeof (message as { payload?: { type?: string } }).payload?.type === 'string'
      && (message as { payload: { type: string } }).payload.type === 'tray-socket-open';
  }) as { payload: { id: number } } | undefined;

  expect(openMessage).toBeDefined();
  return openMessage!.payload.id;
}

describe('ServiceWorkerLeaderTraySocket', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    messageListeners.splice(0, messageListeners.length);
  });

  it('opens the tray socket through the service worker and relays messages', async () => {
    const socket = new ServiceWorkerLeaderTraySocket('wss://tray.example.com/controller');
    const opened = vi.fn();
    const received = vi.fn();
    socket.addEventListener('open', opened);
    socket.addEventListener('message', received);

    await Promise.resolve();
    const id = getOpenedSocketId();

    expect(sentMessages).toContainEqual({
      source: 'offscreen',
      payload: { type: 'tray-socket-open', id, url: 'wss://tray.example.com/controller' },
    });

    for (const listener of messageListeners) {
      listener({ source: 'service-worker', payload: { type: 'tray-socket-opened', id } }, {}, () => {});
      listener({ source: 'service-worker', payload: { type: 'tray-socket-message', id, data: '{"type":"leader.connected"}' } }, {}, () => {});
    }

    expect(opened).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({ data: '{"type":"leader.connected"}' });
  });

  it('sends outbound frames and close requests through the service worker', async () => {
    const socket = new ServiceWorkerLeaderTraySocket('wss://tray.example.com/controller');
    await Promise.resolve();
    const id = getOpenedSocketId();

    socket.send('{"type":"ping"}');
    socket.close(1000, 'done');

    expect(sentMessages).toContainEqual({
      source: 'offscreen',
      payload: { type: 'tray-socket-send', id, data: '{"type":"ping"}' },
    });
    expect(sentMessages).toContainEqual({
      source: 'offscreen',
      payload: { type: 'tray-socket-close', id, code: 1000, reason: 'done' },
    });
    expect(mockChrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
  });

  it('dispatches service worker errors and ignores unrelated traffic', async () => {
    const socket = new ServiceWorkerLeaderTraySocket('wss://tray.example.com/controller');
    const onError = vi.fn();
    socket.addEventListener('error', onError);
    await Promise.resolve();
    const id = getOpenedSocketId();

    for (const listener of messageListeners) {
      listener({ source: 'panel', payload: { type: 'tray-socket-error', id, error: 'wrong-source' } }, {}, () => {});
      listener({ source: 'service-worker', payload: { type: 'tray-socket-error', id: 999, error: 'wrong-id' } }, {}, () => {});
      listener({ source: 'service-worker', payload: { type: 'tray-socket-error', id, error: 'socket failed' } }, {}, () => {});
    }

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith({ data: 'socket failed' });
  });
});