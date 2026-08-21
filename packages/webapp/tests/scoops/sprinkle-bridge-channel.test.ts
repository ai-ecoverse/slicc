import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSprinkleManagerProxyOverChannel,
  installSprinkleManagerHandlerOverChannel,
  SPRINKLE_BRIDGE_CHANNEL,
  sprinkleBridgeChannelName,
} from '../../src/scoops/sprinkle-bridge-channel.js';
import type { SprinkleSendTarget } from '../../src/shell/sprinkle-manager-handle.js';
import type { Sprinkle } from '../../src/ui/sprinkle-discovery.js';
import type { SprinkleManager } from '../../src/ui/sprinkle-manager.js';

/**
 * Minimal in-memory BroadcastChannel polyfill scoped per-test so the
 * worker-side proxy and page-side handler can round-trip without the
 * real Web API. The shell tests run in `node`, where
 * `BroadcastChannel` is not always present.
 */
function installBroadcastChannelPolyfill(): { cleanup: () => void } {
  const channels = new Map<string, Set<FakeChannel>>();
  class FakeChannel {
    name: string;
    private listeners = new Set<(ev: { data: unknown }) => void>();
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      let group = channels.get(name);
      if (!group) {
        group = new Set();
        channels.set(name, group);
      }
      group.add(this);
    }
    postMessage(data: unknown): void {
      const peers = channels.get(this.name);
      if (!peers) return;
      for (const peer of peers) {
        if (peer === this) continue;
        peer.listeners.forEach((cb) => {
          cb({ data });
        });
        peer.onmessage?.({ data });
      }
    }
    addEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      this.listeners.add(cb);
    }
    removeEventListener(_type: 'message', cb: (ev: { data: unknown }) => void): void {
      this.listeners.delete(cb);
    }
    close(): void {
      this.listeners.clear();
      channels.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  return {
    cleanup: () => {
      channels.clear();
      vi.unstubAllGlobals();
    },
  };
}

function makeFakeManager(): SprinkleManager & {
  calls: Array<{ op: string; args?: unknown[] }>;
} {
  const sprinkles: Sprinkle[] = [
    { name: 'demo', title: 'Demo Sprinkle', path: '/workspace/demo.shtml', autoOpen: false },
    { name: 'todo', title: 'Todo App', path: '/workspace/todo.shtml', autoOpen: true },
  ];
  const opened: string[] = ['todo'];
  const calls: Array<{ op: string; args?: unknown[] }> = [];

  const manager: Partial<SprinkleManager> & { calls: typeof calls } = {
    calls,
    refresh: async () => {
      calls.push({ op: 'refresh' });
    },
    available: () => {
      calls.push({ op: 'available' });
      return sprinkles;
    },
    opened: () => {
      calls.push({ op: 'opened' });
      return opened;
    },
    open: async (name: string) => {
      calls.push({ op: 'open', args: [name] });
    },
    close: (name: string) => {
      calls.push({ op: 'close', args: [name] });
    },
    sendToSprinkle: (name: string, data: unknown, target?: SprinkleSendTarget) => {
      calls.push({ op: 'sendToSprinkle', args: [name, data, target] });
      return { leader: true, followers: [] };
    },
    openNewAutoOpenSprinkles: async () => {
      calls.push({ op: 'openNewAutoOpenSprinkles' });
    },
  };
  return manager as SprinkleManager & { calls: typeof calls };
}

