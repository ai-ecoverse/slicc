import { describe, expect, it, vi } from 'vitest';
import { PanelRpcCdpTransport } from '../../src/cdp/panel-rpc-cdp-transport.js';
import { createPanelRpcTrayProvider } from '../../src/cdp/panel-rpc-tray-provider.js';
import type { PanelRpcClient } from '../../src/kernel/panel-rpc.js';

function fakeClient(): PanelRpcClient {
  return {
    call: vi.fn(async (op: string) => {
      if (op === 'remote-open-tab') return { targetId: 'follower-1:new-tab' };
      return {};
    }),
    registerPushTarget: vi.fn(),
    unregisterPushTarget: vi.fn(),
    dispose: vi.fn(),
  } as unknown as PanelRpcClient;
}

describe('createPanelRpcTrayProvider', () => {
  it('getTargets returns empty (listing stays on the supplement)', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    expect(provider.getTargets()).toEqual([]);
  });

  it('createRemoteTransport returns a PanelRpcCdpTransport cached per key', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    const a = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    const b = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    const c = provider.createRemoteTransport?.('follower-1', 'tgt-2');
    expect(a).toBeInstanceOf(PanelRpcCdpTransport);
    expect(a).toBe(b); // same key → cached
    expect(a).not.toBe(c); // different key → new transport
  });

  it('removeRemoteTransport disconnects and evicts so a fresh transport is made next', () => {
    const provider = createPanelRpcTrayProvider(() => fakeClient());
    const a = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    provider.removeRemoteTransport?.('follower-1', 'tgt-1');
    expect(a?.state).toBe('disconnected');
    const b = provider.createRemoteTransport?.('follower-1', 'tgt-1');
    expect(b).not.toBe(a);
    expect(b?.state).toBe('connected');
  });

  it('openRemoteTab relays remote-open-tab and returns the composite id', async () => {
    const client = fakeClient();
    const provider = createPanelRpcTrayProvider(() => client);
    const id = await provider.openRemoteTab?.('follower-1', 'https://x.test');
    expect(client.call).toHaveBeenCalledWith('remote-open-tab', {
      runtimeId: 'follower-1',
      url: 'https://x.test',
    });
    expect(id).toBe('follower-1:new-tab');
  });

  it('openRemoteTab fails closed without a panel-RPC client', async () => {
    const provider = createPanelRpcTrayProvider(() => null);
    await expect(provider.openRemoteTab?.('follower-1', 'about:blank')).rejects.toThrow(
      /no page bridge to the leader tray/
    );
  });
});
