import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DiscoveryEvent,
  extractHandoffFromHeaders,
  type NavigationEvent,
  NavigationWatcher,
} from '../../src/cdp/navigation-watcher.js';
import type { CDPStateListener, CDPTransport } from '../../src/cdp/transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../../src/cdp/types.js';
import type { ProbeFetch, ProbeResponse } from '../../src/net/well-known-probe.js';

const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';
const UPSKILL_REL = 'https://www.sliccy.ai/rel/upskill';

class MockCDPTransport implements CDPTransport {
  state: ConnectionState = 'connected';
  private listeners = new Map<string, Set<CDPEventListener>>();
  private stateListeners = new Set<CDPStateListener>();
  public sentCommands: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  public targetInfos: Array<Record<string, unknown>> = [];
  public frameTreeBySession = new Map<string, { frame: { id: string } }>();
  /**
   * Session id `Target.attachToTarget` resolves with, per target id. Empty by
   * default, which models the common live ordering: the
   * `Target.attachedToTarget` event reaches the watcher before the command
   * response does, so ownership has to be claimed by target id.
   */
  public attachSessionIdByTarget = new Map<string, string>();

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
    if (method === 'Target.attachToTarget') {
      const targetId = String(params?.targetId ?? '');
      const bound = this.attachSessionIdByTarget.get(targetId);
      return bound ? { sessionId: bound } : {};
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
  onStateChange(listener: CDPStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  /** How many listeners are registered for `event` (double-registration probe). */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
  /**
   * Model an upstream reset the way a real transport does: the connection
   * goes away (a bridge-backed one also drops every CDP event listener), then
   * a replacement connection comes up.
   */
  simulateDrop(reason = 'CDP connection closed', clearListeners = true): void {
    this.state = 'disconnected';
    if (clearListeners) this.listeners.clear();
    for (const l of this.stateListeners) l('disconnected', reason);
  }
  simulateReconnect(): void {
    this.state = 'connected';
    for (const l of this.stateListeners) l('connected');
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Drive the watcher's own attach path for a page target: `Target.targetCreated`
 * makes the watcher send `Target.attachToTarget`, `Target.attachedToTarget` is
 * Chrome's answer to that request. Sessions the watcher did not request are
 * deliberately NOT enabled (see the foreign-session tests), so every test that
 * expects Page/Network events has to go through here.
 */
async function attachOwnTab(
  transport: MockCDPTransport,
  sessionId: string,
  targetInfo: Record<string, unknown> & { targetId: string }
): Promise<void> {
  transport.emit('Target.targetCreated', {
    targetInfo: { type: 'page', attached: false, ...targetInfo },
  });
  await tick();
  transport.emit('Target.attachedToTarget', {
    sessionId,
    targetInfo: { type: 'page', ...targetInfo },
  });
  await tick();
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

  it('enables Page/Network only on the session it attached itself', async () => {
    await watcher.start();
    transport.sentCommands.length = 0;

    await attachOwnTab(transport, 'sess-own', { targetId: 'tab-1', url: 'https://ex.com/' });

    const forSession = transport.sentCommands.filter((c) => c.sessionId === 'sess-own');
    expect(forSession.map((c) => c.method)).toEqual([
      'Page.enable',
      'Network.enable',
      'Page.getFrameTree',
    ]);
  });

  it('does not enable Page/Network on a session it did not attach (BrowserAPI fan-out)', async () => {
    // Issue #2417: `BrowserAPI` mints a session per tab switch for
    // playwright-cli and never detaches it. Enabling Page/Network on those
    // sessions too made Chrome fan every event out once more per leaked
    // session (+16 inbound events per navigation with the watcher vs +9
    // without). The watcher must ignore sessions it did not request.
    await watcher.start();
    transport.sentCommands.length = 0;

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-foreign',
      targetInfo: { targetId: 'tab-foreign', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    expect(transport.sentCommands.filter((c) => c.sessionId === 'sess-foreign')).toHaveLength(0);
    const methods = transport.sentCommands.map((c) => c.method);
    expect(methods).not.toContain('Page.enable');
    expect(methods).not.toContain('Network.enable');
    expect(methods).not.toContain('Page.getFrameTree');
  });

  it('still emits a navigate event on a foreign session whose owner enabled the domains', async () => {
    // Bookkeeping is unchanged: a session the watcher did not attach is still
    // tracked, so if whoever owns it has Page/Network on, the lick still fires.
    await watcher.start();

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-foreign',
      targetInfo: { targetId: 'tab-foreign', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    // Root frame id comes from Page.frameNavigated rather than the
    // Page.getFrameTree the watcher no longer sends for this session.
    transport.emit('Page.frameNavigated', {
      sessionId: 'sess-foreign',
      frame: { id: 'root-foreign', url: 'https://ex.com/' },
    });
    transport.emit('Network.responseReceived', {
      sessionId: 'sess-foreign',
      type: 'Document',
      frameId: 'root-foreign',
      response: {
        url: 'https://ex.com/',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="foreign"` },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ instruction: 'foreign', targetId: 'tab-foreign' });
  });

  it('claims ownership by sessionId once the attachToTarget response lands', async () => {
    // Response-before-event ordering: Chrome answered with the session id, so
    // a second (foreign) session on the SAME target must not be claimed.
    transport.attachSessionIdByTarget.set('tab-1', 'sess-own');
    await watcher.start();

    transport.emit('Target.targetCreated', {
      targetInfo: { targetId: 'tab-1', type: 'page', attached: false, url: 'https://ex.com/' },
    });
    await tick();
    transport.sentCommands.length = 0;

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-own',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-browser-api',
      targetInfo: { targetId: 'tab-1', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    expect(transport.sentCommands.filter((c) => c.sessionId === 'sess-own')).toHaveLength(3);
    expect(transport.sentCommands.filter((c) => c.sessionId === 'sess-browser-api')).toHaveLength(
      0
    );
  });

  it('attaches to preexisting unattached targets and enables domains on them', async () => {
    transport.targetInfos = [
      { targetId: 'tab-pre', type: 'page', attached: false, url: 'https://ex.com/' },
      { targetId: 'tab-taken', type: 'page', attached: true, url: 'https://ex.com/other' },
      { targetId: 'sw-pre', type: 'service_worker', attached: false },
    ];

    await watcher.start();

    const attachCalls = transport.sentCommands.filter((c) => c.method === 'Target.attachToTarget');
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].params).toMatchObject({ targetId: 'tab-pre', flatten: true });

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-pre',
      targetInfo: { targetId: 'tab-pre', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    expect(transport.sentCommands.filter((c) => c.sessionId === 'sess-pre').map((c) => c.method)) //
      .toEqual(['Page.enable', 'Network.enable', 'Page.getFrameTree']);

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-pre',
      type: 'Document',
      frameId: 'root-sess-pre',
      response: {
        url: 'https://ex.com/',
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="preexisting"` },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ instruction: 'preexisting', targetId: 'tab-pre' });
  });

  it('re-attaches a target after its own session detached', async () => {
    await watcher.start();
    await attachOwnTab(transport, 'sess-own', { targetId: 'tab-1', url: 'https://ex.com/' });

    transport.emit('Target.detachedFromTarget', { sessionId: 'sess-own' });
    transport.sentCommands.length = 0;

    // A fresh discovery of the same target must be attachable again, and the
    // old session id must no longer count as ours.
    await attachOwnTab(transport, 'sess-own-2', { targetId: 'tab-1', url: 'https://ex.com/' });
    expect(transport.sentCommands.filter((c) => c.sessionId === 'sess-own-2')).toHaveLength(3);
  });

  it('emits an event when a main-frame Document response advertises a handoff Link', async () => {
    await watcher.start();

    await attachOwnTab(transport, 'sess-1', {
      targetId: 'tab-1',
      title: 'Example',
      url: 'https://ex.com/',
    });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });
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
    await attachOwnTab(transport, 'sess-2', { targetId: 'tab-2', url: 'https://ex.com/' });
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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1' });

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
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

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

describe('NavigationWatcher ARD discovery', () => {
  const AI_CATALOG_URL = 'https://ex.com/.well-known/ai-catalog.json';
  const LLMS_TXT_URL = 'https://ex.com/llms.txt';

  let transport: MockCDPTransport;
  let events: NavigationEvent[];
  let discoveries: DiscoveryEvent[];

  // Flush the microtask + macrotask queue so the fire-and-forget well-known
  // probe (an async chain behind `void this.runWellKnownProbe(...)`) settles.
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  }

  async function attachTab(sessionId: string, url: string): Promise<void> {
    await attachOwnTab(transport, sessionId, { targetId: `tab-${sessionId}`, url });
  }

  function emitDocument(sessionId: string, url: string, headers: Record<string, unknown>): void {
    transport.emit('Network.responseReceived', {
      sessionId,
      type: 'Document',
      frameId: `root-${sessionId}`,
      response: { url, headers },
    });
  }

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
    discoveries = [];
  });

  it('emits a discovery event for a rel="ai-catalog" Link header', async () => {
    // probeFetch answers 404 so only the header vector fires.
    const probeFetch: ProbeFetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
    });
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
      probeFetch,
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    emitDocument('sess-1', 'https://ex.com/', {
      'content-type': 'text/html',
      link: `<${AI_CATALOG_URL}>; rel="ai-catalog"`,
    });
    await flush();

    expect(events).toHaveLength(0);
    const headerHit = discoveries.find((d) => d.url === AI_CATALOG_URL);
    expect(headerHit).toMatchObject({
      origin: 'https://ex.com',
      kind: 'ai-catalog',
      url: AI_CATALOG_URL,
      targetId: 'tab-sess-1',
    });
  });

  it('probes well-known locations and emits a discovery per artifact that answers', async () => {
    const probeFetch: ProbeFetch = vi.fn(async (url: string): Promise<ProbeResponse> => {
      if (url === AI_CATALOG_URL) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' } };
      }
      if (url === LLMS_TXT_URL) {
        return { ok: true, status: 200, headers: { get: () => 'text/plain' } };
      }
      return { ok: false, status: 404, headers: { get: () => null } };
    });
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
      probeFetch,
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    // No Link header — discovery must come from the background probe alone.
    emitDocument('sess-1', 'https://ex.com/', { 'content-type': 'text/html' });
    await flush();

    expect(discoveries.map((d) => `${d.kind}:${d.url}`).sort()).toEqual([
      `ai-catalog:${AI_CATALOG_URL}`,
      `llms-txt:${LLMS_TXT_URL}`,
    ]);
    for (const d of discoveries) expect(d.origin).toBe('https://ex.com');
  });

  it('probes each origin at most once per session', async () => {
    const probeFetch = vi.fn(
      async (): Promise<ProbeResponse> => ({
        ok: false,
        status: 404,
        headers: { get: () => null },
      })
    );
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
      probeFetch,
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    emitDocument('sess-1', 'https://ex.com/a', { 'content-type': 'text/html' });
    await flush();
    emitDocument('sess-1', 'https://ex.com/b', { 'content-type': 'text/html' });
    await flush();

    // Two well-known targets probed exactly once for the origin (2 calls),
    // not re-probed on the second same-origin navigation.
    expect(probeFetch).toHaveBeenCalledTimes(2);
  });

  it('does nothing when discovery is disabled (no header emit, no probe)', async () => {
    const probeFetch = vi.fn(
      async (): Promise<ProbeResponse> => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
      })
    );
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
      probeFetch,
      isDiscoveryEnabled: () => false,
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    emitDocument('sess-1', 'https://ex.com/', {
      link: `<${AI_CATALOG_URL}>; rel="ai-catalog"`,
    });
    await flush();

    expect(discoveries).toHaveLength(0);
    expect(probeFetch).not.toHaveBeenCalled();
  });

