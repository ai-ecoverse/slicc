import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractHandoffFromHeaders,
  type NavigationEvent,
  NavigationWatcher,
} from '../../src/cdp/navigation-watcher.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../../src/cdp/types.js';

const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';
const UPSKILL_REL = 'https://www.sliccy.ai/rel/upskill';

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
    this.listeners.get(event)?.forEach((l) => {
      l(params);
    });
  }
}

describe('extractHandoffFromHeaders', () => {
  it('returns the handoff verb match for a Link header (case-insensitive header name)', () => {
    const result = extractHandoffFromHeaders(
      { Link: `<>; rel="${HANDOFF_REL}"; title="do it"` },
      'https://example.com/page'
    );
    expect(result.match).toEqual({
      verb: 'handoff',
      target: 'https://example.com/page',
      instruction: 'do it',
    });
  });

  it('returns the upskill verb match with absolute github href', () => {
    const result = extractHandoffFromHeaders(
      { link: `<https://github.com/o/r>; rel="${UPSKILL_REL}"` },
      'https://example.com/page'
    );
    expect(result.match).toEqual({
      verb: 'upskill',
      target: 'https://github.com/o/r',
    });
  });

  it('returns null when no recognised rel is present', () => {
    const result = extractHandoffFromHeaders({ link: '</foo>; rel="next"' });
    expect(result.match).toBeNull();
  });

  it('returns null for missing or empty headers', () => {
    expect(extractHandoffFromHeaders({}).match).toBeNull();
    expect(extractHandoffFromHeaders({ link: '' }).match).toBeNull();
    expect(extractHandoffFromHeaders(undefined).match).toBeNull();
  });

  it('decodes RFC 8187 title* (emoji + CJK) into instruction', () => {
    const result = extractHandoffFromHeaders(
      {
        link: `<>; rel="${HANDOFF_REL}"; title*=UTF-8''Continue%20%F0%9F%9A%80%20%E4%BD%A0%E5%A5%BD`,
      },
      'https://example.com/'
    );
    expect(result.match?.instruction).toBe('Continue 🚀 你好');
  });
});

