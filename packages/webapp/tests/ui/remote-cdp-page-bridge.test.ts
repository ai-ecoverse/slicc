import { describe, expect, it, vi } from 'vitest';
import type { CDPEventListener } from '../../src/cdp/types.js';
import {
  createRemoteCdpPageBridge,
  type RemoteCdpEventPayload,
  type RemoteCdpSyncProvider,
} from '../../src/ui/remote-cdp-page-bridge.js';

/** A fake page-side RemoteCDPTransport with controllable events. */
class FakeRemoteTransport {
  sent: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
    timeout?: number;
  }> = [];
  listeners = new Map<string, Set<CDPEventListener>>();
  disconnected = false;
  send = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
      timeout?: number
    ) => {
      this.sent.push({ method, params, sessionId, timeout });
      if (method === 'Target.attachToTarget') return { sessionId: 'sess-1' };
      return { ok: method };
    }
  );
  on(event: string, listener: CDPEventListener): void {
    let s = this.listeners.get(event);
    if (!s) {
      s = new Set();
      this.listeners.set(event, s);
    }
    s.add(listener);
  }
  off(event: string, listener: CDPEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  emit(event: string, params: Record<string, unknown>): void {
    for (const cb of this.listeners.get(event) ?? []) cb(params);
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function makeSync(): {
  sync: RemoteCdpSyncProvider;
  transports: Map<string, FakeRemoteTransport>;
  removed: string[];
} {
  const transports = new Map<string, FakeRemoteTransport>();
  const removed: string[] = [];
  const sync: RemoteCdpSyncProvider = {
    createRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      let t = transports.get(key);
      if (!t) {
        t = new FakeRemoteTransport();
        transports.set(key, t);
      }
      return t as unknown as ReturnType<RemoteCdpSyncProvider['createRemoteTransport']>;
    },
    removeRemoteTransport(runtimeId, localTargetId) {
      const key = `${runtimeId}:${localTargetId}`;
      transports.get(key)?.disconnect();
      removed.push(key);
    },
    async openRemoteTab(runtimeId, url) {
      return `${runtimeId}:tab-for-${url}`;
    },
  };
  return { sync, transports, removed };
}

describe('createRemoteCdpPageBridge', () => {
  it('send lazily creates the transport and relays the CDP call', async () => {
    const { sync, transports } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    const result = await bridge.send({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Target.attachToTarget',
      sessionId: undefined,
    });
    expect(result).toEqual({ sessionId: 'sess-1' });
    expect(transports.get('follower-1:tgt-1')?.sent[0].method).toBe('Target.attachToTarget');
  });

  it('send forwards the per-op timeout to the page transport', async () => {
    const { sync, transports } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.send({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.printToPDF',
      sessionId: 'sess-1',
      timeout: 90_000,
    });
    expect(transports.get('follower-1:tgt-1')?.sent[0]).toMatchObject({
      method: 'Page.printToPDF',
      sessionId: 'sess-1',
      timeout: 90_000,
    });
  });

  it('send throws a clear error when the leader tray is not started', async () => {
    const bridge = createRemoteCdpPageBridge({ getSync: () => null, postEvent: vi.fn() });
    await expect(
      bridge.send({ runtimeId: 'f', localTargetId: 't', method: 'Page.enable' })
    ).rejects.toThrow(/leader tray not started/);
  });

  it('ref-counts subscribe/unsubscribe and forwards events as pushes', async () => {
    const { sync, transports } = makeSync();
    const pushes: RemoteCdpEventPayload[] = [];
    const bridge = createRemoteCdpPageBridge({
      getSync: () => sync,
      postEvent: (p) => pushes.push(p),
    });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    const transport = transports.get('f:t')!;
    expect(transport.listenerCount('Page.loadEventFired')).toBe(1); // single forwarder

    transport.emit('Page.loadEventFired', { ts: 1 });
    expect(pushes).toEqual([
      { runtimeId: 'f', localTargetId: 't', method: 'Page.loadEventFired', params: { ts: 1 } },
    ]);

    // First unsubscribe keeps the forwarder (count 2→1).
    await bridge.unsubscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(1);
    // Second unsubscribe removes it (1→0).
    await bridge.unsubscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(0);
  });

  it('detach disposes the session and removes the transport', async () => {
    const { sync, transports, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.subscribe({ runtimeId: 'f', localTargetId: 't', event: 'Page.loadEventFired' });
    const transport = transports.get('f:t')!;
    await bridge.detach({ runtimeId: 'f', localTargetId: 't' });
    expect(transport.listenerCount('Page.loadEventFired')).toBe(0);
    expect(removed).toContain('f:t');
  });

  it('cleanupRuntime drops all sessions for a runtime', async () => {
    const { sync, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.send({ runtimeId: 'f', localTargetId: 't1', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'f', localTargetId: 't2', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'g', localTargetId: 't3', method: 'Page.enable' });
    bridge.cleanupRuntime('f');
    expect(removed.sort()).toEqual(['f:t1', 'f:t2']);
  });

  it('disposeAll drops every session', async () => {
    const { sync, removed } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    await bridge.send({ runtimeId: 'f', localTargetId: 't1', method: 'Page.enable' });
    await bridge.send({ runtimeId: 'g', localTargetId: 't2', method: 'Page.enable' });
    bridge.disposeAll();
    expect(removed.sort()).toEqual(['f:t1', 'g:t2']);
  });

  it('openTab relays through sync and returns the composite id', async () => {
    const { sync } = makeSync();
    const bridge = createRemoteCdpPageBridge({ getSync: () => sync, postEvent: vi.fn() });
    const result = await bridge.openTab({ runtimeId: 'f', url: 'https://x.test' });
    expect(result).toEqual({ targetId: 'f:tab-for-https://x.test' });
  });
});
