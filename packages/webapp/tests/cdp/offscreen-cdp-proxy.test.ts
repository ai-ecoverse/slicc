/**
 * Tests for OffscreenCdpProxy — CDP transport that routes through chrome.runtime messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock chrome.runtime
const messageListeners: Array<
  (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => void
> = [];
const sentMessages: unknown[] = [];

const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test/${path}`,
    lastError: undefined,
    sendMessage: vi.fn(async (msg: unknown) => {
      sentMessages.push(msg);
    }),
    onMessage: {
      addListener: vi.fn((cb: any) => {
        messageListeners.push(cb);
      }),
      removeListener: vi.fn((cb: any) => {
        const idx = messageListeners.indexOf(cb);
        if (idx >= 0) messageListeners.splice(idx, 1);
      }),
    },
  },
};

// Install mock before importing
(globalThis as any).chrome = mockChrome;

// Now import after mock is in place
const { OffscreenCdpProxy } = await import('../../src/cdp/offscreen-cdp-proxy.js');

describe('OffscreenCdpProxy', () => {
  let proxy: InstanceType<typeof OffscreenCdpProxy>;

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    proxy = new OffscreenCdpProxy();
  });

  afterEach(() => {
    if (proxy.state !== 'disconnected') {
      proxy.disconnect();
    }
  });

  it('starts disconnected', () => {
    expect(proxy.state).toBe('disconnected');
  });

  it('connects and registers message listener', async () => {
    await proxy.connect();
    expect(proxy.state).toBe('connected');
    expect(mockChrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
  });

  it('throws when connecting while already connected', async () => {
    await proxy.connect();
    await expect(proxy.connect()).rejects.toThrow('Cannot connect');
  });

  it('disconnects and cleans up', async () => {
    await proxy.connect();
    proxy.disconnect();
    expect(proxy.state).toBe('disconnected');
    expect(mockChrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
  });

  it('sends CDP commands via chrome.runtime.sendMessage', async () => {
    await proxy.connect();

    // Start the send (won't resolve until we deliver the response)
    const sendPromise = proxy.send('Page.navigate', { url: 'https://example.com' }, 'session-1');

    // Verify the message was sent
    expect(sentMessages.length).toBe(1);
    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.source).toBe('offscreen');
    expect(envelope.payload.type).toBe('cdp-command');
    expect(envelope.payload.method).toBe('Page.navigate');
    expect(envelope.payload.params).toEqual({ url: 'https://example.com' });
    expect(envelope.payload.sessionId).toBe('session-1');

    // Simulate response from service worker
    const commandId = envelope.payload.id;
    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: { type: 'cdp-response', id: commandId, result: { frameId: '123' } },
        },
        {},
        () => {}
      );
    }

    const result = await sendPromise;
    expect(result).toEqual({ frameId: '123' });
  });

  it('rejects on CDP error response', async () => {
    await proxy.connect();

    const sendPromise = proxy.send('Page.navigate', { url: 'bad' });

    const envelope = sentMessages[0] as { payload: any };
    const commandId = envelope.payload.id;
    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: { type: 'cdp-response', id: commandId, error: 'Navigation failed' },
        },
        {},
        () => {}
      );
    }

    await expect(sendPromise).rejects.toThrow('Navigation failed');
  });

  it('throws when sending while disconnected', async () => {
    await expect(proxy.send('Page.navigate', {})).rejects.toThrow('not connected');
  });

  it('dispatches CDP events to listeners', async () => {
    await proxy.connect();

    const handler = vi.fn();
    proxy.on('Network.requestWillBeSent', handler);

    // Simulate CDP event from service worker
    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: {
            type: 'cdp-event',
            method: 'Network.requestWillBeSent',
            params: { requestId: '42', url: 'https://example.com' },
          },
        },
        {},
        () => {}
      );
    }

    expect(handler).toHaveBeenCalledWith({ requestId: '42', url: 'https://example.com' });
  });

  it('once() resolves on matching event', async () => {
    await proxy.connect();

    const oncePromise = proxy.once('Page.loadEventFired', 5000);

    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: { type: 'cdp-event', method: 'Page.loadEventFired', params: { timestamp: 123 } },
        },
        {},
        () => {}
      );
    }

    const result = await oncePromise;
    expect(result).toEqual({ timestamp: 123 });
  });

  it('off() removes listener', async () => {
    await proxy.connect();

    const handler = vi.fn();
    proxy.on('Test.event', handler);
    proxy.off('Test.event', handler);

    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: { type: 'cdp-event', method: 'Test.event', params: {} },
        },
        {},
        () => {}
      );
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores messages from non-service-worker sources', async () => {
    await proxy.connect();

    const handler = vi.fn();
    proxy.on('Test.event', handler);

    // Message from panel should be ignored
    for (const listener of messageListeners) {
      listener(
        { source: 'panel', payload: { type: 'cdp-event', method: 'Test.event', params: {} } },
        {},
        () => {}
      );
    }

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects pending commands on disconnect', async () => {
    await proxy.connect();

    const sendPromise = proxy.send('Page.navigate', { url: 'test' });
    proxy.disconnect();

    await expect(sendPromise).rejects.toThrow('disconnected');
  });
});
