/**
 * Tests for PanelCdpProxy — CDP transport that routes through offscreen document.
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
const { PanelCdpProxy } = await import('./panel-cdp-proxy.js');

describe('PanelCdpProxy', () => {
  let proxy: InstanceType<typeof PanelCdpProxy>;

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    proxy = new PanelCdpProxy();
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

  it('sends CDP commands via chrome.runtime.sendMessage with panel source', async () => {
    await proxy.connect();

    const sendPromise = proxy.send('Page.navigate', { url: 'https://example.com' }, 'session-1');

    // Verify the message was sent with panel source
    expect(sentMessages.length).toBe(1);
    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.source).toBe('panel');
    expect(envelope.payload.type).toBe('panel-cdp-command');
    expect(envelope.payload.method).toBe('Page.navigate');
    expect(envelope.payload.params).toEqual({ url: 'https://example.com' });
    expect(envelope.payload.sessionId).toBe('session-1');

    // Simulate response from offscreen
    const commandId = envelope.payload.id;
    for (const listener of messageListeners) {
      listener(
        {
          source: 'offscreen',
          payload: { type: 'panel-cdp-response', id: commandId, result: { frameId: '123' } },
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
          source: 'offscreen',
          payload: { type: 'panel-cdp-response', id: commandId, error: 'Navigation failed' },
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

  it('dispatches CDP events from service worker to listeners', async () => {
    await proxy.connect();

    const handler = vi.fn();
    proxy.on('Network.requestWillBeSent', handler);

    // Simulate CDP event from service worker (broadcast)
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

  it('ignores responses from non-offscreen sources', async () => {
    await proxy.connect();

    const sendPromise = proxy.send('Page.navigate', { url: 'test' }, undefined, 500);
    const envelope = sentMessages[0] as { payload: any };
    const commandId = envelope.payload.id;

    // Response from panel (wrong source) should be ignored
    for (const listener of messageListeners) {
      listener(
        { source: 'panel', payload: { type: 'panel-cdp-response', id: commandId, result: {} } },
        {},
        () => {}
      );
    }

    // Should timeout since response from wrong source was ignored
    await expect(sendPromise).rejects.toThrow('timed out');
  });

  it('ignores events from non-service-worker sources', async () => {
    await proxy.connect();

    const handler = vi.fn();
    proxy.on('Test.event', handler);

    // Event from panel source should be ignored
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

  it('matches out-of-order responses to correct commands by ID', async () => {
    await proxy.connect();

    const send1 = proxy.send('Page.navigate', { url: 'url1' });
    const send2 = proxy.send('Page.evaluate', { expression: 'code' });

    expect(sentMessages.length).toBe(2);
    const id1 = (sentMessages[0] as any).payload.id;
    const id2 = (sentMessages[1] as any).payload.id;

    // Send responses in REVERSE order
    for (const listener of messageListeners) {
      listener(
        {
          source: 'offscreen',
          payload: { type: 'panel-cdp-response', id: id2, result: { value: 'eval-result' } },
        },
        {},
        () => {}
      );
      listener(
        {
          source: 'offscreen',
          payload: { type: 'panel-cdp-response', id: id1, result: { frameId: '123' } },
        },
        {},
        () => {}
      );
    }

    const [result1, result2] = await Promise.all([send1, send2]);
    expect(result1).toEqual({ frameId: '123' });
    expect(result2).toEqual({ value: 'eval-result' });
  });

  it('continues firing subsequent listeners even if one throws', async () => {
    await proxy.connect();

    const handler1 = vi.fn(() => {
      throw new Error('oops');
    });
    const handler2 = vi.fn();

    proxy.on('Test.event', handler1);
    proxy.on('Test.event', handler2);

    for (const listener of messageListeners) {
      listener(
        {
          source: 'service-worker',
          payload: { type: 'cdp-event', method: 'Test.event', params: { data: 1 } },
        },
        {},
        () => {}
      );
    }

    expect(handler1).toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });
});