  it('still emits a handoff navigate event alongside discovery on the same response', async () => {
    const probeFetch: ProbeFetch = async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
    });
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
      probeFetch,
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    emitDocument('sess-1', 'https://ex.com/', {
      link: `<>; rel="${HANDOFF_REL}"; title="do it", <${AI_CATALOG_URL}>; rel="ai-catalog"`,
    });
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verb: 'handoff', instruction: 'do it' });
    expect(discoveries.find((d) => d.url === AI_CATALOG_URL)).toBeTruthy();
  });

  it('runs the header vector without a probeFetch (no probing wired)', async () => {
    const watcher = new NavigationWatcher(transport, (e) => events.push(e), {
      onDiscovery: (d) => discoveries.push(d),
    });
    await watcher.start();
    await attachTab('sess-1', 'https://ex.com/');

    emitDocument('sess-1', 'https://ex.com/', {
      link: `<${AI_CATALOG_URL}>; rel="ai-catalog"`,
    });
    await flush();

    expect(discoveries).toHaveLength(1);
    expect(discoveries[0].url).toBe(AI_CATALOG_URL);
  });
});

/**
 * `Target.setDiscoverTargets`, the sessions the watcher attached, and the
 * `Page`/`Network` domains enabled on them are CONNECTION-scoped: the
 * replacement Chrome socket a proxy reset produces has none of them. Before
 * issue #2417's reset chain the watcher just stayed `started`, so handoff /
 * ARD discovery stopped after the first reset (review finding 5).
 */
