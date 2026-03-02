import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CDPClient } from './cdp-client.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type WSHandler = (ev: { data: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: WSHandler | null = null;

  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    if (this.onopen) this.onopen();
  }

  simulateMessage(data: Record<string, unknown>) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
  }

  simulateError() {
    if (this.onerror) this.onerror(new Error('connection error'));
  }

  simulateClose() {
    if (this.onclose) this.onclose();
  }
}

// Install mock
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as unknown as Record<string, unknown>).WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).WebSocket = originalWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CDPClient', () => {
  let client: CDPClient;

  beforeEach(() => {
    client = new CDPClient();
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('connect', () => {
    it('connects successfully', async () => {
      expect(client.state).toBe('disconnected');

      const connectPromise = client.connect({ url: 'ws://localhost:3000/cdp' });

      // Simulate server accepting connection
      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();
      expect(ws.url).toBe('ws://localhost:3000/cdp');
      ws.simulateOpen();

      await connectPromise;
      expect(client.state).toBe('connected');
    });

    it('rejects on connection error', async () => {
      const connectPromise = client.connect({ url: 'ws://localhost:3000/cdp' });

      const ws = MockWebSocket.instances[0];
      ws.simulateError();

      await expect(connectPromise).rejects.toThrow('WebSocket connection failed');
      expect(client.state).toBe('disconnected');
    });

    it('rejects on timeout', async () => {
      const connectPromise = client.connect({
        url: 'ws://localhost:3000/cdp',
        timeout: 50,
      });

      // Never open the connection
      await expect(connectPromise).rejects.toThrow('timed out');
      expect(client.state).toBe('disconnected');
    });

    it('rejects if already connected', async () => {
      const p = client.connect({ url: 'ws://localhost:3000/cdp' });
      MockWebSocket.instances[0].simulateOpen();
      await p;

      await expect(
        client.connect({ url: 'ws://localhost:3000/cdp' }),
      ).rejects.toThrow('Cannot connect');
    });
  });

  describe('send', () => {
    let ws: MockWebSocket;

    beforeEach(async () => {
      const p = client.connect({ url: 'ws://test/cdp' });
      ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      await p;
    });

    it('sends a command and resolves with result', async () => {
      const resultPromise = client.send('Page.navigate', { url: 'https://example.com' });

      // Check the sent message
      expect(ws.sent).toHaveLength(1);
      const sent = JSON.parse(ws.sent[0]);
      expect(sent.method).toBe('Page.navigate');
      expect(sent.params).toEqual({ url: 'https://example.com' });
      expect(sent.id).toBe(1);

      // Simulate response
      ws.simulateMessage({ id: 1, result: { frameId: 'abc' } });

      const result = await resultPromise;
      expect(result).toEqual({ frameId: 'abc' });
    });

    it('sends commands with session ID', async () => {
      const resultPromise = client.send('DOM.enable', {}, 'session-123');

      const sent = JSON.parse(ws.sent[0]);
      expect(sent.sessionId).toBe('session-123');

      ws.simulateMessage({ id: 1, result: {} });
      await resultPromise;
    });

    it('rejects on CDP error response', async () => {
      const resultPromise = client.send('Page.navigate', { url: 'bad' });

      ws.simulateMessage({
        id: 1,
        error: { code: -32000, message: 'Cannot navigate' },
      });

      await expect(resultPromise).rejects.toThrow('Cannot navigate');
    });

    it('rejects if not connected', async () => {
      client.disconnect();
      await expect(client.send('Page.enable')).rejects.toThrow('not connected');
    });

    it('increments message IDs', async () => {
      client.send('Method1');
      client.send('Method2');
      client.send('Method3');

      expect(ws.sent).toHaveLength(3);
      expect(JSON.parse(ws.sent[0]).id).toBe(1);
      expect(JSON.parse(ws.sent[1]).id).toBe(2);
      expect(JSON.parse(ws.sent[2]).id).toBe(3);

      // Resolve them all
      ws.simulateMessage({ id: 1, result: {} });
      ws.simulateMessage({ id: 2, result: {} });
      ws.simulateMessage({ id: 3, result: {} });
    });
  });

  describe('events', () => {
    let ws: MockWebSocket;

    beforeEach(async () => {
      const p = client.connect({ url: 'ws://test/cdp' });
      ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      await p;
    });

    it('dispatches events to listeners', () => {
      const handler = vi.fn();
      client.on('Page.loadEventFired', handler);

      ws.simulateMessage({
        method: 'Page.loadEventFired',
        params: { timestamp: 1234 },
      });

      expect(handler).toHaveBeenCalledWith({ timestamp: 1234 });
    });

    it('supports multiple listeners for the same event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      client.on('Network.requestWillBeSent', h1);
      client.on('Network.requestWillBeSent', h2);

      ws.simulateMessage({
        method: 'Network.requestWillBeSent',
        params: { requestId: '1' },
      });

      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it('removes listeners with off()', () => {
      const handler = vi.fn();
      client.on('Page.loadEventFired', handler);
      client.off('Page.loadEventFired', handler);

      ws.simulateMessage({ method: 'Page.loadEventFired', params: {} });

      expect(handler).not.toHaveBeenCalled();
    });

    it('once() resolves on event', async () => {
      const promise = client.once('Page.loadEventFired');

      ws.simulateMessage({
        method: 'Page.loadEventFired',
        params: { timestamp: 5678 },
      });

      const result = await promise;
      expect(result).toEqual({ timestamp: 5678 });
    });

    it('once() times out', async () => {
      const promise = client.once('Page.loadEventFired', 50);

      await expect(promise).rejects.toThrow('Timed out');
    });
  });

  describe('connection lifecycle', () => {
    it('rejects pending commands on close', async () => {
      const p = client.connect({ url: 'ws://test/cdp' });
      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      await p;

      const sendPromise = client.send('Page.enable');

      // Simulate unexpected close
      ws.simulateClose();

      await expect(sendPromise).rejects.toThrow('connection closed');
    });

    it('disconnect cleans up state', async () => {
      const p = client.connect({ url: 'ws://test/cdp' });
      MockWebSocket.instances[0].simulateOpen();
      await p;

      client.disconnect();
      expect(client.state).toBe('disconnected');
    });
  });
});
