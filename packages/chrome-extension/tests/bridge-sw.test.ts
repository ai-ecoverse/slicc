import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
} from '../../webapp/src/cdp/extension-bridge-protocol.js';
import {
  BRIDGE_ALLOWED_ORIGINS,
  type BridgeSwDeps,
  handleBridgePortConnect,
  validateBridgePin,
} from '../src/bridge-sw.js';

interface FakeSender {
  origin?: string;
  tab?: { id?: number };
  frameId?: number;
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

function makeDeps(overrides: Partial<BridgeSwDeps> = {}): BridgeSwDeps {
  const sent: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
  const debuggerEventCallbacks: Array<
    (tabId: number, method: string, params?: Record<string, unknown>) => void
  > = [];
  const base: BridgeSwDeps = {
    readStoredLeaderTabId: async () => 42,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: vi.fn(async () => undefined),
    detachDebugger: vi.fn(async () => undefined),
    sendDebuggerCommand: vi.fn(async (tabId, method, params) => {
      sent.push({ tabId, method, params });
      return { ok: true, tabId, method };
    }),
    subscribeDebuggerEvents: (handler) => {
      debuggerEventCallbacks.push(handler);
      return () => {
        const i = debuggerEventCallbacks.indexOf(handler);
        if (i >= 0) debuggerEventCallbacks.splice(i, 1);
      };
    },
    queryTabs: async () => [
      { id: 42, title: 'Leader', url: 'https://www.sliccy.ai/' },
      { id: 43, title: 'Other', url: 'https://example.com/' },
    ],
    getTab: async (tabId) => ({ id: tabId, title: 't', url: 'https://example.com' }),
    createTab: async () => 99,
    removeTab: async () => undefined,
  };
  const merged: BridgeSwDeps = { ...base, ...overrides };
  (merged as unknown as { __sent: typeof sent }).__sent = sent;
  (merged as unknown as { __debuggerEvents: typeof debuggerEventCallbacks }).__debuggerEvents =
    debuggerEventCallbacks;
  return merged;
}

const goodSender: FakeSender = {
  origin: 'https://www.sliccy.ai',
  tab: { id: 42 },
  frameId: 0,
};

describe('validateBridgePin', () => {
  it('passes for an origin in the allowlist on the stored leader tab top frame', async () => {
    const r = await validateBridgePin(goodSender as never, {
      readStoredLeaderTabId: async () => 42,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when the storage key is absent (fail closed)', async () => {
    const r = await validateBridgePin(goodSender as never, {
      readStoredLeaderTabId: async () => undefined,
    });
    expect(r).toEqual({ ok: false, reason: 'leader-tab-not-pinned' });
  });

  it('rejects when the sender tab id does not match the stored leader', async () => {
    const r = await validateBridgePin(goodSender as never, {
      readStoredLeaderTabId: async () => 99,
    });
    expect(r).toEqual({ ok: false, reason: 'sender-tab-not-leader' });
  });

  it('rejects non-top frames', async () => {
    const r = await validateBridgePin({ ...goodSender, frameId: 1 } as never, {
      readStoredLeaderTabId: async () => 42,
    });
    expect(r).toEqual({ ok: false, reason: 'not-top-frame' });
  });

  it('rejects origins outside the allowlist', async () => {
    const r = await validateBridgePin({ ...goodSender, origin: 'https://evil.example' } as never, {
      readStoredLeaderTabId: async () => 42,
    });
    expect(r).toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  it('rejects when sender.tab is missing', async () => {
    const r = await validateBridgePin({ origin: 'https://www.sliccy.ai', frameId: 0 } as never, {
      readStoredLeaderTabId: async () => 42,
    });
    expect(r).toEqual({ ok: false, reason: 'no-sender-tab' });
  });

  it('rejects when sender is undefined', async () => {
    const r = await validateBridgePin(undefined, { readStoredLeaderTabId: async () => 42 });
    expect(r).toEqual({ ok: false, reason: 'no-sender' });
  });

  it('honors a custom allowedOrigins override', async () => {
    const r = await validateBridgePin(
      { origin: 'http://localhost:8787', tab: { id: 42 }, frameId: 0 } as never,
      { readStoredLeaderTabId: async () => 42, allowedOrigins: ['http://localhost:8787'] }
    );
    expect(r.ok).toBe(true);
  });

  it('ships a sensible default origin allowlist', () => {
    expect(BRIDGE_ALLOWED_ORIGINS).toEqual(['https://www.sliccy.ai']);
  });
});

describe('handleBridgePortConnect — pin gating', () => {
  let port: FakePort;
  beforeEach(() => {
    port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
  });

  it('ignores ports whose name does not match (defense-in-depth)', async () => {
    const wrongName = makePort('not-the-bridge', goodSender);
    await handleBridgePortConnect(wrongName as never, makeDeps());
    expect(wrongName.posted).toEqual([]);
    expect(wrongName.disconnected).toBe(false);
  });

  it('rejects + disconnects when the pin fails', async () => {
    const deps = makeDeps({ readStoredLeaderTabId: async () => undefined });
    await handleBridgePortConnect(port as never, deps);
    expect(port.posted).toEqual([
      {
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'rejected',
        kind: 'handshake.rejected',
        reason: 'leader-tab-not-pinned',
      },
    ]);
    expect(port.disconnected).toBe(true);
  });

  it('welcomes a valid hello, pinning the channelId', async () => {
    await handleBridgePortConnect(port as never, makeDeps());
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'bridge-abc',
      kind: 'handshake.hello',
    });
    expect(port.posted).toEqual([
      {
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'bridge-abc',
        kind: 'handshake.welcome',
      },
    ]);
  });

  it('rejects a non-hello first message', async () => {
    await handleBridgePortConnect(port as never, makeDeps());
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'bridge-x',
      kind: 'cdp.request',
      id: 1,
      method: 'Page.enable',
    });
    expect(port.posted[0]).toMatchObject({
      kind: 'handshake.rejected',
      reason: 'expected-hello-first',
    });
    expect(port.disconnected).toBe(true);
  });
});

describe('handleBridgePortConnect — CDP pass-through', () => {
  it('attaches a tab on Target.attachToTarget and pipes commands through chrome.debugger', async () => {
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    const deps = makeDeps();
    await handleBridgePortConnect(port as never, deps);
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'bridge-abc',
      kind: 'handshake.hello',
    });

    // attachToTarget
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'bridge-abc',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '43' },
    });
    await flush();
    expect(deps.attachDebugger).toHaveBeenCalledWith(43);
    const attachResp = port.posted.find(
      (m) =>
        (m as { kind?: string; id?: number }).kind === 'cdp.response' &&
        (m as { id?: number }).id === 1
    );
    expect(attachResp).toMatchObject({ result: { sessionId: '43' } });

    // Page.navigate
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'bridge-abc',
      kind: 'cdp.request',
      id: 2,
      method: 'Page.navigate',
      params: { url: 'https://example.com/' },
      sessionId: '43',
    });
    await flush();
    expect(deps.sendDebuggerCommand).toHaveBeenCalledWith(43, 'Page.navigate', {
      url: 'https://example.com/',
    });
  });

  it('routes outbound CDP through maybeUnmaskCdpFrame (secrets stay SW-side)', async () => {
    const unmask = vi.fn(
      async (_tabId: number, _method: string, _params: Record<string, unknown> | undefined) => ({
        expression: 'secret-from-sw',
      })
    );
    const deps = makeDeps({ maybeUnmaskCdpFrame: unmask });
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'handshake.hello',
    });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '43' },
    });
    await flush();
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'SECRET_MASK_TOKEN' },
      sessionId: '43',
    });
    await flush();
    expect(unmask).toHaveBeenCalledWith(43, 'Runtime.evaluate', {
      expression: 'SECRET_MASK_TOKEN',
    });
    // The send to chrome.debugger received the UNMASKED params.
    expect(deps.sendDebuggerCommand).toHaveBeenCalledWith(43, 'Runtime.evaluate', {
      expression: 'secret-from-sw',
    });
  });

  it('forwards chrome.debugger events only for tabs attached on this port', async () => {
    const deps = makeDeps();
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '43' },
    });
    await flush();

    const eventCallbacks = (
      deps as unknown as {
        __debuggerEvents: Array<
          (tabId: number, method: string, params?: Record<string, unknown>) => void
        >;
      }
    ).__debuggerEvents;
    expect(eventCallbacks.length).toBe(1);

    // Event for the attached tab → forwarded.
    eventCallbacks[0](43, 'Page.loadEventFired', { timestamp: 123 });
    // Event for an unattached tab → dropped.
    eventCallbacks[0](999, 'Page.loadEventFired', { timestamp: 456 });

    const events = port.posted.filter((m) => (m as { kind?: string }).kind === 'cdp.event');
    expect(events).toEqual([
      {
        bridge: 1,
        channelId: 'c',
        kind: 'cdp.event',
        method: 'Page.loadEventFired',
        params: { timestamp: 123 },
        sessionId: '43',
      },
    ]);
  });

  it('returns cdp.response.error when the debugger throws', async () => {
    const deps = makeDeps({
      sendDebuggerCommand: vi.fn(async () => {
        throw new Error('debugger detached');
      }),
    });
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '43' },
    });
    await flush();
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 2,
      method: 'Page.navigate',
      params: { url: 'https://example.com/' },
      sessionId: '43',
    });
    await flush();
    const navResp = port.posted.find(
      (m) =>
        (m as { kind?: string; id?: number }).kind === 'cdp.response' &&
        (m as { id?: number }).id === 2
    );
    expect(navResp).toMatchObject({ error: 'debugger detached' });
  });

  it('throws-via-error when no sessionId is attached', async () => {
    const deps = makeDeps();
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com/' },
      sessionId: 'nope',
    });
    await flush();
    const resp = port.posted.find(
      (m) =>
        (m as { kind?: string; id?: number }).kind === 'cdp.response' &&
        (m as { id?: number }).id === 1
    );
    expect(resp).toMatchObject({ error: expect.stringContaining('No tab attached') });
  });

  it('detaches owned tabs and unsubscribes events on port disconnect', async () => {
    const deps = makeDeps();
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.attachToTarget',
      params: { targetId: '43' },
    });
    await flush();
    port.triggerDisconnect();
    await flush();
    expect(deps.detachDebugger).toHaveBeenCalledWith(43);
  });

  it('Target.getTargets returns a CDP-shaped target list', async () => {
    const deps = makeDeps();
    const port = makePort(EXTENSION_BRIDGE_PORT_NAME, goodSender);
    await handleBridgePortConnect(port as never, deps);
    port.receive({ bridge: 1, channelId: 'c', kind: 'handshake.hello' });
    port.receive({
      bridge: 1,
      channelId: 'c',
      kind: 'cdp.request',
      id: 1,
      method: 'Target.getTargets',
    });
    await flush();
    const resp = port.posted.find((m) => (m as { kind?: string }).kind === 'cdp.response') as {
      result: { targetInfos: Array<{ targetId: string }> };
    };
    expect(resp.result.targetInfos.map((t) => t.targetId).sort()).toEqual(['42', '43']);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
