import { describe, it, expect, vi } from 'vitest';
import {
  PanelLeaderSyncProxy,
  connectOffscreenLeaderSyncBridge,
  type OffscreenMessageHub,
  type ActiveScoopSink,
} from '../src/leader-sync-bridge.js';
import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';

function createBus() {
  type Envelope = { source: string; payload: unknown };
  const panelListeners = new Set<(e: Envelope) => void>();
  const offscreenListeners = new Set<(e: Envelope) => void>();
  return {
    panelSender: {
      send(envelope: Envelope): void {
        for (const l of offscreenListeners) l(envelope);
      },
    },
    panelSubscriber: {
      onMessage(handler: (e: Envelope) => void): () => void {
        panelListeners.add(handler);
        return () => panelListeners.delete(handler);
      },
    },
    offscreenHub: {
      sendToPanel(envelope: Envelope): void {
        for (const l of panelListeners) l(envelope);
      },
      onPanelMessage(handler: (e: Envelope) => void): () => void {
        offscreenListeners.add(handler);
        return () => offscreenListeners.delete(handler);
      },
    } satisfies OffscreenMessageHub,
  };
}

function makeMockSync() {
  return {
    broadcastSprinkleUpdate: vi.fn(),
    broadcastUserMessage: vi.fn(),
  } as unknown as LeaderSyncManager & {
    broadcastSprinkleUpdate: ReturnType<typeof vi.fn>;
    broadcastUserMessage: ReturnType<typeof vi.fn>;
  };
}

function makeMockBridge() {
  return {
    setActiveScoopJid: vi.fn(),
  } satisfies ActiveScoopSink;
}

describe('PanelLeaderSyncProxy → offscreen adapter', () => {
  it('sprinkles snapshot is cached and retrievable via getSprinkles', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinklesSnapshot([
      { name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false },
    ]);
    expect(adapter.getSprinkles()).toHaveLength(1);
    expect(adapter.resolveSprinklePath('welcome')).toBe('/w.shtml');
    expect(adapter.resolveSprinklePath('nope')).toBeNull();
  });

  it('sprinkle update fans to broadcastSprinkleUpdate', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinkleUpdate('welcome', { x: 1 });
    expect(sync.broadcastSprinkleUpdate).toHaveBeenCalledWith('welcome', { x: 1 });
  });

  it('user message echo fans to broadcastUserMessage', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushUserMessageEcho('hi', 'm1', [{ name: 'a.png' }] as any);
    expect(sync.broadcastUserMessage).toHaveBeenCalledWith('hi', 'm1', [{ name: 'a.png' }]);
  });

  it('active-scoop write-through to bridge.setActiveScoopJid', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushActiveScoop('scoop-7');
    expect(bridge.setActiveScoopJid).toHaveBeenCalledWith('scoop-7');
  });

  it('detach() removes the hub listener — subsequent envelopes are no-ops', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    adapter.detach();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinkleUpdate('welcome', { x: 1 });
    expect(sync.broadcastSprinkleUpdate).not.toHaveBeenCalled();
  });

  it('syncRef returning null is tolerated (no throws)', () => {
    const bus = createBus();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => null, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    expect(() => proxy.pushSprinkleUpdate('welcome', null)).not.toThrow();
  });

  it('snapshot pushed before signalLeaderMode(true) is preserved', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    // Snapshot delivered BEFORE leader-mode activation.
    proxy.pushSprinklesSnapshot([
      { name: 'early', title: 'E', path: '/early.shtml', open: false, autoOpen: false },
    ]);
    // Then activate.
    adapter.signalLeaderMode(true);
    // Cache should still hold the pre-activation snapshot.
    expect(adapter.getSprinkles()).toHaveLength(1);
    expect(adapter.resolveSprinklePath('early')).toBe('/early.shtml');
  });
});

