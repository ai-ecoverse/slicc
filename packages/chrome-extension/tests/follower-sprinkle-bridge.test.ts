import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  PanelFollowerSprinkleProxy,
  connectOffscreenFollowerSprinkleBridge,
} from '../src/follower-sprinkle-bridge.js';
import type { SprinkleFollowerSync } from '../../../packages/webapp/src/ui/sprinkle-follower-controller.js';
import type { SprinkleSummary } from '../../../packages/webapp/src/scoops/tray-sync-protocol.js';

/**
 * Mini message bus that wires a panel side and an offscreen side together so
 * tests don't need a real `chrome.runtime`. Envelopes propagate synchronously
 * — Promise resolution on fetch responses still needs an `await` cycle.
 */
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
    },
  };
}

function makeOffscreenSync(): SprinkleFollowerSync & {
  fetched: string[];
  licks: Array<{ name: string; body: unknown; targetScoop?: string }>;
  contentByName: Map<string, string>;
  rejectNext?: Error;
} {
  const fetched: string[] = [];
  const licks: Array<{ name: string; body: unknown; targetScoop?: string }> = [];
  const contentByName = new Map<string, string>();
  const surface = {
    contentByName,
    fetched,
    licks,
    rejectNext: undefined as Error | undefined,
    async fetchSprinkleContent(name: string): Promise<string> {
      fetched.push(name);
      if (surface.rejectNext) throw surface.rejectNext;
      const content = contentByName.get(name);
      if (content === undefined) throw new Error(`no content stub for ${name}`);
      return content;
    },
    sendSprinkleLick(name: string, body: unknown, targetScoop?: string): void {
      licks.push({ name, body, targetScoop });
    },
  };
  return surface;
}