describe('sprinkle bridge channel', () => {
  let bc: { cleanup: () => void } | null = null;

  beforeEach(() => {
    bc = installBroadcastChannelPolyfill();
  });

  afterEach(() => {
    bc?.cleanup();
    bc = null;
  });

  it('exposes the channel name as a constant', () => {
    expect(SPRINKLE_BRIDGE_CHANNEL).toBe('slicc-sprinkle-bridge');
  });

  it('scopes the channel name by instanceId', () => {
    expect(sprinkleBridgeChannelName('abc-123')).toBe('slicc-sprinkle-bridge:abc-123');
    expect(sprinkleBridgeChannelName(undefined)).toBe('slicc-sprinkle-bridge');
  });

  it('keeps two instances on disjoint channels (no cross-talk)', async () => {
    const managerA = makeFakeManager();
    const managerB = makeFakeManager();
    const stopA = installSprinkleManagerHandlerOverChannel(managerA, { instanceId: 'tab-A' });
    const stopB = installSprinkleManagerHandlerOverChannel(managerB, { instanceId: 'tab-B' });

    const proxyA = createSprinkleManagerProxyOverChannel({ instanceId: 'tab-A' });
    await proxyA.open('only-on-A');

    expect(managerA.calls).toEqual(expect.arrayContaining([{ op: 'open', args: ['only-on-A'] }]));
    expect(managerB.calls).toEqual([]); // tab B never sees tab A's request

    stopA();
    stopB();
  });

  it('refresh() pulls available + opened from the page handler', async () => {
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);

    const proxy = createSprinkleManagerProxyOverChannel();
    expect(proxy.available()).toEqual([]); // empty before refresh
    expect(proxy.opened()).toEqual([]);

    await proxy.refresh();
    expect(proxy.available()).toHaveLength(2);
    expect(proxy.opened()).toEqual(['todo']);
    // The handler should have run refresh on the manager (for `list`).
    expect(manager.calls.some((c) => c.op === 'refresh')).toBe(true);

    stop();
  });

  it('open() forwards the name to the page manager', async () => {
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    await proxy.open('demo');
    expect(manager.calls).toEqual(expect.arrayContaining([{ op: 'open', args: ['demo'] }]));
    stop();
  });

  it('close() is fire-and-forget; sendToSprinkle() returns the delivery report', async () => {
    // `sendToSprinkle` used to be fire-and-forget too. It now awaits the
    // page's report so `sprinkle send` can say what the push reached and fail
    // when it reached nothing (issue #2166).
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    proxy.close('demo');
    const report = await proxy.sendToSprinkle('demo', { hello: 'world' });

    expect(report).toEqual({ leader: true, followers: [] });
    expect(manager.calls).toEqual(
      expect.arrayContaining([
        { op: 'close', args: ['demo'] },
        { op: 'sendToSprinkle', args: ['demo', { hello: 'world' }, undefined] },
      ])
    );
    stop();
  });

  it('awaits a promise-returning manager instead of postMessaging the promise', async () => {
    // `SprinkleManagerHandle.sendToSprinkle` is typed
    // `SprinkleSendReport | Promise<SprinkleSendReport>`. `respond` goes
    // through `postMessage`, so handing it a promise throws DataCloneError
    // rather than serializing oddly — the page-side manager happens to be
    // synchronous today, which is exactly why this needs a test.
    const manager = makeFakeManager();
    manager.sendToSprinkle = (() =>
      Promise.resolve({ leader: false, followers: ['follower-8a47'] })) as never;
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    const report = await proxy.sendToSprinkle('demo', { hello: 'world' });

    expect(report).toEqual({ leader: false, followers: ['follower-8a47'] });
    stop();
  });

  it('carries a --runtime target across the channel', async () => {
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    await proxy.sendToSprinkle('demo', { hello: 'world' }, { runtime: 'follower-8a47' });

    expect(manager.calls).toEqual(
      expect.arrayContaining([
        {
          op: 'sendToSprinkle',
          args: ['demo', { hello: 'world' }, { runtime: 'follower-8a47' }],
        },
      ])
    );
    stop();
  });

  it('openNewAutoOpenSprinkles() awaits the page manager', async () => {
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    await proxy.openNewAutoOpenSprinkles();
    expect(manager.calls.some((c) => c.op === 'openNewAutoOpenSprinkles')).toBe(true);
    stop();
  });

  it('forwards manager errors back to the proxy as rejected promises', async () => {
    const manager = makeFakeManager();
    manager.open = async (name: string) => {
      throw new Error(`no such sprinkle: ${name}`);
    };
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    await expect(proxy.open('missing')).rejects.toThrow('no such sprinkle: missing');
    stop();
  });

  it('proxy rejects with timeout when no handler is installed', async () => {
    const proxy = createSprinkleManagerProxyOverChannel({ timeoutMs: 50 });
    await expect(proxy.open('demo')).rejects.toThrow(/timed out/);
  });

  it('refresh() propagates failures so the shell can surface them', async () => {
    // No handler installed → request times out → refresh rejects.
    const proxy = createSprinkleManagerProxyOverChannel({ timeoutMs: 50 });
    await expect(proxy.refresh()).rejects.toThrow(/timed out/);
  });

  it('handler ignores responses (does not echo its own messages)', async () => {
    const manager = makeFakeManager();
    const stop = installSprinkleManagerHandlerOverChannel(manager);
    const proxy = createSprinkleManagerProxyOverChannel();

    await proxy.refresh();
    const initialCallCount = manager.calls.length;

    // Hand-craft a stray response on the channel; handler should not
    // try to dispatch it as a request.
    const noiseChannel = new BroadcastChannel(SPRINKLE_BRIDGE_CHANNEL);
    noiseChannel.postMessage({ type: 'sprinkle-op-response', id: 'noise', result: 'noise' });
    noiseChannel.close();
    await new Promise((r) => setTimeout(r, 10));

    expect(manager.calls.length).toBe(initialCallCount);
    stop();
  });

  it('fail-fast proxy when BroadcastChannel is unavailable', async () => {
    bc?.cleanup();
    bc = null;
    vi.stubGlobal('BroadcastChannel', undefined);

    const proxy = createSprinkleManagerProxyOverChannel();
    // Sync getters return [] (cache reads — they have to satisfy the
    // SprinkleManager surface). Every async method rejects with a
    // clear "bridge unavailable" error so the shell can surface it
    // instead of returning misleading empty data.
    expect(proxy.available()).toEqual([]);
    expect(proxy.opened()).toEqual([]);
    await expect(proxy.refresh()).rejects.toThrow(/sprinkle bridge unavailable/);
    await expect(proxy.open('demo')).rejects.toThrow(/sprinkle bridge unavailable/);
    await expect(proxy.openNewAutoOpenSprinkles()).rejects.toThrow(/sprinkle bridge unavailable/);

    vi.unstubAllGlobals();
  });
});
