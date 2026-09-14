import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOwnTabMatcher,
  type DiscoveryEvent,
  extractHandoffFromHeaders,
  type NavigationEvent,
  NavigationWatcher,
  type NavigationWatcherOptions,
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

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

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

    expect(methods).not.toContain('Target.setAutoAttach');
  });

  it('attaches to targets opened with an openerId (target="_blank" / window.open())', async () => {
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
    await watcher.start();

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-foreign',
      targetInfo: { targetId: 'tab-foreign', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

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

    expect(
      transport.sentCommands.filter((c) => c.sessionId === 'sess-pre').map((c) => c.method)
    ).toEqual(['Page.enable', 'Network.enable', 'Page.getFrameTree']);

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
      frameId: 'subframe-id',
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

describe('NavigationWatcher across an upstream reset', () => {
  let transport: MockCDPTransport;
  let events: NavigationEvent[];
  let watcher: NavigationWatcher;

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
    watcher = new NavigationWatcher(transport, (e) => events.push(e));
  });

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

    transport.simulateDrop('CDP connection closed', false);
    await tick();

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

    transport.simulateDrop();
    await tick();
    expect(transport.listenerCount('Target.attachedToTarget')).toBe(0);

    transport.simulateReconnect();
    await tick();
    expect(transport.listenerCount('Target.attachedToTarget')).toBe(1);
    expect(transport.listenerCount('Network.responseReceived')).toBe(1);

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
    expect(events).toHaveLength(1);
  });

  it('drops a pending attach across the reset so a later foreign session is not claimed', async () => {
    await watcher.start();

    transport.emit('Target.targetCreated', {
      targetInfo: { targetId: 'tab-x', type: 'page', attached: false },
    });
    await tick();

    transport.simulateDrop('CDP connection closed', false);
    await tick();
    transport.simulateReconnect();
    await tick();
    transport.sentCommands.length = 0;

    transport.emit('Target.attachedToTarget', {
      sessionId: 'foreign-1',
      targetInfo: { targetId: 'tab-x', type: 'page', url: 'https://ex.com/x' },
    });
    await tick();

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

  it('re-arms again when a second reconnect lands while the first re-arm is still in flight', async () => {
    await watcher.start();
    transport.simulateDrop();
    await tick();

    const realSend = transport.send.bind(transport);
    let release: (() => void) | null = null;
    let held = 0;
    transport.send = async (method, params, sessionId) => {
      if (method === 'Target.setDiscoverTargets' && held === 0) {
        held += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        throw new Error('rejected by the intervening reset');
      }
      return realSend(method, params, sessionId);
    };

    transport.simulateReconnect();
    await tick();

    transport.simulateDrop();
    transport.simulateReconnect();
    await tick();
    transport.sentCommands.length = 0;

    release!();
    await tick();
    await tick();

    expect(transport.sentCommands.map((c) => c.method)).toContain('Target.setDiscoverTargets');
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

describe('createOwnTabMatcher', () => {
  const LEADER = 'https://www.sliccy.ai/?slicc=leader&ext=abc123';

  it('matches the app tab across differing query and fragment', () => {
    const isOwn = createOwnTabMatcher(() => LEADER);
    expect(isOwn({ url: 'https://www.sliccy.ai/' })).toBe(true);
    expect(isOwn({ url: 'https://www.sliccy.ai/?ui=wc&tray=join-1' })).toBe(true);
    expect(isOwn({ url: 'https://www.sliccy.ai/#/settings' })).toBe(true);
  });

  it('does NOT match a handoff page served from the app origin', () => {
    const isOwn = createOwnTabMatcher(() => LEADER);
    expect(isOwn({ url: 'https://www.sliccy.ai/handoff?handoff=do%20it' })).toBe(false);
    expect(isOwn({ url: 'https://www.sliccy.ai/preview/x/index.html' })).toBe(false);
  });

  it('ignores a trailing slash on either side', () => {
    expect(
      createOwnTabMatcher(() => 'http://localhost:5710/app/')({ url: 'http://localhost:5710/app' })
    ).toBe(true);
    expect(
      createOwnTabMatcher(() => 'http://localhost:5710/app')({ url: 'http://localhost:5710/app/' })
    ).toBe(true);
  });

  it('does not match a different origin, port or scheme', () => {
    const isOwn = createOwnTabMatcher(() => 'http://localhost:5710/');
    expect(isOwn({ url: 'http://localhost:5720/' })).toBe(false);
    expect(isOwn({ url: 'https://localhost:5710/' })).toBe(false);
    expect(isOwn({ url: 'https://www.sliccy.ai/' })).toBe(false);
  });

  it('never matches on an opaque or non-http URL', () => {
    const isOwn = createOwnTabMatcher(() => 'about:blank');
    expect(isOwn({ url: 'about:blank' })).toBe(false);
    const httpApp = createOwnTabMatcher(() => 'http://localhost:5710/');
    expect(httpApp({ url: 'chrome://newtab/' })).toBe(false);
    expect(httpApp({ url: 'devtools://devtools/bundled/x.html' })).toBe(false);
  });

  it('matches nothing while the app URL is unknown or the target has none', () => {
    expect(createOwnTabMatcher(() => null)({ url: 'https://www.sliccy.ai/' })).toBe(false);
    expect(createOwnTabMatcher(() => undefined)({ url: 'https://www.sliccy.ai/' })).toBe(false);
    expect(createOwnTabMatcher(() => 'https://www.sliccy.ai/')({})).toBe(false);
  });
});

describe('NavigationWatcher own-tab handling', () => {
  const APP_URL = 'https://www.sliccy.ai/?slicc=leader';
  const HANDOFF_URL = 'https://www.sliccy.ai/handoff?handoff=continue';

  let transport: MockCDPTransport;
  let events: NavigationEvent[];

  const makeWatcher = (options: NavigationWatcherOptions = {}): NavigationWatcher =>
    new NavigationWatcher(transport, (e) => events.push(e), options);

  const ownTabOptions = (): NavigationWatcherOptions => ({
    isOwnTab: createOwnTabMatcher(() => APP_URL),
  });

  const methodsFor = (sessionId: string): string[] =>
    transport.sentCommands.filter((c) => c.sessionId === sessionId).map((c) => c.method);

  beforeEach(() => {
    transport = new MockCDPTransport();
    events = [];
  });

  it('attaches to the leader tab with Page on and Network off', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();

    await attachOwnTab(transport, 'sess-leader', { targetId: 'tab-leader', url: APP_URL });

    expect(methodsFor('sess-leader')).toEqual(['Page.enable', 'Page.getFrameTree']);
  });

  it('leaves Network off on a leader tab that was already open at start', async () => {
    transport.targetInfos = [
      { targetId: 'tab-leader', type: 'page', attached: false, url: APP_URL },
      { targetId: 'tab-other', type: 'page', attached: false, url: 'https://ex.com/' },
    ];
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();

    expect(
      transport.sentCommands
        .filter((c) => c.method === 'Target.attachToTarget')
        .map((c) => (c.params as { targetId?: string } | undefined)?.targetId)
    ).toEqual(['tab-leader', 'tab-other']);

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-leader',
      targetInfo: { targetId: 'tab-leader', type: 'page', url: APP_URL },
    });
    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-other',
      targetInfo: { targetId: 'tab-other', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    expect(methodsFor('sess-leader')).not.toContain('Network.enable');
    expect(methodsFor('sess-other')).toContain('Network.enable');
  });

  it('still watches a handoff page on the app origin', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();

    await attachOwnTab(transport, 'sess-handoff', { targetId: 'tab-handoff', url: HANDOFF_URL });
    expect(methodsFor('sess-handoff')).toContain('Network.enable');

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-handoff',
      type: 'Document',
      frameId: 'root-sess-handoff',
      response: {
        url: HANDOFF_URL,
        headers: { link: `<>; rel="${HANDOFF_REL}"; title="continue the signup flow"` },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      url: HANDOFF_URL,
      verb: 'handoff',
      instruction: 'continue the signup flow',
      targetId: 'tab-handoff',
    });
  });

  it('arms Network when the app tab starts navigating away, in time for the response', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();
    await attachOwnTab(transport, 'sess-app', { targetId: 'tab-app', url: APP_URL });
    expect(methodsFor('sess-app')).not.toContain('Network.enable');

    transport.emit('Page.frameRequestedNavigation', {
      sessionId: 'sess-app',
      frameId: 'root-sess-app',
      url: HANDOFF_URL,
    });
    await tick();
    expect(methodsFor('sess-app')).toContain('Network.enable');

    transport.emit('Network.responseReceived', {
      sessionId: 'sess-app',
      type: 'Document',
      frameId: 'root-sess-app',
      response: { url: HANDOFF_URL, headers: { link: `<>; rel="${HANDOFF_REL}"; title="late"` } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ instruction: 'late', targetId: 'tab-app' });
  });

  it('arms on a browser-initiated navigation too, and only once', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();
    await attachOwnTab(transport, 'sess-app', { targetId: 'tab-app', url: APP_URL });

    transport.emit('Page.frameStartedNavigating', {
      sessionId: 'sess-app',
      frameId: 'root-sess-app',
      url: 'https://ex.com/',
    });
    transport.emit('Page.frameStartedNavigating', {
      sessionId: 'sess-app',
      frameId: 'root-sess-app',
      url: 'https://ex.com/',
    });
    await tick();

    expect(methodsFor('sess-app').filter((m) => m === 'Network.enable')).toHaveLength(1);
  });

  it('does not arm on a subframe navigation or an in-app navigation', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();
    await attachOwnTab(transport, 'sess-app', { targetId: 'tab-app', url: APP_URL });

    transport.emit('Page.frameStartedNavigating', {
      sessionId: 'sess-app',
      frameId: 'sprinkle-frame',
      url: 'https://ex.com/',
    });

    transport.emit('Page.frameStartedNavigating', {
      sessionId: 'sess-app',
      frameId: 'root-sess-app',
      url: 'https://www.sliccy.ai/?ui=wc',
    });
    await tick();

    expect(methodsFor('sess-app')).not.toContain('Network.enable');
  });

  it('turns Network back off when a watched tab navigates INTO the app URL', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();
    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });
    expect(methodsFor('sess-1')).toContain('Network.enable');

    transport.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'tab-1', type: 'page', url: APP_URL },
    });
    await tick();

    expect(methodsFor('sess-1')).toContain('Network.disable');

    transport.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'tab-1', type: 'page', url: `${APP_URL}&x=1` },
    });
    await tick();
    expect(methodsFor('sess-1').filter((m) => m === 'Network.disable')).toHaveLength(1);
  });

  it('re-arms via targetInfoChanged when the frame events were missed', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();
    await attachOwnTab(transport, 'sess-app', { targetId: 'tab-app', url: APP_URL });

    transport.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'tab-app', type: 'page', url: 'https://ex.com/' },
    });
    await tick();

    expect(methodsFor('sess-app')).toContain('Network.enable');
  });

  it('never touches Network on a session it did not attach', async () => {
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-foreign',
      targetInfo: { targetId: 'tab-foreign', type: 'page', url: APP_URL },
    });
    await tick();
    transport.emit('Target.targetInfoChanged', {
      targetInfo: { targetId: 'tab-foreign', type: 'page', url: 'https://ex.com/' },
    });
    transport.emit('Page.frameStartedNavigating', {
      sessionId: 'sess-foreign',
      frameId: 'root-foreign',
      url: 'https://ex.com/',
    });
    await tick();

    expect(methodsFor('sess-foreign')).toEqual([]);
  });

  it('enables Network on every tab when no predicate is supplied', async () => {
    const watcher = makeWatcher();
    await watcher.start();

    await attachOwnTab(transport, 'sess-leader', { targetId: 'tab-leader', url: APP_URL });

    expect(methodsFor('sess-leader')).toEqual([
      'Page.enable',
      'Network.enable',
      'Page.getFrameTree',
    ]);
  });

  it('treats a throwing predicate as "not our tab" rather than losing every tab', async () => {
    const watcher = makeWatcher({
      isOwnTab: () => {
        throw new Error('predicate blew up');
      },
    });
    await watcher.start();

    await attachOwnTab(transport, 'sess-1', { targetId: 'tab-1', url: 'https://ex.com/' });

    expect(methodsFor('sess-1')).toContain('Network.enable');
  });

  it('keeps Network off the leader tab after an upstream reset re-enumerates targets', async () => {
    transport.targetInfos = [
      { targetId: 'tab-leader', type: 'page', attached: false, url: APP_URL },
    ];
    const watcher = makeWatcher(ownTabOptions());
    await watcher.start();

    transport.simulateDrop();
    transport.simulateReconnect();
    await tick();
    await tick();
    transport.sentCommands.length = 0;

    transport.emit('Target.attachedToTarget', {
      sessionId: 'sess-leader-2',
      targetInfo: { targetId: 'tab-leader', type: 'page', url: APP_URL },
    });
    await tick();

    expect(methodsFor('sess-leader-2')).not.toContain('Network.enable');
  });
});
