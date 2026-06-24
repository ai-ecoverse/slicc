import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
} from '../../src/cdp/extension-bridge-protocol.js';
import {
  type ExtensionBridgePort,
  ExtensionBridgeTransport,
} from '../../src/cdp/extension-bridge-transport.js';

interface FakePort extends ExtensionBridgePort {
  posted: unknown[];
  receive: (msg: unknown) => void;
  disconnected: boolean;
  triggerDisconnect: () => void;
}

function makeFakePort(): FakePort {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
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

function lastChannelId(port: FakePort): string {
  const hello = port.posted.find(
    (m): m is { channelId: string } =>
      typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'handshake.hello'
  );
  if (!hello) throw new Error('no hello posted');
  return hello.channelId;
}

describe('ExtensionBridgeTransport', () => {
  let port: FakePort;
  let ports: FakePort[];
  let transport: ExtensionBridgeTransport;
  let connectCalls: Array<{ extensionId: string; info: { name: string } }>;

  beforeEach(() => {
    port = makeFakePort();
    ports = [port];
    connectCalls = [];
    transport = new ExtensionBridgeTransport({
      extensionId: 'fake-ext-id',
      // Returns the CURRENT module port. Reconnect tests call `nextPort()`
      // before re-dialing so successive connect() calls get fresh ports.
      connect: (extensionId, info) => {
        connectCalls.push({ extensionId, info });
        return port;
      },
    });
  });

  it('advertises isExtensionBridge so the kernel host skips the NavigationWatcher', () => {
    // The bridge can't service the watcher's sessionless
    // `Target.setDiscoverTargets`; `host.ts` reads this flag to skip it.
    expect(transport.isExtensionBridge).toBe(true);
  });

  // Swap in a fresh port for the next connect() and return it.
  function nextPort(): FakePort {
    port = makeFakePort();
    ports.push(port);
    return port;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the port with the bridge name and posts handshake.hello', async () => {
    const p = transport.connect();
    // Connect kicks off synchronously; let the handshake send happen.
    await Promise.resolve();
    expect(connectCalls).toEqual([
      { extensionId: 'fake-ext-id', info: { name: EXTENSION_BRIDGE_PORT_NAME } },
    ]);
    const hello = port.posted[0] as { bridge: number; kind: string; channelId: string };
    expect(hello.kind).toBe('handshake.hello');
    expect(hello.bridge).toBe(EXTENSION_BRIDGE_PROTOCOL_VERSION);
    expect(hello.channelId).toMatch(/^bridge-/);

    // Resolve the handshake so the promise doesn't dangle.
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
    });
    await p;
    expect(transport.state).toBe('connected');
  });

  it('rejects connect() on handshake.rejected', async () => {
    const p = transport.connect();
    await Promise.resolve();
    const channelId = lastChannelId(port);
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId,
      kind: 'handshake.rejected',
      reason: 'leader-tab-not-pinned',
    });
    await expect(p).rejects.toThrow(/leader-tab-not-pinned/);
    expect(transport.state).toBe('disconnected');
  });

  it('rejects connect() if the port disconnects before welcome', async () => {
    const p = transport.connect();
    await Promise.resolve();
    port.triggerDisconnect();
    await expect(p).rejects.toThrow(/disconnected before welcome/);
  });

  it('rejects connect() on handshake timeout', async () => {
    vi.useFakeTimers();
    const p = transport.connect({ timeout: 50 });
    await Promise.resolve();
    vi.advanceTimersByTime(60);
    await expect(p).rejects.toThrow(/handshake timed out/);
    expect(port.disconnected).toBe(true);
  });

  it('round-trips a CDP command and resolves on cdp.response', async () => {
    const channelId = await connect(transport, port);
    const promise = transport.send('Page.navigate', { url: 'https://example.com' }, 'sess-1');
    await Promise.resolve();
    const req = port.posted.find((m) => (m as { kind?: string }).kind === 'cdp.request') as {
      id: number;
      method: string;
      params: Record<string, unknown>;
      sessionId: string;
    };
    expect(req.method).toBe('Page.navigate');
    expect(req.params).toEqual({ url: 'https://example.com' });
    expect(req.sessionId).toBe('sess-1');
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { frameId: 'F1' },
    });
    await expect(promise).resolves.toEqual({ frameId: 'F1' });
  });

  it('rejects a CDP command on cdp.response.error', async () => {
    const channelId = await connect(transport, port);
    const promise = transport.send('Runtime.evaluate', { expression: 'boom' }, 'sess-1');
    await Promise.resolve();
    const req = port.posted.find((m) => (m as { kind?: string }).kind === 'cdp.request') as {
      id: number;
    };
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      error: 'sandbox forbidden',
    });
    await expect(promise).rejects.toThrow(/sandbox forbidden/);
  });

  it('routes cdp.event envelopes to subscribed listeners with sessionId', async () => {
    const channelId = await connect(transport, port);
    const received: Array<Record<string, unknown>> = [];
    transport.on('Page.loadEventFired', (params) => received.push(params));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.event',
      method: 'Page.loadEventFired',
      params: { timestamp: 123 },
      sessionId: 'sess-9',
    });
    expect(received).toEqual([{ timestamp: 123, sessionId: 'sess-9' }]);
  });

  it('ignores envelopes whose channelId does not match', async () => {
    await connect(transport, port);
    const received: Array<Record<string, unknown>> = [];
    transport.on('Page.loadEventFired', (p) => received.push(p));
    port.receive({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'other-bridge',
      kind: 'cdp.event',
      method: 'Page.loadEventFired',
      params: { stray: true },
    });
    expect(received).toEqual([]);
  });

  it('ignores non-bridge envelopes (e.g. cherry leakage)', async () => {
    await connect(transport, port);
    const received: Array<Record<string, unknown>> = [];
    transport.on('Page.loadEventFired', (p) => received.push(p));
    port.receive({ cherry: 1, channelId: 'x', kind: 'cdp.event', method: 'Page.loadEventFired' });
    expect(received).toEqual([]);
  });

  it('disconnect() tears down the port and the bridge state', async () => {
    await connect(transport, port);
    transport.disconnect();
    expect(port.disconnected).toBe(true);
    expect(transport.state).toBe('disconnected');
  });

  it('resets state to disconnected on a post-welcome port drop', async () => {
    await connect(transport, port);
    expect(transport.state).toBe('connected');
    port.triggerDisconnect();
    expect(transport.state).toBe('disconnected');
  });

  it('rejects in-flight commands on a post-welcome port drop', async () => {
    await connect(transport, port);
    const promise = transport.send('Page.enable');
    await Promise.resolve();
    port.triggerDisconnect();
    await expect(promise).rejects.toThrow(/ExtensionBridgeTransport disconnected/);
  });

  it('reconnects after a drop with a fresh port and a new handshake', async () => {
    await connect(transport, port);
    const firstPort = ports[0];
    firstPort.triggerDisconnect();
    expect(transport.state).toBe('disconnected');

    nextPort();
    await connect(transport, port);
    expect(transport.state).toBe('connected');
    expect(ports).toHaveLength(2);
    const freshPort = ports[1];
    expect(freshPort).not.toBe(firstPort);
    expect(freshPort.posted.some((m) => (m as { kind?: string }).kind === 'handshake.hello')).toBe(
      true
    );
  });

  it('allows a reconnect after an intentional disconnect', async () => {
    await connect(transport, port);
    transport.disconnect();
    expect(transport.state).toBe('disconnected');
    nextPort();
    await connect(transport, port);
    expect(transport.state).toBe('connected');
  });

  it('ignores a stale disconnect from an old port after reconnect', async () => {
    await connect(transport, port);
    const oldPort = ports[0];
    oldPort.triggerDisconnect();
    expect(transport.state).toBe('disconnected');
    nextPort();
    await connect(transport, port);
    expect(transport.state).toBe('connected');
    oldPort.triggerDisconnect();
    expect(transport.state).toBe('connected');
  });
});

async function connect(t: ExtensionBridgeTransport, port: FakePort): Promise<string> {
  const p = t.connect();
  await Promise.resolve();
  const channelId = lastChannelId(port);
  port.receive({
    bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    channelId,
    kind: 'handshake.welcome',
  });
  await p;
  return channelId;
}
