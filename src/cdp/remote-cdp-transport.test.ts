import { describe, expect, it, vi } from 'vitest';

import { RemoteCDPTransport, type RemoteCDPSender } from './remote-cdp-transport.js';

// ---------------------------------------------------------------------------
// Fake sender
// ---------------------------------------------------------------------------

function createFakeSender() {
  const calls: Array<{
    requestId: string;
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  const sender: RemoteCDPSender = {
    sendCDPRequest(requestId, method, params, sessionId) {
      calls.push({ requestId, method, params, sessionId });
    },
  };
  return { sender, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteCDPTransport', () => {
  it('send() creates pending entry and calls sender', async () => {
    const { sender, calls } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    const promise = transport.send('Page.navigate', { url: 'https://example.com' }, 'session-1');

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('Page.navigate');
    expect(calls[0].params).toEqual({ url: 'https://example.com' });
    expect(calls[0].sessionId).toBe('session-1');

    // Resolve the pending request
    transport.handleResponse(calls[0].requestId, { frameId: 'frame-1' });

    const result = await promise;
    expect(result).toEqual({ frameId: 'frame-1' });
  });

  it('handleResponse() resolves pending promise', async () => {
    const { sender, calls } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    const promise = transport.send('Runtime.evaluate', { expression: '1+1' });

    transport.handleResponse(calls[0].requestId, { result: { value: 2 } });

    const result = await promise;
    expect(result).toEqual({ result: { value: 2 } });
  });

  it('handleResponse() with error rejects pending promise', async () => {
    const { sender, calls } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    const promise = transport.send('Page.navigate', { url: 'chrome://crash' });

    transport.handleResponse(calls[0].requestId, undefined, 'Target crashed');

    await expect(promise).rejects.toThrow('Target crashed');
  });

  it('handleResponse() with empty result resolves to empty object', async () => {
    const { sender, calls } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    const promise = transport.send('Page.enable');

    transport.handleResponse(calls[0].requestId);

    const result = await promise;
    expect(result).toEqual({});
  });

  it('timeout rejects pending promise', async () => {
    vi.useFakeTimers();
    const { sender } = createFakeSender();
    const transport = new RemoteCDPTransport(sender, 100);

    const promise = transport.send('Page.navigate', { url: 'https://example.com' });

    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow(
      'Remote CDP request timed out after 100ms: Page.navigate'
    );
    vi.useRealTimers();
  });

  it('per-request timeout overrides default', async () => {
    vi.useFakeTimers();
    const { sender } = createFakeSender();
    const transport = new RemoteCDPTransport(sender, 30000);

    const promise = transport.send('Page.navigate', undefined, undefined, 50);

    vi.advanceTimersByTime(51);

    await expect(promise).rejects.toThrow('Remote CDP request timed out after 50ms');
    vi.useRealTimers();
  });

  it('disconnect() rejects all pending', async () => {
    const { sender } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    const p1 = transport.send('Page.navigate', { url: 'a' });
    const p2 = transport.send('Page.navigate', { url: 'b' });

    transport.disconnect();

    await expect(p1).rejects.toThrow('Transport disconnected');
    await expect(p2).rejects.toThrow('Transport disconnected');
    expect(transport.state).toBe('disconnected');
  });

  it('send() after disconnect throws', async () => {
    const { sender } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    transport.disconnect();

    await expect(transport.send('Page.navigate')).rejects.toThrow('Transport disconnected');
  });

  it('handleResponse() for unknown requestId is silently ignored', () => {
    const { sender } = createFakeSender();
    const transport = new RemoteCDPTransport(sender);

    // Should not throw
    transport.handleResponse('unknown-id', { data: 'foo' });
  });

  describe('event listeners', () => {
    it('on() and handleEvent() dispatch to listeners', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);
      const events: Record<string, unknown>[] = [];

      transport.on('Page.loadEventFired', (params) => events.push(params));

      transport.handleEvent('Page.loadEventFired', { timestamp: 123 });

      expect(events).toEqual([{ timestamp: 123 }]);
    });

    it('off() removes a listener', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);
      const events: Record<string, unknown>[] = [];

      const listener = (params: Record<string, unknown>) => events.push(params);
      transport.on('Page.loadEventFired', listener);

      transport.handleEvent('Page.loadEventFired', { timestamp: 1 });
      expect(events).toHaveLength(1);

      transport.off('Page.loadEventFired', listener);
      transport.handleEvent('Page.loadEventFired', { timestamp: 2 });
      expect(events).toHaveLength(1);
    });

    it('once() resolves on event', async () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      const promise = transport.once('Page.loadEventFired', 5000);

      transport.handleEvent('Page.loadEventFired', { timestamp: 42 });

      const result = await promise;
      expect(result).toEqual({ timestamp: 42 });
    });

    it('once() times out', async () => {
      vi.useFakeTimers();
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender, 30000);

      const promise = transport.once('Page.loadEventFired', 100);

      vi.advanceTimersByTime(101);

      await expect(promise).rejects.toThrow('Remote CDP event timed out: Page.loadEventFired');
      vi.useRealTimers();
    });

    it('multiple listeners for the same event', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);
      const events1: Record<string, unknown>[] = [];
      const events2: Record<string, unknown>[] = [];

      transport.on('Network.requestWillBeSent', (p) => events1.push(p));
      transport.on('Network.requestWillBeSent', (p) => events2.push(p));

      transport.handleEvent('Network.requestWillBeSent', { requestId: 'r1' });

      expect(events1).toEqual([{ requestId: 'r1' }]);
      expect(events2).toEqual([{ requestId: 'r1' }]);
    });

    it('handleEvent for unsubscribed event is silently ignored', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      // Should not throw
      transport.handleEvent('Unknown.event', { data: 'foo' });
    });
  });

  describe('connect()', () => {
    it('is a no-op', async () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      await transport.connect(); // should not throw
      expect(transport.state).toBe('connected');
    });
  });

  describe('state', () => {
    it('starts as connected', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);
      expect(transport.state).toBe('connected');
    });

    it('becomes disconnected after disconnect()', () => {
      const { sender } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);
      transport.disconnect();
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('chunked responses', () => {
    it('reassembles chunked response into full result', async () => {
      const { sender, calls } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      const promise = transport.send('Accessibility.getFullAXTree');
      const requestId = calls[0].requestId;

      const original = { nodes: [{ id: 1 }, { id: 2 }] };
      const serialized = JSON.stringify(original);
      const mid = Math.ceil(serialized.length / 2);

      // Send chunk 0
      transport.handleResponse(requestId, undefined, undefined, serialized.slice(0, mid), 0, 2);

      // Send chunk 1
      transport.handleResponse(requestId, undefined, undefined, serialized.slice(mid), 1, 2);

      const result = await promise;
      expect(result).toEqual(original);
    });

    it('handles out-of-order chunked delivery', async () => {
      const { sender, calls } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      const promise = transport.send('Accessibility.getFullAXTree');
      const requestId = calls[0].requestId;

      const original = { big: 'data' };
      const serialized = JSON.stringify(original);
      const third = Math.ceil(serialized.length / 3);

      // Send chunks out of order: 2, 0, 1
      transport.handleResponse(requestId, undefined, undefined, serialized.slice(2 * third), 2, 3);
      transport.handleResponse(requestId, undefined, undefined, serialized.slice(0, third), 0, 3);
      transport.handleResponse(
        requestId,
        undefined,
        undefined,
        serialized.slice(third, 2 * third),
        1,
        3
      );

      const result = await promise;
      expect(result).toEqual(original);
    });

    it('rejects promise when chunked transfer reports error', async () => {
      const { sender, calls } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      const promise = transport.send('Accessibility.getFullAXTree');
      const requestId = calls[0].requestId;

      // Send first chunk
      transport.handleResponse(requestId, undefined, undefined, '{"partial":', 0, 2);

      // Then an error for the second chunk
      transport.handleResponse(requestId, undefined, 'Failed to send chunk 1', undefined, 1, 2);

      await expect(promise).rejects.toThrow('Failed to send chunk 1');
    });

    it('non-chunked responses still work (backward compat)', async () => {
      const { sender, calls } = createFakeSender();
      const transport = new RemoteCDPTransport(sender);

      const promise = transport.send('Page.navigate', { url: 'https://example.com' });
      const requestId = calls[0].requestId;

      // Non-chunked response (no chunkIndex/totalChunks)
      transport.handleResponse(requestId, { frameId: 'f1' });

      const result = await promise;
      expect(result).toEqual({ frameId: 'f1' });
    });
  });
});