describe('NavigationWatcher across an upstream reset', () => {
  let transport: MockCDPTransport;
  let events: NavigationEvent[];
  let watcher: NavigationWatcher;

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
    watcher = new NavigationWatcher(transport, (e) => events.push(e));
  });

  /** Emit a main-frame document response carrying a handoff Link header. */
  function emitHandoffResponse(sessionId: string, url: string): void {
    transport.emit('Network.responseReceived', {
      sessionId,
      type: 'Document',
      frameId: `root-${sessionId}`,
      response: { url, headers: { link: `<>; rel="${HANDOFF_REL}"; title="go"` } },
    });
  }

  it('forgets the sessions the dead connection owned', async () => {
    await watcher.start();
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/a' });
    emitHandoffResponse('sess-1', 'https://ex.com/a');
    expect(events).toHaveLength(1);

    // Keep the JS listeners registered so this isolates the SESSION state:
    // the connection went away, but the watcher is still wired up.
    transport.simulateDrop('CDP connection closed', false);
    await tick();

    // Chrome discarded that session; an event still quoting it must not be
    // matched against the watcher's stale bookkeeping.
    emitHandoffResponse('sess-1', 'https://ex.com/b');
    expect(events).toHaveLength(1);
  });

  it('re-enables target discovery and re-enumerates targets on the replacement connection', async () => {
    await watcher.start();
    transport.simulateDrop();
    await tick();

    transport.targetInfos = [{ targetId: 'tab-pre', type: 'page', attached: false }];
    transport.sentCommands.length = 0;
    transport.simulateReconnect();
    await tick();

    const sent = transport.sentCommands;
    expect(sent).toContainEqual({
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
      sessionId: undefined,
    });
    expect(sent.map((c) => c.method)).toContain('Target.getTargets');
    expect(sent.filter((c) => c.method === 'Target.attachToTarget')[0]?.params).toMatchObject({
      targetId: 'tab-pre',
    });
  });

  it('re-arms its event listeners when the transport cleared them, without double-registering', async () => {
    await watcher.start();
    expect(transport.listenerCount('Target.attachedToTarget')).toBe(1);

    // A bridge-backed transport runs disconnect() on its reconnect path, which
    // empties the listener registry.
    transport.simulateDrop();
    await tick();
    expect(transport.listenerCount('Target.attachedToTarget')).toBe(0);

    transport.simulateReconnect();
    await tick();
    expect(transport.listenerCount('Target.attachedToTarget')).toBe(1);
    expect(transport.listenerCount('Network.responseReceived')).toBe(1);

    // ...and discovery works end-to-end again on the new connection.
    await attachOwnTab(transport, 'sess-2', { targetId: 'tab-2', url: 'https://ex.com/c' });
    emitHandoffResponse('sess-2', 'https://ex.com/c');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ verb: 'handoff', targetId: 'tab-2' });
  });

  it('does not double-register when the transport kept its listeners', async () => {
    await watcher.start();
    transport.simulateDrop('CDP connection closed', false);
    await tick();
    transport.simulateReconnect();
    await tick();

    expect(transport.listenerCount('Target.attachedToTarget')).toBe(1);

    await attachOwnTab(transport, 'sess-3', { targetId: 'tab-3', url: 'https://ex.com/d' });
    emitHandoffResponse('sess-3', 'https://ex.com/d');
    expect(events).toHaveLength(1); // not 2 — one listener, one emit
  });

  it('drops a pending attach across the reset so a later foreign session is not claimed', async () => {
    await watcher.start();
    // `attachSessionIdByTarget` is empty, so the attach response binds no
    // session id and the target stays in `pendingAttachTargetIds`.
    transport.emit('Target.targetCreated', {
      targetInfo: { targetId: 'tab-x', type: 'page', attached: false },
    });
    await tick();

    // Listeners kept, so a watcher that ignored the reset would still see the
    // attach event below and (wrongly) claim it via the stale pending id.
    transport.simulateDrop('CDP connection closed', false);
    await tick();
    transport.simulateReconnect();
    await tick();
    transport.sentCommands.length = 0;

    // A session BrowserAPI attached for its own per-tab work, on the same tab.
    transport.emit('Target.attachedToTarget', {
      sessionId: 'foreign-1',
      targetInfo: { targetId: 'tab-x', type: 'page', url: 'https://ex.com/x' },
    });
    await tick();

    // Enabling Page/Network on a session we do not own is the event
    // amplification #2417 set out to remove.
    expect(transport.sentCommands.filter((c) => c.sessionId === 'foreign-1')).toEqual([]);
  });

  it('stops following the transport after stop()', async () => {
    await watcher.start();
    await watcher.stop();
    transport.sentCommands.length = 0;

    transport.simulateDrop();
    await tick();
    transport.simulateReconnect();
    await tick();

    expect(transport.sentCommands.map((c) => c.method)).not.toContain('Target.setDiscoverTargets');
  });

  it('stays armed when re-enabling discovery fails, and recovers on the next reconnect', async () => {
    await watcher.start();
    transport.simulateDrop();
    await tick();

    const realSend = transport.send.bind(transport);
    let failNext = true;
    transport.send = async (method, params, sessionId) => {
      if (failNext && method === 'Target.setDiscoverTargets') {
        failNext = false;
        throw new Error('transient CDP failure');
      }
      return realSend(method, params, sessionId);
    };

    transport.simulateReconnect();
    await tick();
    transport.sentCommands.length = 0;

    transport.simulateReconnect();
    await tick();
    expect(transport.sentCommands.map((c) => c.method)).toContain('Target.setDiscoverTargets');
  });
});
