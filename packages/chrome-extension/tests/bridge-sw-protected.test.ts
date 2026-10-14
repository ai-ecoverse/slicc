/**
 * Tests for B24-1 / B24-2: CDP bridge protected origin guards.
 *
 * Verifies that the bridge refuses to attach, create, or navigate to protected
 * origins, and detaches when a tab navigates to one.
 */
import { EXTENSION_BRIDGE_PORT_NAME, EXTENSION_BRIDGE_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearWelcomedLeaderPortsForTest,
  type BridgeSwDeps,
  checkBridgeTabProtection,
  handleBridgePortConnect,
} from '../src/bridge-sw.js';

// ---------------------------------------------------------------------------
// Helpers — mirrors of bridge-sw.test.ts's fake infrastructure, scoped to
// the protected-origin scenarios.
// ---------------------------------------------------------------------------

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

/** A tab registry for the test, keyed by tab id. */
const testTabs = new Map<number, { id: number; url: string; title: string; windowId: number }>();

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

/** Connect a port, complete the handshake, and return it ready for CDP. */
async function connectAndHandshake(deps: BridgeSwDeps): Promise<FakePort> {
  const port = makePort(EXTENSION_BRIDGE_PORT_NAME, leaderSender());
  await handleBridgePortConnect(port as unknown as ChromeRuntimePort, deps);
  port.receive(makeHello('ch-1'));
  // Wait for handshake processing.
  await new Promise((r) => setTimeout(r, 10));
  // Clear welcome message.
  port.posted.length = 0;
  return port;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

    // First attach to a normal tab.
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    // Now try to navigate it to a protected URL.
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
    testTabs.clear();
  });

  it('emits Target.detachedFromTarget when a tab navigates to a protected URL', async () => {
    testTabs.set(100, { id: 100, url: 'https://example.com/', title: 'Normal', windowId: 1 });
    const deps = makeDeps();
    const port = await connectAndHandshake(deps);

    // Attach to the normal tab.
    port.receive(makeCdpRequest('ch-1', 1, 'Target.attachToTarget', { targetId: '100' }));
    await new Promise((r) => setTimeout(r, 20));
    port.posted.length = 0;

    // Simulate the tab navigating to a protected URL.
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
