import { EXTENSION_BRIDGE_PORT_NAME, EXTENSION_BRIDGE_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearTabShieldsForTest,
  __clearWelcomedLeaderPortsForTest,
  type BridgeSwDeps,
  checkBridgeTabProtection,
  handleBridgePortConnect,
} from '../src/bridge-sw.js';

interface FakeSender {
  origin?: string;
  tab?: { id?: number; url?: string };
  frameId?: number;
  url?: string;
}

interface FakePort {
  name: string;
  sender?: FakeSender;
  posted: unknown[];
  disconnected: boolean;
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  receive: (msg: unknown) => void;
  triggerDisconnect: () => void;
}

function makePort(name: string, sender?: FakeSender): FakePort {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name,
    sender,
    posted: [],
    disconnected: false,
    postMessage: (msg) => port.posted.push(msg),
    disconnect: () => {
      port.disconnected = true;
    },
    onMessage: { addListener: (cb) => messageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => disconnectListeners.push(cb) },
    receive: (msg) => {
      for (const cb of messageListeners) cb(msg);
    },
    triggerDisconnect: () => {
      for (const cb of disconnectListeners) cb();
    },
  };
  return port;
}

const ORIGIN = 'https://www.sliccy.ai';

const testTabs = new Map<
  number,
  {
    id: number;
    url: string;
    title: string;
    windowId: number;
    openerTabId?: number;
    pendingUrl?: string;
  }
>();

function makeDeps(overrides: Partial<BridgeSwDeps> = {}): BridgeSwDeps {
  const base: BridgeSwDeps = {
    readStoredLeaderTabId: async () => 42,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: vi.fn(async () => true),
    detachDebugger: vi.fn(async () => undefined),
    sendDebuggerCommand: vi.fn(async () => ({ ok: true })),
    subscribeDebuggerEvents: () => () => {},
    queryTabs: async () => [...testTabs.values()],
    queryActiveTabId: async () => undefined,
    getTab: async (tabId) => testTabs.get(tabId) ?? undefined,
    createTab: async () => 99,
    createWindow: vi.fn(async () => ({
      windowId: 7,
      tabId: 88,
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      state: 'normal',
    })),
    getWindow: vi.fn(async () => ({
      windowId: 7,
      tabId: 88,
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      state: 'normal',
    })),
    updateWindow: vi.fn(async () => ({
      windowId: 7,
      tabId: 88,
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      state: 'normal',
    })),
    removeTab: vi.fn(async () => undefined),
    activateTab: vi.fn(async () => undefined),
    allowedOrigins: [ORIGIN],
  };
  return { ...base, ...overrides };
}

function leaderSender(): FakeSender {
  return {
    origin: ORIGIN,
    tab: { id: 42, url: `${ORIGIN}/?slicc=leader` },
    frameId: 0,
    url: `${ORIGIN}/?slicc=leader`,
  };
}

function makeHello(channelId: string) {
  return {
    bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    channelId,
    kind: 'handshake.hello',
  };
}

function makeCdpRequest(
  channelId: string,
  id: number,
  method: string,
  params?: unknown,
  sessionId?: string
) {
  return {
    bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    channelId,
    kind: 'cdp.request',
    id,
    method,
    params,
    sessionId,
  };
}

async function connectAndHandshake(deps: BridgeSwDeps): Promise<FakePort> {
  const port = makePort(EXTENSION_BRIDGE_PORT_NAME, leaderSender());
  await handleBridgePortConnect(port as unknown as ChromeRuntimePort, deps);
  port.receive(makeHello('ch-1'));

  await new Promise((r) => setTimeout(r, 10));

  port.posted.length = 0;
  return port;
}

