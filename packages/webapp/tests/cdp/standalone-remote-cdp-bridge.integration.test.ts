import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPanelRpcTrayProvider } from '../../src/cdp/panel-rpc-tray-provider.js';
import { type RemoteCDPSender, RemoteCDPTransport } from '../../src/cdp/remote-cdp-transport.js';
import {
  createPanelRpcClient,
  installPanelRpcHandler,
  type PanelRpcClient,
  type PanelRpcPushMsg,
  panelRpcChannelName,
} from '../../src/kernel/panel-rpc.js';
import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';
import {
  createRemoteCdpPageBridge,
  type RemoteCdpSyncProvider,
} from '../../src/ui/remote-cdp-page-bridge.js';

/**
 * In-memory BroadcastChannel polyfill (same shape as the one in
 * tests/kernel/panel-rpc.test.ts): async delivery via queueMicrotask,
 * never delivers to the posting instance.
 */
class FakeChannel {
  private static buses = new Map<string, Set<FakeChannel>>();
  private listeners = new Set<(ev: MessageEvent) => void>();
  private closed = false;
  constructor(public readonly name: string) {
    let bus = FakeChannel.buses.get(name);
    if (!bus) {
      bus = new Set();
      FakeChannel.buses.set(name, bus);
    }
    bus.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const bus = FakeChannel.buses.get(this.name);
    if (!bus) return;
    // Mirror real BroadcastChannel semantics: messages cross the channel
    // by structured clone, not by reference. Cloning here is what makes
    // the large-ArrayBuffer screenshot test a genuine clone-survival
    // check rather than a pass-by-reference no-op.
    const cloned = structuredClone(data);
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data: cloned }));
      });
    }
  }
  addEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'message', l: (ev: MessageEvent) => void): void {
    this.listeners.delete(l);
  }
  close(): void {
    this.closed = true;
    FakeChannel.buses.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

let saved: typeof BroadcastChannel | undefined;
beforeEach(() => {
  saved = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
    FakeChannel as unknown as typeof BroadcastChannel;
});
afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = saved;
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = undefined;
});

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Captures CDP requests and resolves them from a shared canned-response map. */
class FakeSender implements RemoteCDPSender {
  transport!: RemoteCDPTransport;
  constructor(private readonly responses: Record<string, Record<string, unknown>>) {}
  sendCDPRequest(
    requestId: string,
    method: string,
    _params?: Record<string, unknown>,
    _sessionId?: string
  ): void {
    // Resolve synchronously, as the real sync manager would on a fast
    // local round-trip. Unknown methods resolve with {}.
    this.transport.handleResponse(requestId, this.responses[method] ?? {});
  }
}

/**
 * Build the full standalone wiring over a single instance-scoped channel
 * name: worker client + provider, page handlers + bridge + pusher, and a
 * fake leader sync that hands out real RemoteCDPTransports driven by a
 * fake sender. The shared `responses` map is consulted by every sender,
 * so seeding it before a send makes even the first send deterministic.
 * Returns the provider + per-target transports (for firing events) + a
 * teardown.
 */
function wire(instanceId: string, responses: Record<string, Record<string, unknown>>) {
  // ── Page side ──
  const transports = new Map<string, RemoteCDPTransport>();
  const fakeSync: RemoteCdpSyncProvider = {
    createRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      let t = transports.get(key);
      if (!t) {
        const sender = new FakeSender(responses);
        t = new RemoteCDPTransport(sender);
        sender.transport = t;
        transports.set(key, t);
      }
      return t;
    },
    removeRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      transports.get(key)?.disconnect();
      transports.delete(key);
    },
    async openRemoteTab(runtimeId) {
      return `${runtimeId}:new-tab`;
    },
  };

  const pushChannel = new BroadcastChannel(panelRpcChannelName(instanceId));
  const bridge = createRemoteCdpPageBridge({
    getSync: () => fakeSync,
    postEvent: (payload) => {
      const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
      pushChannel.postMessage(msg);
    },
  });
  const stopHandler = installPanelRpcHandler({
    instanceId,
    handlers: createStandalonePanelRpcHandlers({ remoteCdp: bridge }),
  });

  // ── Worker side ──
  const client: PanelRpcClient = createPanelRpcClient({ instanceId });
  (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = client;
  const provider = createPanelRpcTrayProvider(() => client);

  return {
    provider,
    transports,
    teardown: () => {
      client.dispose();
      stopHandler();
      pushChannel.close();
    },
  };
}

describe('standalone remote-CDP bridge (integration)', () => {
  it('round-trips attach + a realistic-size binary screenshot through the bridge', async () => {
    // ~2MB ArrayBuffer, matching the real `screencapture` result shape
    // (`bytes: ArrayBuffer`). The FakeChannel structured-clones every
    // message, so this exercises genuine clone-survival of a large binary
    // payload across the bridge — not a pass-by-reference no-op.
    const bytes = new Uint8Array(2_000_000);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251; // sparse marker bytes
    const responses = {
      'Target.attachToTarget': { sessionId: 'sess-1' },
      'Page.enable': {},
      'Page.captureScreenshot': { bytes: bytes.buffer, width: 1280, height: 720 },
    };
    const { provider, teardown } = wire('itest-screenshot', responses);
    // BrowserAPI would do: createRemoteTransport → Target.attachToTarget →
    // Page.enable → Page.captureScreenshot. Drive the transport directly.
    const transport = provider.createRemoteTransport!('follower-1', 'cherry-target');

    const attach = await transport.send('Target.attachToTarget', { targetId: 'cherry-target' });
    expect(attach).toEqual({ sessionId: 'sess-1' });
    await transport.send('Page.enable', {}, 'sess-1');
    const shot = await transport.send('Page.captureScreenshot', { format: 'png' }, 'sess-1');
    const buf = shot.bytes as ArrayBuffer;
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(buf.byteLength).toBe(2_000_000);
    // The clone is a copy, not the same buffer reference.
    expect(buf).not.toBe(bytes.buffer);
    // Marker bytes survived the structured-clone round-trip intact.
    const view = new Uint8Array(buf);
    expect(view[0]).toBe(0);
    expect(view[4096]).toBe(4096 % 251);

    teardown();
  });

  it("navigate's once('Page.loadEventFired') resolves from a pushed event", async () => {
    const responses = { 'Page.navigate': { frameId: 'f1' } };
    const { provider, transports, teardown } = wire('itest-navigate', responses);
    const transport = provider.createRemoteTransport!('follower-1', 'cherry-target');

    // Subscribe for the load event first (BrowserAPI.navigate uses once()
    // before issuing the navigate), then drive the navigate.
    const loadPromise = transport.once('Page.loadEventFired');
    const nav = await transport.send('Page.navigate', { url: 'https://x.test' }, 'sess-1');
    expect(nav).toEqual({ frameId: 'f1' });

    // Allow the subscribe round-trip to wire the page-side forwarder.
    await tick();
    await tick();

    // Follower fires the event → page RemoteCDPTransport.handleEvent →
    // forwarder posts remote-cdp-event push → worker transport resolves once().
    transports.get('follower-1:cherry-target')!.handleEvent('Page.loadEventFired', {
      timestamp: 123,
    });

    await expect(loadPromise).resolves.toEqual({ timestamp: 123 });
    teardown();
  });
});
