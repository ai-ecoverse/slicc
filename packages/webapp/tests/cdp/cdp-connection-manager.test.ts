import { describe, expect, it, vi } from 'vitest';
import {
  CdpConnectionManager,
  type EnsureConnectedHost,
  getDefaultCdpUrl,
} from '../../src/cdp/cdp-connection-manager.js';
import {
  CdpBridgeRejectedError,
  CdpReconnectBackoffError,
} from '../../src/cdp/cdp-reconnect-policy.js';
import type { CDPTransport } from '../../src/cdp/transport.js';

function fakeTransport(overrides: Partial<CDPTransport> = {}): CDPTransport {
  return {
    state: 'connected',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    ...overrides,
  } as unknown as CDPTransport;
}

function hostFor(
  client: CDPTransport,
  extras: Partial<EnsureConnectedHost> = {}
): EnsureConnectedHost {
  return {
    client,
    restoreLocalAfterRemoteDrop: vi.fn(),
    clearSessionsForTransport: vi.fn(),
    getClient: () => client,
    ...extras,
  };
}

describe('getDefaultCdpUrl', () => {
  it('builds ws/wss from the page origin and falls back offline', () => {
    expect(getDefaultCdpUrl({ protocol: 'https:', host: 'example.com' })).toBe(
      'wss://example.com/cdp'
    );
    expect(getDefaultCdpUrl({ protocol: 'http:', host: 'localhost:3030' })).toBe(
      'ws://localhost:3030/cdp'
    );
    expect(getDefaultCdpUrl(null)).toBe('ws://localhost:5710/cdp');
  });
});

describe('CdpConnectionManager', () => {
  it('connect dials with url + protocols and captures options for replay', async () => {
    const mgr = new CdpConnectionManager();
    const client = fakeTransport({ state: 'disconnected' });

    await mgr.connect(client, {
      url: 'ws://localhost:5710/cdp',
      protocols: 'slicc.bridge.v1.abc',
    });

    expect(client.connect).toHaveBeenCalledWith({
      url: 'ws://localhost:5710/cdp',
      timeout: undefined,
      protocols: 'slicc.bridge.v1.abc',
    });

    (client as { state: string }).state = 'disconnected';
    await mgr.ensureConnected(hostFor(client));

    expect(client.connect).toHaveBeenLastCalledWith({
      url: 'ws://localhost:5710/cdp',
      timeout: undefined,
      protocols: 'slicc.bridge.v1.abc',
    });
  });

  it('primeConnectOptions lets lazy connect reach the local bridge without eager dial', async () => {
    const mgr = new CdpConnectionManager();
    const client = fakeTransport({ state: 'disconnected' });
    mgr.primeConnectOptions({
      url: 'ws://localhost:7777/cdp',
      protocols: 'slicc.bridge.v1.follower',
    });

    expect(client.connect).not.toHaveBeenCalled();
    await mgr.ensureConnected(hostFor(client));

    expect(client.connect).toHaveBeenCalledWith({
      url: 'ws://localhost:7777/cdp',
      timeout: undefined,
      protocols: 'slicc.bridge.v1.follower',
    });
  });

  it('does not re-dial a superseded client and notifies once', async () => {
    const mgr = new CdpConnectionManager();
    const client = fakeTransport({ state: 'disconnected', superseded: true });
    const onSuperseded = vi.fn();
    mgr.setSupersededHandler(onSuperseded);

    await mgr.ensureConnected(hostFor(client));
    await mgr.ensureLocalConnected(client);

    expect(client.connect).not.toHaveBeenCalled();
    expect(onSuperseded).toHaveBeenCalledTimes(1);
  });

  it('backs off after a transient connect failure', async () => {
    const mgr = new CdpConnectionManager();
    const client = fakeTransport({ state: 'disconnected' });
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    (client.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('bridge not listening yet')
    );

    await expect(
      mgr.connect(client, { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.x' })
    ).rejects.toThrow('bridge not listening yet');

    await expect(mgr.ensureConnected(hostFor(client))).rejects.toBeInstanceOf(
      CdpReconnectBackoffError
    );
    expect(client.connect).toHaveBeenCalledTimes(1);

    now += 60_000;
    await mgr.ensureConnected(hostFor(client));
    expect(client.connect).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it('stops redialing after a terminal bridge rejection and notifies once', async () => {
    const mgr = new CdpConnectionManager();
    mgr.setConnectFailureClassifier(async () => 'terminal');
    const onRejected = vi.fn();
    mgr.setBridgeRejectedHandler(onRejected);
    const client = fakeTransport({ state: 'disconnected' });
    (client.connect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('CDP WebSocket connection failed')
    );

    await expect(
      mgr.connect(client, { url: 'ws://localhost:5710/cdp', protocols: 'slicc.bridge.v1.stale' })
    ).rejects.toBeInstanceOf(CdpBridgeRejectedError);

    await expect(mgr.ensureConnected(hostFor(client))).rejects.toBeInstanceOf(
      CdpBridgeRejectedError
    );
    await expect(mgr.ensureConnected(hostFor(client))).rejects.toBeInstanceOf(
      CdpBridgeRejectedError
    );

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledTimes(1);
  });

  it('ensureConnected restores local and clears sessions for the dropped transport', async () => {
    const mgr = new CdpConnectionManager();
    mgr.primeConnectOptions({ url: 'ws://localhost:5710/cdp' });
    const dropped = fakeTransport({ state: 'disconnected' });
    const local = fakeTransport({ state: 'disconnected' });
    const restoreLocalAfterRemoteDrop = vi.fn(() => {
      // Host swaps the active client to local.
    });
    const clearSessionsForTransport = vi.fn();
    let current = dropped;

    await mgr.ensureConnected({
      client: dropped,
      restoreLocalAfterRemoteDrop: () => {
        restoreLocalAfterRemoteDrop();
        current = local;
      },
      clearSessionsForTransport,
      getClient: () => current,
    });

    expect(restoreLocalAfterRemoteDrop).toHaveBeenCalledTimes(1);
    expect(clearSessionsForTransport).toHaveBeenCalledWith(dropped);
    expect(local.connect).toHaveBeenCalledTimes(1);
    expect(dropped.connect).not.toHaveBeenCalled();
  });

  it('ensureLocalConnected is a no-op while connected', async () => {
    const mgr = new CdpConnectionManager();
    const local = fakeTransport({ state: 'connected' });
    await mgr.ensureLocalConnected(local);
    expect(local.connect).not.toHaveBeenCalled();
  });

  it('banner handlers that throw do not break the CDP path', async () => {
    const mgr = new CdpConnectionManager();
    const client = fakeTransport({ state: 'disconnected', superseded: true });
    mgr.setSupersededHandler(() => {
      throw new Error('banner boom');
    });
    await expect(mgr.ensureConnected(hostFor(client))).resolves.toBeUndefined();
  });
});
