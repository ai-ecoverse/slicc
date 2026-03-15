import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the playground bridge inject protocol.
 * We can't execute the IIFE directly (it references `location`, `window`, `BroadcastChannel`),
 * so we test the message protocol by simulating what the bridge does.
 */

// Mock BroadcastChannel for Node
class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private static channels = new Map<string, Set<MockBroadcastChannel>>();
  closed = false;

  constructor(name: string) {
    this.name = name;
    if (!MockBroadcastChannel.channels.has(name)) {
      MockBroadcastChannel.channels.set(name, new Set());
    }
    MockBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const peers = MockBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && peer.onmessage && !peer.closed) {
        peer.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close(): void {
    this.closed = true;
    MockBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    MockBroadcastChannel.channels.clear();
  }
}

describe('playground bridge protocol', () => {
  beforeEach(() => {
    MockBroadcastChannel.reset();
  });

  afterEach(() => {
    MockBroadcastChannel.reset();
  });

  it('playground-ready message includes id and path', () => {
    const host = new MockBroadcastChannel('slicc-playground');
    const received: unknown[] = [];
    host.onmessage = (e) => received.push(e.data);

    // Simulate what the bridge does on load
    const playground = new MockBroadcastChannel('slicc-playground');
    const id = '/test.html:abc123';
    playground.postMessage({ type: 'playground-ready', id, path: '/test.html' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'playground-ready',
      id: '/test.html:abc123',
      path: '/test.html',
    });

    host.close();
    playground.close();
  });

  it('playground-lick carries action and data', () => {
    const host = new MockBroadcastChannel('slicc-playground');
    const received: unknown[] = [];
    host.onmessage = (e) => received.push(e.data);

    const playground = new MockBroadcastChannel('slicc-playground');
    const id = '/app.html:xyz';
    playground.postMessage({ type: 'playground-lick', id, action: 'click', data: { x: 10 } });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'playground-lick',
      id: '/app.html:xyz',
      action: 'click',
      data: { x: 10 },
    });

    host.close();
    playground.close();
  });

  it('playground-update reaches the targeted playground', () => {
    const playground = new MockBroadcastChannel('slicc-playground');
    const received: unknown[] = [];
    playground.onmessage = (e) => {
      if (e.data?.targetId === 'pg1') received.push(e.data);
    };

    const host = new MockBroadcastChannel('slicc-playground');
    host.postMessage({ type: 'playground-update', targetId: 'pg1', data: { result: 42 } });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: 'playground-update',
      targetId: 'pg1',
      data: { result: 42 },
    });

    host.close();
    playground.close();
  });

  it('playground-set-state and playground-get-state round-trip', () => {
    const playground = new MockBroadcastChannel('slicc-playground');
    const host = new MockBroadcastChannel('slicc-playground');

    const responses: unknown[] = [];
    playground.onmessage = (e) => {
      if (e.data?.type === 'playground-state-response') responses.push(e.data);
    };

    // Simulate state persistence via the host
    let storedState: unknown = null;
    host.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'playground-set-state') {
        storedState = msg.data;
      } else if (msg?.type === 'playground-get-state') {
        host.postMessage({
          type: 'playground-state-response',
          targetId: msg.id,
          data: storedState,
        });
      }
    };

    // Set state
    playground.postMessage({ type: 'playground-set-state', id: 'pg1', data: { count: 5 } });
    expect(storedState).toEqual({ count: 5 });

    // Get state
    playground.postMessage({ type: 'playground-get-state', id: 'pg1' });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      type: 'playground-state-response',
      targetId: 'pg1',
      data: { count: 5 },
    });

    host.close();
    playground.close();
  });

  it('playground-readfile request and response', () => {
    const playground = new MockBroadcastChannel('slicc-playground');
    const host = new MockBroadcastChannel('slicc-playground');

    const responses: unknown[] = [];
    playground.onmessage = (e) => {
      if (e.data?.type === 'playground-readfile-response') responses.push(e.data);
    };

    host.onmessage = (e) => {
      const msg = e.data;
      if (msg?.type === 'playground-readfile') {
        host.postMessage({
          type: 'playground-readfile-response',
          targetId: msg.id,
          requestId: msg.requestId,
          content: 'file contents here',
        });
      }
    };

    playground.postMessage({
      type: 'playground-readfile',
      id: 'pg1',
      requestId: 'rf-001',
      path: '/shared/data.txt',
    });

    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      type: 'playground-readfile-response',
      targetId: 'pg1',
      requestId: 'rf-001',
      content: 'file contents here',
    });

    host.close();
    playground.close();
  });

  it('playground-close is communicated', () => {
    const host = new MockBroadcastChannel('slicc-playground');
    const received: unknown[] = [];
    host.onmessage = (e) => received.push(e.data);

    const playground = new MockBroadcastChannel('slicc-playground');
    playground.postMessage({ type: 'playground-close', id: 'pg1' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: 'playground-close', id: 'pg1' });

    host.close();
    playground.close();
  });
});