describe('B24-1: bridge CDP protected origin guards', () => {
  beforeEach(() => {
    testTabs.clear();
    testTabs.set(42, { id: 42, url: `${ORIGIN}/?slicc=leader`, title: 'Leader', windowId: 1 });
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'Normal', windowId: 1 });
    testTabs.set(101, {
      id: 101,
      url: 'https://vault.sliccy.ai/',
      title: 'Vault',
      windowId: 1,
    });
    testTabs.set(102, {
      id: 102,
      url: 'blob:https://vault.sliccy.ai/0b9e0f6c',
      title: 'Blob Vault',
      windowId: 1,
    });
  });

  afterEach(() => {
    __clearWelcomedLeaderPortsForTest();
    __clearTabShieldsForTest();
    testTabs.clear();
  });

  it('refuses Target.attachToTarget for a tab on a protected origin', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '101' }));
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });

  it('refuses Target.attachToTarget for a blob: URL wrapping a protected origin (B24-2)', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '102' }));
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });

  it('allows Target.attachToTarget for a non-protected tab', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ sessionId: '100' });
  });

  it('attaches to a blank tab with no opener or a plain opener, but not one opened by the vault', async () => {
    testTabs.set(110, { id: 110, url: 'about:blank', title: '', windowId: 1 });
    testTabs.set(111, { id: 111, url: 'about:blank', title: '', windowId: 1, openerTabId: 100 });
    testTabs.set(112, { id: 112, url: 'about:blank', title: '', windowId: 1, openerTabId: 101 });
    testTabs.set(113, { id: 113, url: 'about:blank', title: '', windowId: 1, openerTabId: 999 });
    testTabs.set(114, {
      id: 114,
      url: 'https://example.com/',
      title: '',
      windowId: 1,
      pendingUrl: 'https://vault.sliccy.ai/',
    });
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);
    const attach = async (id: number, tab: number) => {
      port.receive(makeCdpRequest('ch-1', id, 'Target.attachToTarget', { targetId: String(tab) }));
      await new Promise((r) => setTimeout(r, 20));
      return port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === id) as any;
    };

    expect((await attach(1, 110)).result).toEqual({ sessionId: '110' });
    expect((await attach(2, 111)).result).toEqual({ sessionId: '111' });

    expect((await attach(3, 112)).error).toMatch(/refused/i);
    expect((await attach(4, 113)).error).toMatch(/refused/i);
    expect((await attach(5, 114)).error).toMatch(/refused/i);
  });

  it('refuses Target.createTarget with a protected URL', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(
      makeCdpRequest('ch-1', 1, 'Target.createTarget', { url: 'https://vault.sliccy.ai/' })
    );
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });

  it('refuses Target.createTarget with a view-source: wrapped protected URL (B24-2)', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(
      makeCdpRequest('ch-1', 1, 'Target.createTarget', {
        url: 'view-source:https://vault.sliccy.ai/',
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });

  it('allows Target.createTarget with about:blank (no opener)', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.createTarget', { url: 'about:blank' }));
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 1) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toBeUndefined();
  });

  it('refuses Page.navigate to a protected URL', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    port.receive(
      makeCdpRequest('ch-1', 2, 'Page.navigate', { url: 'https://vault.sliccy.ai/' }, '100')
    );
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 2) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });

  it('refuses Page.navigate to a filesystem: wrapped protected URL (B24-2)', async () => {
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    port.receive(
      makeCdpRequest(
        'ch-1',
        2,
        'Page.navigate',
        { url: 'filesystem:https://vault.sliccy.ai/temporary/notes.txt' },
        '100'
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    const resp = port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === 2) as any;
    expect(resp).toBeDefined();
    expect(resp.error).toMatch(/refused/i);
  });
});

describe('B24-1: checkBridgeTabProtection detaches on navigation to protected origin', () => {
  afterEach(() => {
    __clearWelcomedLeaderPortsForTest();
    __clearTabShieldsForTest();
    testTabs.clear();
  });

  it('emits Target.detachedFromTarget when a tab navigates to a protected URL', async () => {
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'Normal', windowId: 1 });
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    const detached = checkBridgeTabProtection(100, 'https://vault.sliccy.ai/');
    expect(detached.has(100)).toBe(true);

    const detachEvent = port.posted.find(
      (m: any) => m.kind === 'cdp.event' && m.method === 'Target.detachedFromTarget'
    ) as any;
    expect(detachEvent).toBeDefined();
    expect(detachEvent.params.sessionId).toBe('100');
  });

  it('does nothing when a tab navigates to a non-protected URL', async () => {
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'Normal', windowId: 1 });
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    const detached = checkBridgeTabProtection(100, 'https://example.org/');
    expect(detached.size).toBe(0);
    expect(port.posted).toHaveLength(0);
  });
});