describe('NavigationWatcher', () => {
  let transport: MockCDPTransport;
  let events: NavigationEvent[];
  let watcher: NavigationWatcher;

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
    watcher = new NavigationWatcher(transport, (e) => events.push(e));
  });

  it('subscribes to target discovery on start (no auto-attach)', async () => {
    await watcher.start();
    const methods = transport.sentCommands.map((c) => c.method);
    expect(methods).toContain('Target.setDiscoverTargets');
    // Auto-attach is intentionally NOT used — it causes Chrome to freeze
    // the opener tab when window.open() creates a popup.
    expect(methods).not.toContain('Target.setAutoAttach');
  });

  it('attaches to targets opened with an openerId (target="_blank" / window.open())', async () => {
    // Regression: NavigationWatcher previously skipped every target
    // with `openerId`, which meant `<a target="_blank">` clicks
    // never got Page/Network enabled and their main-frame Link
    // headers were silently dropped. Manual attach (without enabling
    // the Debugger domain) does not pause anything, so we attach to
    // all page targets including link-click children.
    await watcher.start();
    transport.sentCommands.length = 0;

    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'tab-child',
        type: 'page',
        attached: false,
        openerId: 'tab-parent',
        url: 'https://ex.com/landing',
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const attachCalls = transport.sentCommands.filter((c) => c.method === 'Target.attachToTarget');
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].params).toMatchObject({ targetId: 'tab-child', flatten: true });

    // And the watcher must subsequently emit the navigate event for
    // that tab's main-frame Document response, end-to-end.
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-child',
      targetInfo: {
        targetId: 'tab-child',
        type: 'page',
        url: 'https://ex.com/landing',
        openerId: 'tab-parent',
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-child',
      type: 'Document',
      frameId: 'root-sess-child',
      response: {
        url: 'https://ex.com/landing',
        headers: { link: `<https://github.com/o/r>; rel="${UPSKILL_REL}"` },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: 'upskill',
      target: 'https://github.com/o/r',
      targetId: 'tab-child',
    });
  });

  it('still skips non-page target types (workers, iframes) regardless of openerId', async () => {
    await watcher.start();
    transport.sentCommands.length = 0;

    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'sw-1',
        type: 'service_worker',
        attached: false,
        openerId: 'tab-parent',
      },
    });
    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'iframe-1',
        type: 'iframe',
        attached: false,
        openerId: 'tab-parent',
        url: 'https://ex.com/embed',
      },
    });
    transport.emit('Target.targetCreated', {
      targetInfo: {
        targetId: 'worker-1',
        type: 'worker',
        attached: false,
        openerId: 'tab-parent',
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const attachCalls = transport.sentCommands.filter((c) => c.method === 'Target.attachToTarget');
    expect(attachCalls).toHaveLength(0);
  });

  it('emits an event when a main-frame Document response advertises a handoff Link', async () => {
    await watcher.start();

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', title: 'Example', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: {
        url: 'https://ex.com/',
        headers: {
          'content-type': 'text/html',
          link: `<>; rel="${HANDOFF_REL}"; title="do it"`,
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      url: 'https://ex.com/',
      verb: 'handoff',
      target: 'https://ex.com/',
      instruction: 'do it',
      title: 'Example',
      targetId: 'tab-1',
    });
    expect(events[0].links).toHaveLength(1);
  });

  it('emits an upskill event with absolute github target', async () => {
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
      response: {
        url: 'https://ex.com/handoff',
        headers: {
          link: `<https://github.com/slicc/skills-extra>; rel="${UPSKILL_REL}"`,
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].verb).toBe('upskill');
    expect(events[0].target).toBe('https://github.com/slicc/skills-extra');
  });

  it('propagates upskill branch + path Link params end-to-end into the emitted event', async () => {
    // The verifier confirmed propagation by reading the code; this
    // test locks it in so a future refactor of either the CDP shape
    // or the extractor can't silently drop branch/path.
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
      response: {
        url: 'https://ex.com/handoff',
        headers: {
          link: `<https://github.com/owner/repo>; rel="${UPSKILL_REL}"; branch=feature/x; path="skills/foo"`,
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: 'upskill',
      target: 'https://github.com/owner/repo',
      branch: 'feature/x',
      path: 'skills/foo',
      targetId: 'tab-1',
    });
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
      response: {
        url: 'https://ex.com/iframe',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="ignored"` },
      },
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
      response: {
        url: 'https://ex.com/a.css',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="ignored"` },
      },
    });

    expect(events).toHaveLength(0);
  });

  it('does not emit when no recognised rel is present', async () => {
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
      response: {
        url: 'https://ex.com/',
        headers: { 'content-type': 'text/html', link: '</foo>; rel="next"' },
      },
    });

    expect(events).toHaveLength(0);
  });

  it('does not emit when the legacy x-slicc header is present (clean break)', async () => {
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
      response: {
        url: 'https://ex.com/',
        headers: { 'x-slicc': 'handoff:should be ignored' },
      },
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
      response: {
        url: 'https://ex.com/next',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="navigated"` },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].instruction).toBe('navigated');
  });

  it('can be retried after a transient setDiscoverTargets failure', async () => {
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

    // Listeners should have been torn down on the failure path.
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));
    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: {
        url: 'https://ex.com/',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="first-try"` },
      },
    });
    expect(events).toHaveLength(0);

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
      response: {
        url: 'https://ex.com/',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="second-try"` },
      },
    });
    expect(events.map((e) => e.instruction)).toEqual(['second-try']);
  });

  it('does not emit when neither response.url nor session url is known', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: { headers: { link: `<>; rel="${HANDOFF_REL}"; title="unreachable"` } },
    });

    expect(events).toHaveLength(0);
  });

  it('stop() unsubscribes listeners and disables discovery', async () => {
    await watcher.start();
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-1',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await new Promise((r) => setTimeout(r, 0));

    transport.sentCommands.length = 0;
    await watcher.stop();

    const methods = transport.sentCommands.map((c) => c.method);
    expect(methods).toContain('Target.setDiscoverTargets');
    expect(methods).not.toContain('Target.setAutoAttach');
    const discover = transport.sentCommands.find((c) => c.method === 'Target.setDiscoverTargets');
    expect(discover?.params).toMatchObject({ discover: false });

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-1',
      type: 'Document',
      frameId: 'root-sess-1',
      response: {
        url: 'https://ex.com/',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="after-stop"` },
      },
    });
    expect(events).toHaveLength(0);
  });
});
