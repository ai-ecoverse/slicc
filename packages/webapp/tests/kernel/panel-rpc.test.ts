import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createPanelRpcClient,
  installPanelRpcHandler,
  panelRpcChannelName,
} from '../../src/kernel/panel-rpc.js';

/**
 * Tiny in-memory BroadcastChannel polyfill so this test runs under the
 * Node-environment vitest setup the rest of the kernel suite uses. The
 * real BroadcastChannel is async on the same channel name but
 * delivers synchronously through the JS task queue; this polyfill
 * mirrors that with queueMicrotask.
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
    for (const peer of bus) {
      if (peer === this || peer.closed) continue;
      queueMicrotask(() => {
        for (const l of peer.listeners) l(new MessageEvent('message', { data }));
      });
    }
  }
  addEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'message', listener: (ev: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
    const bus = FakeChannel.buses.get(this.name);
    bus?.delete(this);
    this.listeners.clear();
  }
}

let originalBroadcastChannel: typeof BroadcastChannel | undefined;

beforeEach(() => {
  originalBroadcastChannel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel })
    .BroadcastChannel;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel =
    FakeChannel as unknown as typeof BroadcastChannel;
});

afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBroadcastChannel;
});

describe('panel-rpc', () => {
  it('panelRpcChannelName scopes by instanceId', () => {
    expect(panelRpcChannelName()).toBe('slicc-panel-rpc');
    expect(panelRpcChannelName('abc')).toBe('slicc-panel-rpc:abc');
  });

  it('round-trips a request/response through the handler', async () => {
    const stop = installPanelRpcHandler({
      instanceId: 't1',
      handlers: {
        'page-info': () => ({
          origin: 'http://localhost:5720',
          href: 'http://localhost:5720/',
          title: 'slicc',
        }),
      },
    });
    const client = createPanelRpcClient({ instanceId: 't1' });
    const info = await client.call('page-info', undefined);
    expect(info.origin).toBe('http://localhost:5720');
    expect(info.title).toBe('slicc');
    client.dispose();
    stop();
  });

  it('forwards handler errors as rejected promises', async () => {
    const stop = installPanelRpcHandler({
      instanceId: 't2',
      handlers: {
        'clipboard-read-text': () => {
          throw new Error('clipboard blocked');
        },
      },
    });
    const client = createPanelRpcClient({ instanceId: 't2' });
    await expect(client.call('clipboard-read-text', undefined)).rejects.toThrow(
      /clipboard blocked/
    );
    client.dispose();
    stop();
  });

  it('responds with an error for an unregistered op rather than hanging', async () => {
    const stop = installPanelRpcHandler({ instanceId: 't3', handlers: {} });
    const client = createPanelRpcClient({ instanceId: 't3' });
    await expect(client.call('page-info', undefined, { timeoutMs: 200 })).rejects.toThrow(
      /no handler for op 'page-info'/
    );
    client.dispose();
    stop();
  });

  it('times out when no handler is listening on the channel', async () => {
    vi.useFakeTimers();
    const client = createPanelRpcClient({ instanceId: 'lonely' });
    const promise = client.call('page-info', undefined, { timeoutMs: 50 });
    // Attach the expectation handler before advancing fake timers so
    // the rejection is observed instead of surfacing as an
    // unhandled-rejection warning.
    const expectation = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await expectation;
    client.dispose();
    vi.useRealTimers();
  });

  it('does not cross-talk between instanceIds', async () => {
    const stopA = installPanelRpcHandler({
      instanceId: 'A',
      handlers: { 'clipboard-read-text': () => ({ text: 'from-A' }) },
    });
    const stopB = installPanelRpcHandler({
      instanceId: 'B',
      handlers: { 'clipboard-read-text': () => ({ text: 'from-B' }) },
    });
    const clientA = createPanelRpcClient({ instanceId: 'A' });
    const clientB = createPanelRpcClient({ instanceId: 'B' });
    expect((await clientA.call('clipboard-read-text', undefined)).text).toBe('from-A');
    expect((await clientB.call('clipboard-read-text', undefined)).text).toBe('from-B');
    clientA.dispose();
    clientB.dispose();
    stopA();
    stopB();
  });

  it('dispose rejects in-flight calls', async () => {
    // No handler installed, so the call won't complete on its own.
    const client = createPanelRpcClient({ instanceId: 'dispose-test' });
    const promise = client.call('page-info', undefined, { timeoutMs: 5000 });
    client.dispose();
    await expect(promise).rejects.toThrow(/client disposed/);
  });

  it('returns a fail-fast proxy when BroadcastChannel is unavailable', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const client = createPanelRpcClient({ instanceId: 'no-bc' });
    await expect(client.call('page-info', undefined)).rejects.toThrow(
      /BroadcastChannel is unavailable/
    );
  });

  it('round-trips tray-reset and returns the new LeaderTrayRuntimeStatus', async () => {
    // Worker → page handler → worker. Verifies that the typed result
    // (LeaderTrayRuntimeStatus, not a generic record) survives the
    // bridge serialization (BroadcastChannel uses structured clone) and
    // that the worker-side proxy returns it intact.
    const newStatus = {
      state: 'leader' as const,
      session: {
        workerBaseUrl: 'https://tray.example.com',
        trayId: 'tray-after-reset',
        createdAt: '2026-05-17T00:00:00.000Z',
        controllerId: 'controller-1',
        controllerUrl: 'https://tray.example.com/controller/controller-1',
        joinUrl: 'https://tray.example.com/join/tray-after-reset',
        webhookUrl: 'https://tray.example.com/webhooks/tray-after-reset',
        leaderKey: 'leader-key',
        leaderWebSocketUrl: 'wss://tray.example.com/ws',
        runtime: 'slicc-standalone',
      },
      error: null,
    };
    let invocations = 0;
    const stop = installPanelRpcHandler({
      instanceId: 'tray-reset-rt',
      handlers: {
        'tray-reset': async () => {
          invocations += 1;
          return newStatus;
        },
      },
    });
    const client = createPanelRpcClient({ instanceId: 'tray-reset-rt' });
    const result = await client.call('tray-reset', undefined);
    expect(invocations).toBe(1);
    expect(result.state).toBe('leader');
    expect(result.session?.joinUrl).toBe('https://tray.example.com/join/tray-after-reset');
    client.dispose();
    stop();
  });

  it('propagates page-side tray-reset failure as a rejection on the worker side', async () => {
    const stop = installPanelRpcHandler({
      instanceId: 'tray-reset-err',
      handlers: {
        'tray-reset': async () => {
          throw new Error('no active tray session to reset');
        },
      },
    });
    const client = createPanelRpcClient({ instanceId: 'tray-reset-err' });
    await expect(client.call('tray-reset', undefined)).rejects.toThrow(/no active tray session/);
    client.dispose();
    stop();
  });
});