describe('B24-4: bridge wiring of the CDP shield', () => {
  type EventHandler = (tabId: number, method: string, params?: Record<string, unknown>) => void;
  let handlers: EventHandler[];
  let sent: Array<[number, string, unknown]>;

  beforeEach(() => {
    handlers = [];
    sent = [];
    testTabs.clear();
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'Normal', windowId: 1 });
    testTabs.set(101, {
      id: 101,
      url: 'https://vault.sliccy.ai/k?x=1',
      title: 'Vault secret',
      windowId: 1,
    });
  });

  afterEach(() => {
    __clearWelcomedLeaderPortsForTest();
    __clearTabShieldsForTest();
    testTabs.clear();
  });

  function shieldDeps(overrides: Partial<BridgeSwDeps> = {}): BridgeSwDeps {
    return makeDeps({
      sendDebuggerCommand: vi.fn(async (tabId: number, method: string, params?: unknown) => {
        sent.push([tabId, method, params]);
        return {};
      }),
      subscribeDebuggerEvents: (handler) => {
        handlers.push(handler as EventHandler);
        return () => {
          handlers = handlers.filter((h) => h !== handler);
        };
      },
      ...overrides,
    });
  }

  const emit = (tabId: number, method: string, params?: Record<string, unknown>) => {
    for (const h of [...handlers]) h(tabId, method, params);
  };
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const response = (port: FakePort, id: number) =>
    port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === id) as any;
  const forwarded = (port: FakePort, method: string) =>
    port.posted.filter((m: any) => m.kind === 'cdp.event' && m.method === method) as any[];

  async function attached(deps: BridgeSwDeps, id = 1): Promise<FakePort> {
    const port = await connectAndHandshake(deps);
    port.receive(makeCdpRequest('ch-1', id, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    expect(response(port, id).result).toEqual({ sessionId: '100' });
    return port;
  }

  it('arms the Fetch guard on attach, before the client gets a session', async () => {
    await attached(shieldDeps());
    expect(sent[0]).toEqual([
      100,
      'Fetch.enable',
      {
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        handleAuthRequests: false,
      },
    ]);
  });

  it('a second attach waits for arming, and both fail if arming fails', async () => {
    let fail: (e: Error) => void = () => {};
    const gate = new Promise<never>((_, rej) => {
      fail = rej;
    });
    gate.catch(() => {});
    const deps = shieldDeps({
      sendDebuggerCommand: vi.fn(async (_tab: number, method: string) => {
        if (method === 'Fetch.enable') return gate;
        return {};
      }),
    });
    const port = await connectAndHandshake(deps);
    const second = await connectAndHandshake(deps);
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    second.receive(makeCdpRequest('ch-1', 2, 'Target.attachToTarget', { targetId: '100' }));
    await tick();

    expect(response(port, 1)).toBeUndefined();
    expect(response(second, 2)).toBeUndefined();
    fail(new Error('Fetch domain unavailable'));
    await tick();
    expect(response(port, 1).error).toMatch(/could not be guarded/);
    expect(response(second, 2).error).toMatch(/could not be guarded/);
  });

  it('refuses the attach when the tab already holds a protected iframe (control: plain iframe)', async () => {
    const frameTree = (url: string) => ({
      frameTree: {
        frame: { id: 'T', url: 'https://example.com/' },
        childFrames: [{ frame: { id: 'K', url } }],
      },
    });
    let childUrl = 'https://example.org/embed';
    const deps = shieldDeps({
      sendDebuggerCommand: vi.fn(async (_tab: number, method: string) =>
        method === 'Page.getFrameTree' ? frameTree(childUrl) : {}
      ),
    });
    const port = await connectAndHandshake(deps);
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    expect(response(port, 1).result).toEqual({ sessionId: '100' });
    port.receive(makeCdpRequest('ch-1', 2, 'Target.detachFromTarget', { sessionId: '100' }));
    await tick();
    childUrl = 'https://vault.sliccy.ai/embed';
    port.receive(makeCdpRequest('ch-1', 3, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    expect(response(port, 3).error).toMatch(/refused/);
  });

  it('refuses the attach and detaches when the guard cannot be armed', async () => {
    const deps = shieldDeps({
      sendDebuggerCommand: vi.fn(async () => {
        throw new Error('Fetch domain unavailable');
      }),
    });
    const port = await connectAndHandshake(deps);
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    expect(response(port, 1).error).toMatch(/could not be guarded/);
    expect(deps.detachDebugger).toHaveBeenCalledWith(100);
  });

  it('fails a protected document pause once and forwards plain events to every port on the tab', async () => {
    const deps = shieldDeps();
    const port = await attached(deps);
    const second = await connectAndHandshake(deps);
    second.receive(makeCdpRequest('ch-1', 7, 'Target.attachToTarget', { targetId: '100' }));
    await tick();
    port.posted.length = 0;
    second.posted.length = 0;

    emit(100, 'Network.requestWillBeSent', {
      requestId: 'n1',
      request: { url: 'https://example.com/a' },
    });
    expect(forwarded(port, 'Network.requestWillBeSent')).toHaveLength(1);
    expect(forwarded(second, 'Network.requestWillBeSent')).toHaveLength(1);

    emit(100, 'Fetch.requestPaused', {
      requestId: 'p1',
      request: { url: 'https://vault.sliccy.ai/' },
      resourceType: 'Document',
    });
    await tick();
    expect(sent.filter(([, m]) => m === 'Fetch.failRequest')).toEqual([
      [100, 'Fetch.failRequest', { requestId: 'p1', errorReason: 'BlockedByClient' }],
    ]);
    expect(forwarded(port, 'Fetch.requestPaused')).toHaveLength(0);
    expect(forwarded(second, 'Fetch.requestPaused')).toHaveLength(0);
  });

  it('does not forward events from a tab no port attached (e.g. a popup)', async () => {
    const deps = shieldDeps();
    const port = await attached(deps);
    port.posted.length = 0;
    emit(100, 'Page.loadEventFired', { timestamp: 1 });
    expect(forwarded(port, 'Page.loadEventFired')).toHaveLength(1);
    emit(555, 'Page.loadEventFired', { timestamp: 2 });
    expect(forwarded(port, 'Page.loadEventFired')).toHaveLength(1);
    expect(deps.attachDebugger).toHaveBeenCalledTimes(1);
  });

  it('runs commands through the shield: plain ones pass, protected ones are refused', async () => {
    const port = await attached(shieldDeps());
    port.receive(makeCdpRequest('ch-1', 2, 'Runtime.evaluate', { expression: '1' }, '100'));
    port.receive(
      makeCdpRequest('ch-1', 3, 'Security.setIgnoreCertificateErrors', { ignore: true }, '100')
    );
    port.receive(
      makeCdpRequest(
        'ch-1',
        4,
        'Network.setCookie',
        { name: 'a', value: '1', url: 'https://vault.sliccy.ai/' },
        '100'
      )
    );
    await tick();
    expect(response(port, 2).error).toBeUndefined();
    expect(response(port, 3).error).toMatch(/refused/);
    expect(response(port, 4).error).toMatch(/cookie is on seven/);
    expect(sent.some(([, m]) => m === 'Security.setIgnoreCertificateErrors')).toBe(false);
  });

  it('cuts the tab when a protected document commits anyway', async () => {
    const deps = shieldDeps();
    const port = await attached(deps);
    port.posted.length = 0;
    emit(100, 'Page.frameNavigated', {
      frame: { id: 'F', url: 'https://example.com/b', securityOrigin: 'https://example.com' },
    });
    expect(deps.detachDebugger).not.toHaveBeenCalled();
    emit(100, 'Page.frameNavigated', {
      frame: {
        id: 'F',
        url: 'https://vault.sliccy.ai/',
        securityOrigin: 'https://vault.sliccy.ai',
      },
    });
    await tick();
    expect(deps.detachDebugger).toHaveBeenCalledWith(100);
    expect(forwarded(port, 'Target.detachedFromTarget')[0]?.params.sessionId).toBe('100');
    port.receive(makeCdpRequest('ch-1', 9, 'Runtime.evaluate', { expression: '1' }, '100'));
    await tick();
    expect(response(port, 9).error).toBeDefined();
  });

  it('keeps the session when the tab URL is a document the shield already failed', async () => {
    const port = await attached(shieldDeps());
    emit(100, 'Fetch.requestPaused', {
      requestId: 'p2',
      request: { url: 'https://vault.sliccy.ai/x' },
      resourceType: 'Document',
    });

    expect(checkBridgeTabProtection(100, 'https://vault.sliccy.ai/x').size).toBe(0);
    expect(checkBridgeTabProtection(100, 'https://seven.sliccy.ai/').has(100)).toBe(true);
    void port;
  });

  it('lists a protected tab by origin only', async () => {
    const port = await connectAndHandshake(shieldDeps());
    port.receive(makeCdpRequest('ch-1', 1, 'Target.getTargets', {}));
    await tick();
    const infos = response(port, 1).result.targetInfos as any[];
    expect(infos.find((t) => t.targetId === '100')).toMatchObject({
      url: 'https://example.com/',
      title: 'Normal',
    });
    expect(infos.find((t) => t.targetId === '101')).toMatchObject({
      url: 'https://vault.sliccy.ai',
      title: 'https://vault.sliccy.ai',
    });
  });

  it('disarms the guard on detach so a surviving debugger session is not left paused', async () => {
    const deps = shieldDeps({ attachDebugger: vi.fn(async () => false) });
    const port = await attached(deps);
    port.receive(makeCdpRequest('ch-1', 2, 'Target.detachFromTarget', { sessionId: '100' }));
    await tick();
    expect(sent.at(-1)).toEqual([100, 'Fetch.disable', undefined]);
    expect(deps.detachDebugger).not.toHaveBeenCalled();
  });

  it('disarms the guard of a shared tab when its port disconnects', async () => {
    const deps = shieldDeps({ attachDebugger: vi.fn(async () => false) });
    const port = await attached(deps);
    port.triggerDisconnect();
    await tick();
    expect(sent.at(-1)).toEqual([100, 'Fetch.disable', undefined]);
    expect(handlers).toHaveLength(0);
  });

  it('refuses a pass-through command on a tab whose shield is gone', async () => {
    const port = await attached(shieldDeps());
    __clearTabShieldsForTest();
    port.receive(makeCdpRequest('ch-1', 2, 'Runtime.evaluate', { expression: '1' }, '100'));
    await tick();
    expect(response(port, 2).error).toMatch(/not guarded/);
  });
});

describe('B24-4: tabs holding a protected out-of-process iframe', () => {
  afterEach(() => {
    __clearWelcomedLeaderPortsForTest();
    __clearTabShieldsForTest();
    testTabs.clear();
  });

  it('attaches a tab with no protected frame, refuses one the tracker marked, and disarms it', async () => {
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'a', windowId: 1 });
    testTabs.set(103, { id: 103, url: 'https://example.com/framer', title: 'b', windowId: 1 });
    const sent: Array<[number, string]> = [];
    const deps = makeDeps({
      tabHasProtectedFrame: async (tabId) => tabId === 103,
      sendDebuggerCommand: vi.fn(async (tabId: number, method: string) => {
        sent.push([tabId, method]);
        return {};
      }),
    });
    const port = await connectAndHandshake(deps);
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    port.receive(makeCdpRequest('ch-1', 2, 'Target.attachToTarget', { targetId: '103' }));
    await new Promise((r) => setTimeout(r, 30));
    const resp = (id: number) =>
      port.posted.find((m: any) => m.kind === 'cdp.response' && m.id === id) as any;
    expect(resp(1).result).toEqual({ sessionId: '100' });
    expect(resp(2).error).toMatch(/refused/);
    expect(deps.detachDebugger).toHaveBeenCalledWith(103);

    port.receive(makeCdpRequest('ch-1', 3, 'Runtime.evaluate', { expression: '1' }, '103'));
    await new Promise((r) => setTimeout(r, 20));
    expect(resp(3).error).toBeDefined();
    expect(sent.some(([tab, m]) => tab === 103 && m === 'Runtime.evaluate')).toBe(false);
  });
});