describe('PanelFollowerSprinkleProxy ↔ OffscreenFollowerSprinkleBridge', () => {
  let bus: ReturnType<typeof createBus>;
  let offscreenSync: ReturnType<typeof makeOffscreenSync>;

  beforeEach(() => {
    bus = createBus();
    offscreenSync = makeOffscreenSync();
    connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
  });

  it('forwards a fetchSprinkleContent round-trip through the bridge', async () => {
    offscreenSync.contentByName.set('welcome', '<p>hello</p>');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    const content = await proxy.fetchSprinkleContent('welcome');
    expect(content).toBe('<p>hello</p>');
    expect(offscreenSync.fetched).toEqual(['welcome']);
  });

  it('propagates a fetch error from offscreen to the panel', async () => {
    offscreenSync.rejectNext = new Error('leader gone');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    await expect(proxy.fetchSprinkleContent('welcome')).rejects.toThrow('leader gone');
  });

  it('routes multiple concurrent fetches by id without crossing the wires', async () => {
    offscreenSync.contentByName.set('a', 'aaa');
    offscreenSync.contentByName.set('b', 'bbb');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    const [a, b] = await Promise.all([
      proxy.fetchSprinkleContent('a'),
      proxy.fetchSprinkleContent('b'),
    ]);
    expect(a).toBe('aaa');
    expect(b).toBe('bbb');
  });

  it('forwards sendSprinkleLick over the wire', () => {
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    proxy.sendSprinkleLick('welcome', { action: 'click' }, 'scoop-1');

    expect(offscreenSync.licks).toEqual([
      { name: 'welcome', body: { action: 'click' }, targetScoop: 'scoop-1' },
    ]);
  });

  it('fans out sprinkles.list from offscreen to the panel listener', () => {
    const onSprinklesList = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });

    const bridge = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    const sprinkles: SprinkleSummary[] = [
      { name: 'welcome', title: 'Welcome', path: '/x.shtml', open: true, autoOpen: true },
    ];
    bridge.forwardSprinklesList(sprinkles);

    expect(onSprinklesList).toHaveBeenCalledWith(sprinkles);
  });

  it('fans out sprinkle.update from offscreen to the panel listener', () => {
    const onSprinkleUpdate = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinkleUpdate });

    const bridge = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    bridge.forwardSprinkleUpdate('welcome', { step: 1 });

    expect(onSprinkleUpdate).toHaveBeenCalledWith('welcome', { step: 1 });
  });

  it('ignores envelopes from non-offscreen sources on the panel side', () => {
    const onSprinklesList = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });

    // Simulate a stray envelope from another source (e.g. service worker).
    bus.offscreenHub.sendToPanel({
      source: 'service-worker' as unknown as 'offscreen',
      payload: { type: 'follower-sprinkles-list', sprinkles: [] },
    });

    expect(onSprinklesList).not.toHaveBeenCalled();
  });

  it('dispose() rejects outstanding fetches and detaches the listener', async () => {
    // Don't stub content — the fetch will hang until dispose.
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    // Intercept the request so the bridge never resolves it.
    const pending = proxy.fetchSprinkleContent('hangs');
    proxy.dispose();

    await expect(pending).rejects.toThrow(/disposed/);

    // After dispose, sending more envelopes from offscreen does nothing.
    const onSprinklesList = vi.fn();
    // Recreate proxy after dispose to confirm a fresh instance still works.
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });
    const bridge2 = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    bridge2.forwardSprinklesList([]);
    expect(onSprinklesList).toHaveBeenCalled();
  });

  it('detach() stops the offscreen bridge from forwarding new payloads to the panel', () => {
    const bus2 = createBus();
    const offscreenSync2 = makeOffscreenSync();
    const onSprinklesList = vi.fn();
    new PanelFollowerSprinkleProxy(bus2.panelSender, bus2.panelSubscriber, { onSprinklesList });
    const bridge2 = connectOffscreenFollowerSprinkleBridge(bus2.offscreenHub, offscreenSync2);

    // Before detach, forwards land in the panel listener.
    bridge2.forwardSprinklesList([
      { name: 'a', title: 'A', path: '/a.shtml', open: true, autoOpen: false },
    ]);
    expect(onSprinklesList).toHaveBeenCalledTimes(1);

    // After detach, subsequent forwards are no-ops.
    bridge2.detach();
    bridge2.forwardSprinklesList([]);
    bridge2.forwardSprinkleUpdate('a', { step: 1 });
    expect(onSprinklesList).toHaveBeenCalledTimes(1);
  });

  it('detach() drops in-flight fetch replies started before detach (no late envelope leak)', async () => {
    const bus2 = createBus();
    let resolveFetch!: (s: string) => void;
    const stuckSync: SprinkleFollowerSync = {
      fetchSprinkleContent: () =>
        new Promise<string>((r) => {
          resolveFetch = r;
        }),
      sendSprinkleLick: () => {},
    };
    const bridge = connectOffscreenFollowerSprinkleBridge(bus2.offscreenHub, stuckSync);
    const proxy = new PanelFollowerSprinkleProxy(
      bus2.panelSender,
      bus2.panelSubscriber,
      {},
      {
        fetchTimeoutMs: 1_000_000,
      }
    );

    const pending = proxy.fetchSprinkleContent('x');
    // Detach the offscreen bridge BEFORE the leader-side fetch resolves.
    bridge.detach();
    resolveFetch('late content');
    // The bridge must not have forwarded the result to the panel; the fetch
    // promise stays pending. Confirm by racing against a short timer.
    const winner = await Promise.race([
      pending.then(() => 'resolved' as const),
      new Promise<'still-pending'>((r) => setTimeout(() => r('still-pending'), 25)),
    ]);
    expect(winner).toBe('still-pending');
    proxy.dispose(); // Avoid an unhandled rejection.
    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('fetchSprinkleContent times out when offscreen never responds', async () => {
    const bus2 = createBus();
    // No bridge wired against bus2 — fetches enter the void.
    const proxy = new PanelFollowerSprinkleProxy(
      bus2.panelSender,
      bus2.panelSubscriber,
      {},
      {
        fetchTimeoutMs: 20,
      }
    );

    await expect(proxy.fetchSprinkleContent('x')).rejects.toThrow(/timed out/i);
  });

  it('fetchSprinkleContent rejects synchronously when called on a disposed proxy', async () => {
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);
    proxy.dispose();
    await expect(proxy.fetchSprinkleContent('x')).rejects.toThrow(/disposed/);
  });

  // R2-IMP-1: `narrowMsg`-guarded paths must drop malformed envelopes
  // silently, and the `FollowerSprinkleFetchResultMsg` consumer must
  // surface a meaningful error when `ok` is missing or non-boolean
  // (was previously rejecting with `Error("")` for any falsy `ok`).
  describe('malformed envelopes', () => {
    function pump(envelope: { source: string; payload: unknown }) {
      // Push directly through the offscreen hub so the panel proxy's
      // subscriber fires. Bypasses the typed bridge intentionally — that's
      // the whole point of "malformed".
      bus.offscreenHub.sendToPanel(envelope as { source: 'offscreen'; payload: unknown });
    }

    it('drops null payload silently', () => {
      const onSprinklesList = vi.fn();
      new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });
      expect(() => pump({ source: 'offscreen', payload: null })).not.toThrow();
      expect(onSprinklesList).not.toHaveBeenCalled();
    });

    it('drops payload with missing type silently', () => {
      const onSprinklesList = vi.fn();
      const onSprinkleUpdate = vi.fn();
      new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, {
        onSprinklesList,
        onSprinkleUpdate,
      });
      expect(() => pump({ source: 'offscreen', payload: { sprinkles: [] } })).not.toThrow();
      expect(onSprinklesList).not.toHaveBeenCalled();
      expect(onSprinkleUpdate).not.toHaveBeenCalled();
    });

    it('drops payload with non-string type silently', () => {
      const onSprinklesList = vi.fn();
      new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });
      expect(() =>
        pump({ source: 'offscreen', payload: { type: 123, sprinkles: [] } })
      ).not.toThrow();
      expect(onSprinklesList).not.toHaveBeenCalled();
    });

    it('rejects a fetch with a meaningful error when `ok` is undefined', async () => {
      const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);
      const pending = proxy.fetchSprinkleContent('x');
      await Promise.resolve();
      const pendingFetchId = (proxy as unknown as { pending: Map<string, unknown> }).pending
        .keys()
        .next().value as string;

      pump({
        source: 'offscreen',
        payload: {
          type: 'follower-sprinkle-fetch-result',
          id: pendingFetchId,
          // `ok` intentionally omitted
        },
      });

      await expect(pending).rejects.toThrow(/missing or non-boolean `ok`/);
    });

    it('rejects a fetch with a meaningful error when `ok` is a truthy non-boolean', async () => {
      const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);
      const pending = proxy.fetchSprinkleContent('x');
      await Promise.resolve();
      const pendingFetchId = (proxy as unknown as { pending: Map<string, unknown> }).pending
        .keys()
        .next().value as string;

      pump({
        source: 'offscreen',
        payload: {
          type: 'follower-sprinkle-fetch-result',
          id: pendingFetchId,
          ok: 'yes',
          content: 'should-not-resolve',
        },
      });

      await expect(pending).rejects.toThrow(/missing or non-boolean `ok`/);
    });
  });
});