describe('PanelLeaderSyncProxy.resetTray', () => {
  it('sends leader-tray-reset and resolves on matching response', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    bus.offscreenHub.onPanelMessage((env) => {
      const msg = env.payload as any;
      if (msg?.type !== 'leader-tray-reset') return;
      bus.offscreenHub.sendToPanel({
        source: 'offscreen',
        payload: {
          type: 'leader-tray-reset-response',
          requestId: msg.requestId,
          ok: true,
          status: { state: 'connected', session: null, error: null, reconnectAttempts: 0 } as any,
        },
      });
    });
    const status = await proxy.resetTray(1000);
    expect(status.state).toBe('connected');
  });

  it('rejects on ok: false with the error', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    bus.offscreenHub.onPanelMessage((env) => {
      const msg = env.payload as any;
      if (msg?.type !== 'leader-tray-reset') return;
      bus.offscreenHub.sendToPanel({
        source: 'offscreen',
        payload: {
          type: 'leader-tray-reset-response',
          requestId: msg.requestId,
          ok: false,
          error: 'no active session',
        },
      });
    });
    await expect(proxy.resetTray(1000)).rejects.toThrow(/no active session/);
  });

  it('rejects on timeout', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    // No offscreen handler — request hangs.
    await expect(proxy.resetTray(50)).rejects.toThrow(/timed out/i);
  });

  it('two concurrent resets resolve independently by requestId', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    const seen: string[] = [];
    bus.offscreenHub.onPanelMessage((env) => {
      const msg = env.payload as any;
      if (msg?.type !== 'leader-tray-reset') return;
      seen.push(msg.requestId);
      if (seen.length === 2) {
        // Reply to the second request first (verify out-of-order works).
        bus.offscreenHub.sendToPanel({
          source: 'offscreen',
          payload: {
            type: 'leader-tray-reset-response',
            requestId: seen[1],
            ok: true,
            status: { state: 'second', session: null, error: null, reconnectAttempts: 0 } as any,
          },
        });
        bus.offscreenHub.sendToPanel({
          source: 'offscreen',
          payload: {
            type: 'leader-tray-reset-response',
            requestId: seen[0],
            ok: true,
            status: { state: 'first', session: null, error: null, reconnectAttempts: 0 } as any,
          },
        });
      }
    });
    const [a, b] = await Promise.all([proxy.resetTray(1000), proxy.resetTray(1000)]);
    expect(a.state).toBe('first');
    expect(b.state).toBe('second');
  });

  it('dispose() rejects pending resetTray promises with "disposed"', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    // No offscreen handler — the request hangs until dispose.
    const pending = proxy.resetTray(60_000);
    // Microtask so the proxy's resetTray has time to mint a request and register the waiter.
    await Promise.resolve();
    proxy.dispose();
    await expect(pending).rejects.toThrow(/disposed/i);
  });

  it('dispose() clears the pending timeout so dispose itself does not hang or leak', async () => {
    vi.useFakeTimers();
    try {
      const bus = createBus();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      // No offscreen handler.
      const pending = proxy.resetTray(60_000);
      // Catch the rejection up front so we can advance timers safely.
      const caught = pending.catch((err: unknown) => err);
      await Promise.resolve();
      proxy.dispose();
      // If dispose didn't clear the timer, advancing past 60s would re-fire the
      // timeout reject and produce an unhandled rejection in Node.
      vi.advanceTimersByTime(60_001);
      const err = await caught;
      expect((err as Error).message).toMatch(/disposed/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PanelLeaderSyncProxy post-dispose behavior', () => {
  it('push methods become no-ops after dispose()', () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.dispose();
    // Capture any outgoing envelope (via the bus's panel→offscreen path).
    const sent: Array<{ source: string; payload: unknown }> = [];
    bus.offscreenHub.onPanelMessage((env) => sent.push(env));
    proxy.pushSprinklesSnapshot([]);
    proxy.pushSprinkleUpdate('x', null);
    proxy.pushUserMessageEcho('hi', 'm1');
    proxy.pushActiveScoop('cone-1');
    proxy.requestModeState();
    expect(sent).toEqual([]);
  });

  it('resetTray() rejects synchronously when called after dispose', async () => {
    const bus = createBus();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.dispose();
    await expect(proxy.resetTray(1000)).rejects.toThrow(/disposed/i);
  });
});
