import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPanelRpcClient,
  installPanelRpcHandler,
  PANEL_RPC_DEFAULT_TIMEOUT_MS,
  type PanelRpcPushMsg,
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

  /**
   * `oauth-extras-set` is the op that fixes issue #701: worker-side
   * `oauth-domain` writes route through here to reach real page
   * localStorage. Unit tests cover each side in isolation; this case
   * locks the wire contract by exercising the REAL page handler from
   * `panel-rpc-handlers.ts` against the REAL worker client. If the
   * variant's name, payload shape, or `storeAfter` field is renamed
   * on only one side, this assertion fails.
   */
  it('oauth-extras-set: real page handler ↔ worker client round-trip', async () => {
    const { createStandalonePanelRpcHandlers } = await import('../../src/ui/panel-rpc-handlers.js');
    const originalLocalStorage = globalThis.localStorage;
    const lsData: Record<string, string> = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      get length(): number {
        return Object.keys(lsData).length;
      },
      key: (i: number) => Object.keys(lsData)[i] ?? null,
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
    };
    try {
      const stop = installPanelRpcHandler({
        instanceId: 'oauth-rt',
        handlers: createStandalonePanelRpcHandlers({}),
      });
      const client = createPanelRpcClient({ instanceId: 'oauth-rt' });

      // 1. First write.
      const r1 = await client.call('oauth-extras-set', {
        providerId: 'adobe',
        domains: ['admin.hlx.page', '*.aem.page'],
      });
      expect(r1).toEqual({ storeAfter: { adobe: ['admin.hlx.page', '*.aem.page'] } });
      expect(lsData.slicc_oauth_extra_domains).toBe(
        JSON.stringify({ adobe: ['admin.hlx.page', '*.aem.page'] })
      );

      // 2. Second write on a different provider — the response carries
      // the FULL post-write store so the worker can mirror correctly,
      // not just the touched provider's slice.
      const r2 = await client.call('oauth-extras-set', {
        providerId: 'github',
        domains: ['hub.example.com'],
      });
      expect(r2.storeAfter).toEqual({
        adobe: ['admin.hlx.page', '*.aem.page'],
        github: ['hub.example.com'],
      });

      // 3. Empty domains drops the provider entry.
      const r3 = await client.call('oauth-extras-set', {
        providerId: 'adobe',
        domains: [],
      });
      expect(r3.storeAfter).toEqual({ github: ['hub.example.com'] });
      expect(lsData.slicc_oauth_extra_domains).toBe(
        JSON.stringify({ github: ['hub.example.com'] })
      );

      client.dispose();
      stop();
    } finally {
      (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
    }
  });

  it('exposes the default timeout constant', () => {
    expect(PANEL_RPC_DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it('round-trips a remote-cdp-send request', async () => {
    const stop = installPanelRpcHandler({
      instanceId: 'rcdp-send',
      handlers: {
        'remote-cdp-send': (p) => ({ echoed: p.method }),
      },
    });
    const client = createPanelRpcClient({ instanceId: 'rcdp-send' });
    const result = await client.call('remote-cdp-send', {
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.captureScreenshot',
    });
    expect(result).toEqual({ echoed: 'Page.captureScreenshot' });
    client.dispose();
    stop();
  });

  it('round-trips a proxied-fetch request and preserves the ArrayBuffer body', async () => {
    // Worker → page handler → worker. The page-side handler returns the raw
    // head + body bytes; structured clone over the channel must preserve the
    // ArrayBuffer so the worker can finalize it into its own binary-cache.
    const bodyBytes = new TextEncoder().encode('hello world');
    let seen: { url: string; method: string; headers: Record<string, string> } | null = null;
    const stop = installPanelRpcHandler({
      instanceId: 'pf-rt',
      handlers: {
        'proxied-fetch': (p) => {
          seen = { url: p.url, method: p.method, headers: p.headers };
          return {
            head: { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } },
            body: bodyBytes.buffer,
          };
        },
      },
    });
    const client = createPanelRpcClient({ instanceId: 'pf-rt' });
    const result = await client.call('proxied-fetch', {
      url: 'https://example.com/pkg.tgz',
      method: 'GET',
      headers: { authorization: 'Bearer x' },
    });
    expect(seen).toEqual({
      url: 'https://example.com/pkg.tgz',
      method: 'GET',
      headers: { authorization: 'Bearer x' },
    });
    expect(result.head.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('hello world');
    client.dispose();
    stop();
  });

  it('dispatches a remote-cdp-event push to the registered target', async () => {
    const client = createPanelRpcClient({ instanceId: 'rcdp-push' });
    const received: Array<{ method: string }> = [];
    client.registerPushTarget('follower-1:tgt-1', (payload) => {
      received.push({ method: payload.method });
    });

    // A second channel on the same name simulates the page-side pusher.
    const pusher = new BroadcastChannel(panelRpcChannelName('rcdp-push'));
    const push: PanelRpcPushMsg = {
      type: 'panel-rpc-push',
      op: 'remote-cdp-event',
      payload: { runtimeId: 'follower-1', localTargetId: 'tgt-1', method: 'Page.loadEventFired' },
    };
    pusher.postMessage(push);

    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([{ method: 'Page.loadEventFired' }]);

    client.unregisterPushTarget('follower-1:tgt-1');
    pusher.postMessage(push);
    await new Promise((r) => setTimeout(r, 0));
    // No new delivery after unregister.
    expect(received).toEqual([{ method: 'Page.loadEventFired' }]);

    pusher.close();
    client.dispose();
  });

  it('ignores pushes for unregistered target keys without throwing', async () => {
    const client = createPanelRpcClient({ instanceId: 'rcdp-orphan' });
    const pusher = new BroadcastChannel(panelRpcChannelName('rcdp-orphan'));
    pusher.postMessage({
      type: 'panel-rpc-push',
      op: 'remote-cdp-event',
      payload: { runtimeId: 'x', localTargetId: 'y', method: 'Page.frameNavigated' },
    } satisfies PanelRpcPushMsg);
    await new Promise((r) => setTimeout(r, 0));
    // Reaching here without an unhandled error is the assertion.
    expect(true).toBe(true);
    pusher.close();
    client.dispose();
  });

  it('push register/unregister are no-ops when BroadcastChannel is unavailable', () => {
    const saved = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const client = createPanelRpcClient({ instanceId: 'no-bc-push' });
    expect(() => client.registerPushTarget('a:b', () => {})).not.toThrow();
    expect(() => client.unregisterPushTarget('a:b')).not.toThrow();
    client.dispose();
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = saved;
  });
});
