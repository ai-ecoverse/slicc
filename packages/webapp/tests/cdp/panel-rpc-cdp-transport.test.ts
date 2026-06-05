import { describe, expect, it, vi } from 'vitest';

import {
  PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS,
  PanelRpcCdpTransport,
} from '../../src/cdp/panel-rpc-cdp-transport.js';
import { PANEL_RPC_DEFAULT_TIMEOUT_MS, type PanelRpcClient } from '../../src/kernel/panel-rpc.js';

/** Minimal fake panel-RPC client capturing calls and push registration. */
function makeFakeClient(): {
  client: PanelRpcClient;
  calls: Array<{ op: string; payload: unknown; timeoutMs?: number }>;
  pushTargets: Map<string, (payload: unknown) => void>;
  resolveNext: (result: Record<string, unknown>) => void;
} {
  const calls: Array<{ op: string; payload: unknown; timeoutMs?: number }> = [];
  const pushTargets = new Map<string, (payload: unknown) => void>();
  let pendingResolve: ((result: Record<string, unknown>) => void) | null = null;
  const client = {
    call: vi.fn((op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
      calls.push({ op, payload, timeoutMs: opts?.timeoutMs });
      return new Promise((resolve) => {
        pendingResolve = resolve as (r: Record<string, unknown>) => void;
      });
    }),
    registerPushTarget: vi.fn((key: string, handler: (payload: unknown) => void) => {
      pushTargets.set(key, handler);
    }),
    unregisterPushTarget: vi.fn((key: string) => {
      pushTargets.delete(key);
    }),
    dispose: vi.fn(),
  } as unknown as PanelRpcClient;
  return {
    client,
    calls,
    pushTargets,
    resolveNext: (result) => pendingResolve?.(result),
  };
}

describe('PanelRpcCdpTransport', () => {
  it('starts connected and connect() is a no-op', async () => {
    const { client } = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => client, 'follower-1', 'tgt-1');
    expect(t.state).toBe('connected');
    await expect(t.connect()).resolves.toBeUndefined();
    expect(t.state).toBe('connected');
  });

  it('send maps to remote-cdp-send with the layered timeout', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.send('Page.captureScreenshot', { format: 'png' }, 'sess-1');
    expect(fake.calls[0].op).toBe('remote-cdp-send');
    expect(fake.calls[0].payload).toEqual({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
      sessionId: 'sess-1',
      // resolved CDP timeout forwarded to the page so it isn't floored at 30s
      timeout: 30_000,
    });
    // default CDP timeout 30_000 → max(30_000, 15_000) + margin
    expect(fake.calls[0].timeoutMs).toBe(30_000 + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS);
    fake.resolveNext({ data: 'AAAA' });
    await expect(p).resolves.toEqual({ data: 'AAAA' });
  });

  it('honors an explicit CDP timeout below the panel-RPC floor', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    void t.send('Page.enable', undefined, undefined, 5_000);
    // max(5_000, 15_000) + margin
    expect(fake.calls[0].timeoutMs).toBe(15_000 + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS);
    expect(PANEL_RPC_DEFAULT_TIMEOUT_MS).toBe(15_000);
    // the explicit CDP timeout is forwarded to the page transport verbatim
    expect((fake.calls[0].payload as { timeout?: number }).timeout).toBe(5_000);
  });

  it('fails closed when there is no panel-RPC client', async () => {
    const t = new PanelRpcCdpTransport(() => null, 'follower-1', 'tgt-1');
    await expect(t.send('Page.enable')).rejects.toThrow(/no page bridge to the leader tray/);
  });

  it('first on() subscribes, last off() unsubscribes', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const a = vi.fn();
    const b = vi.fn();
    t.on('Page.loadEventFired', a);
    t.on('Page.loadEventFired', b);
    // Only the 0→1 transition subscribes.
    const subs = fake.calls.filter((c) => c.op === 'remote-cdp-subscribe');
    expect(subs).toHaveLength(1);
    t.off('Page.loadEventFired', a);
    expect(fake.calls.filter((c) => c.op === 'remote-cdp-unsubscribe')).toHaveLength(0);
    t.off('Page.loadEventFired', b);
    expect(fake.calls.filter((c) => c.op === 'remote-cdp-unsubscribe')).toHaveLength(1);
  });

  it('dispatches a pushed event to local listeners', () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const seen: Array<Record<string, unknown>> = [];
    t.on('Page.loadEventFired', (params) => seen.push(params));
    const handler = fake.pushTargets.get('follower-1:tgt-1');
    expect(handler).toBeTypeOf('function');
    handler?.({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
    });
    expect(seen).toEqual([{ timestamp: 1 }]);
  });

  it('once() resolves on the next matching pushed event', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired');
    fake.pushTargets.get('follower-1:tgt-1')?.({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.loadEventFired',
      params: { ok: true },
    });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('once() rejects on timeout', async () => {
    vi.useFakeTimers();
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired', 50);
    const expectation = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await expectation;
    vi.useRealTimers();
  });

  it('disconnect() detaches, unregisters the push target, and rejects later sends', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    t.on('Page.loadEventFired', vi.fn()); // forces push registration
    t.disconnect();
    expect(t.state).toBe('disconnected');
    expect(fake.calls.some((c) => c.op === 'remote-cdp-detach')).toBe(true);
    expect(fake.client.unregisterPushTarget).toHaveBeenCalledWith('follower-1:tgt-1');
    await expect(t.send('Page.enable')).rejects.toThrow(/disconnected/);
  });

  it('disconnect() rejects an in-flight once() with "Transport disconnected"', async () => {
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired');
    const expectation = expect(p).rejects.toThrow(/Transport disconnected/);
    t.disconnect();
    await expectation;
  });

  it('once() timeout removes its listener (1→0 unsubscribe)', async () => {
    vi.useFakeTimers();
    const fake = makeFakeClient();
    const t = new PanelRpcCdpTransport(() => fake.client, 'follower-1', 'tgt-1');
    const p = t.once('Page.loadEventFired', 50);
    const expectation = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await expectation;
    // The timed-out once() must unwire its listener so the page-side
    // forwarder is torn down (no leaked subscription).
    expect(fake.calls.filter((c) => c.op === 'remote-cdp-unsubscribe')).toHaveLength(1);
    vi.useRealTimers();
  });

  it('on() with no panel-RPC client neither throws nor registers a push target', () => {
    const t = new PanelRpcCdpTransport(() => null, 'follower-1', 'tgt-1');
    expect(() => t.on('Page.loadEventFired', vi.fn())).not.toThrow();
    expect(t.state).toBe('connected');
  });
});
