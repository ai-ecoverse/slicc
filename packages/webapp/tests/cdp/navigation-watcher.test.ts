import { describe, it, expect, beforeEach } from 'vitest';
import {
  NavigationWatcher,
  extractSliccHeader,
  decodeSliccHeader,
} from '../../src/cdp/navigation-watcher.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { CDPEventListener, ConnectionState, CDPConnectOptions } from '../../src/cdp/types.js';

class MockCDPTransport implements CDPTransport {
  state: ConnectionState = 'connected';
  private listeners = new Map<string, Set<CDPEventListener>>();
  public sentCommands: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  public targetInfos: Array<Record<string, unknown>> = [];
  public frameTreeBySession = new Map<string, { frame: { id: string } }>();

  async connect(_options?: CDPConnectOptions): Promise<void> {
    this.state = 'connected';
  }
  disconnect(): void {
    this.state = 'disconnected';
  }
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    this.sentCommands.push({ method, params, sessionId });
    if (method === 'Target.getTargets') {
      return { targetInfos: this.targetInfos };
    }
    if (method === 'Page.getFrameTree') {
      const override = this.frameTreeBySession.get(sessionId ?? '');
      if (override) return { frameTree: override };
      return { frameTree: { frame: { id: `root-${sessionId}` } } };
    }
    return {};
  }
  on(event: string, listener: CDPEventListener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: CDPEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  async once(_event: string): Promise<Record<string, unknown>> {
    return {};
  }
  emit(event: string, params: Record<string, unknown>): void {
    this.listeners.get(event)?.forEach((l) => l(params));
  }
}

describe('decodeSliccHeader', () => {
  it('decodes percent-encoded values', () => {
    expect(decodeSliccHeader('handoff%3Afoo%20bar')).toBe('handoff:foo bar');
    expect(decodeSliccHeader('upskill%3Ahttps%3A%2F%2Fgithub.com%2Fx%2Fy')).toBe(
      'upskill:https://github.com/x/y'
    );
  });

  it('round-trips unicode produced by encodeURIComponent', () => {
    const original = 'handoff:🚀 你好';
    expect(decodeSliccHeader(encodeURIComponent(original))).toBe(original);
  });

  it('leaves plain ASCII unchanged (idempotent)', () => {
    expect(decodeSliccHeader('handoff:do-it')).toBe('handoff:do-it');
  });

  it('falls back to the raw value for malformed percent sequences', () => {
    expect(decodeSliccHeader('handoff:50%')).toBe('handoff:50%');
  });
});

describe('extractSliccHeader', () => {
  it('decodes the value for x-slicc (case-insensitive)', () => {
    expect(extractSliccHeader({ 'X-Slicc': 'handoff%3Ado%20it' })).toBe('handoff:do it');
    expect(extractSliccHeader({ 'x-slicc': 'upskill:url' })).toBe('upskill:url');
  });

  it('returns null for missing or empty header', () => {
    expect(extractSliccHeader({})).toBeNull();
    expect(extractSliccHeader({ 'x-slicc': '' })).toBeNull();
    expect(extractSliccHeader(undefined)).toBeNull();
  });

  it('ignores non-string header values', () => {
    expect(extractSliccHeader({ 'x-slicc': 123 as unknown as string })).toBeNull();
  });
});

describe('NavigationWatcher', () => {
  let transport: MockCDPTransport;
  let events: Array<{ url: string; sliccHeader: string; title?: string; targetId: string }>;
  let watcher: NavigationWatcher;

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
    watcher = new NavigationWatcher(transport, (e) => events.push(e));
  });

  it('subscribes to target discovery and auto-attach on start', async () => {
    await watcher.start();
    const methods = transport.sentCommands.map((c) => c.method);
    expect(methods).toContain('Target.setDiscoverTargets');
    expect(methods).toContain('Target.setAutoAttach');
  });

  it('emits an event when a main-frame Document response carries x-slicc', async () => {
    await watcher.start();

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', title: 'Example', url: 'https://ex.com/' },
    });
    // Allow attachedToTarget's async handler (Page.enable/Network.enable/getFrameTree) to run.
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: {
        url: 'https://ex.com/',
        headers: { 'content-type': 'text/html', 'x-slicc': 'handoff:do it' },
      },
    });

    expect(events).toEqual([
      {
        url: 'https://ex.com/',
        sliccHeader: 'handoff:do it',
        title: 'Example',
        targetId: 'tab-1',
      },
    ]);
  });

  it('ignores subframe document responses', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'subframe-id', // not root-sess-1
      response: { url: 'https://ex.com/iframe', headers: { 'x-slicc': 'handoff:ignored' } },
    });

    expect(events).toHaveLength(0);
  });

  it('ignores non-Document response types', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Stylesheet',
      frameId: 'root-sess-1',
      response: { url: 'https://ex.com/a.css', headers: { 'x-slicc': 'handoff:ignored' } },
    });

    expect(events).toHaveLength(0);
  });

  it('does not emit when x-slicc header is absent', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: { url: 'https://ex.com/', headers: { 'content-type': 'text/html' } },
    });

    expect(events).toHaveLength(0);
  });

  it('tracks root-frame id updates via Page.frameNavigated', async () => {
    // Scenario: Page.getFrameTree on attach sets root-sess-1, then the page navigates
    // and frame.id changes. The watcher should follow the new root frame id.
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Page.frameNavigated', {
      sessionId: 'sess-1',
      frame: { id: 'new-root', url: 'https://ex.com/next' },
    });

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'new-root',
      response: { url: 'https://ex.com/next', headers: { 'x-slicc': 'handoff:navigated' } },
    });

    expect(events).toHaveLength(1);
    expect(events[0].sliccHeader).toBe('handoff:navigated');
  });

  it('can be retried after a transient setDiscoverTargets failure', async () => {
    // First call: make Target.setDiscoverTargets throw.
    let failOnce = true;
    const originalSend = transport.send.bind(transport);
    (transport.send as unknown) = async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ) => {
      if (failOnce && method === 'Target.setDiscoverTargets') {
        failOnce = false;
        throw new Error('transient CDP failure');
      }
      return originalSend(method, params, sessionId);
    };

    await watcher.start();

    // Emitting an event now must NOT produce anything — listeners should
    // have been torn down on the failure path.
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));
    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: { url: 'https://ex.com/', headers: { 'x-slicc': 'handoff:first-try' } },
    });
    expect(events).toHaveLength(0);

    // Retry: should succeed.
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-2',
      targetInfo: { targetId: 'tab-2', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));
    transport.emit('Network.responseReceived', {
      sessionId: 'sess-2',
      type: 'Document',
      frameId: 'root-sess-2',
      response: { url: 'https://ex.com/', headers: { 'x-slicc': 'handoff:second-try' } },
    });
    expect(events.map((e) => e.sliccHeader)).toEqual(['handoff:second-try']);
  });

  it('stop() unsubscribes listeners', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    watcher.stop();

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: { url: 'https://ex.com/', headers: { 'x-slicc': 'handoff:after-stop' } },
    });
    expect(events).toHaveLength(0);
  });
});
