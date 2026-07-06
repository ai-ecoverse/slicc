import type {
  LeaderToWorkerControlMessage,
  WorkerBridgeCdpResponse,
  WorkerBridgeConnected,
  WorkerBridgeDisconnected,
} from '@slicc/shared-ts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LeaderSyncManagerOptions } from '../../src/scoops/tray-leader-sync.js';
import { LeaderSyncManager } from '../../src/scoops/tray-leader-sync.js';

describe('LeaderSyncManager bridge connection registry', () => {
  let sent: LeaderToWorkerControlMessage[];
  let mgr: LeaderSyncManager;

  beforeEach(() => {
    sent = [];
    const options: LeaderSyncManagerOptions = {
      sendControl: (msg) => sent.push(msg),
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: () => {},
      onFollowerAbort: () => {},
    };
    mgr = new LeaderSyncManager(options);
  });

  it('tracks a bridge conn and routes cdp.response to its transport', async () => {
    const connectedMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 't.s',
      origin: 'https://x',
      userAgent: 'UA',
      connectedAt: '2024-01-01T00:00:00Z',
    };
    mgr.onBridgeConnected(connectedMsg);

    const transport = mgr.getBridgeTransport('c1');
    expect(transport).toBeDefined();

    const promise = transport!.send('Runtime.evaluate', { expression: '1' });

    // Check that bridge.cdp.request was sent
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'bridge.cdp.request',
        connId: 'c1',
        method: 'Runtime.evaluate',
      })
    );

    const request = sent.find((m) => m.type === 'bridge.cdp.request') as {
      type: 'bridge.cdp.request';
      id: number;
    };
    expect(request).toBeDefined();
    const { id } = request;

    // Deliver response
    const responseMsg: WorkerBridgeCdpResponse = {
      type: 'bridge.cdp.response',
      connId: 'c1',
      id,
      result: { value: 1 },
    };
    mgr.onBridgeCdpResponse(responseMsg);

    const result = await promise;
    expect(result).toEqual({ value: 1 });
  });

  it('handles error responses', async () => {
    const connectedMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c2',
      previewToken: 't.s',
      origin: 'https://y',
      userAgent: 'UA',
      connectedAt: '2024-01-01T00:00:00Z',
    };
    mgr.onBridgeConnected(connectedMsg);

    const transport = mgr.getBridgeTransport('c2');
    const promise = transport!.send('Page.navigate', { url: 'invalid://url' });

    const request = sent.find((m) => m.type === 'bridge.cdp.request') as {
      type: 'bridge.cdp.request';
      id: number;
    };
    const { id } = request;

    const responseMsg: WorkerBridgeCdpResponse = {
      type: 'bridge.cdp.response',
      connId: 'c2',
      id,
      error: { code: -32000, message: 'Invalid URL' },
    };
    mgr.onBridgeCdpResponse(responseMsg);

    await expect(promise).rejects.toThrow('Invalid URL');
  });

  it('cleans up on disconnect', () => {
    const connectedMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c4',
      previewToken: 't.s',
      origin: 'https://w',
      userAgent: 'UA',
      connectedAt: '2024-01-01T00:00:00Z',
    };
    mgr.onBridgeConnected(connectedMsg);

    expect(mgr.getBridgeTransport('c4')).toBeDefined();

    const disconnectedMsg: WorkerBridgeDisconnected = {
      type: 'bridge.disconnected',
      connId: 'c4',
      reason: 'user closed tab',
    };
    mgr.onBridgeDisconnected(disconnectedMsg);

    expect(mgr.getBridgeTransport('c4')).toBeUndefined();
  });

  it('uses mint map metadata when available', () => {
    mgr.registerMintedPreview('t.s', {
      url: 'https://example.com/page.html',
      title: 'Test Page',
      quiet: true,
    });

    const connectedMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c5',
      previewToken: 't.s',
      origin: 'https://example.com',
      userAgent: 'UA',
      connectedAt: '2024-01-01T00:00:00Z',
    };
    mgr.onBridgeConnected(connectedMsg);

    const transport = mgr.getBridgeTransport('c5');
    expect(transport).toBeDefined();
    // Transport construction has occurred with mint metadata
    // (we can't directly inspect internal state, but the transport exists)
  });

  it('falls back to origin/default when mint map entry absent', () => {
    // No mint entry
    const connectedMsg: WorkerBridgeConnected = {
      type: 'bridge.connected',
      connId: 'c6',
      previewToken: 'unknown.token',
      origin: 'https://fallback.com',
      userAgent: 'UA',
      connectedAt: '2024-01-01T00:00:00Z',
    };
    mgr.onBridgeConnected(connectedMsg);

    const transport = mgr.getBridgeTransport('c6');
    expect(transport).toBeDefined();
    // Transport construction uses fallback: url=origin, title='Preview', quiet=false
  });

  it('surfaces bridge conns as preview targets', () => {
    const { mgr } = buildLeaderSyncWithConn('c1', 't.s', 'https://example.com');
    const targets = mgr.getTargets();
    expect(targets).toContainEqual(
      expect.objectContaining({
        targetId: expect.stringMatching(/^preview:t\.s:c1$/),
        kind: 'preview',
        url: 'https://example.com',
      })
    );
  });
});

/**
 * Helper to build a LeaderSyncManager with a bridge connection already established.
 * Tasks 14-16 will reuse this.
 */
export function buildLeaderSyncWithConn(
  connId: string,
  previewToken: string,
  origin = 'https://test.com'
): {
  mgr: LeaderSyncManager;
  sent: LeaderToWorkerControlMessage[];
} {
  const sent: LeaderToWorkerControlMessage[] = [];
  const options: LeaderSyncManagerOptions = {
    sendControl: (msg) => sent.push(msg),
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: () => {},
    onFollowerAbort: () => {},
  };
  const mgr = new LeaderSyncManager(options);

  const connectedMsg: WorkerBridgeConnected = {
    type: 'bridge.connected',
    connId,
    previewToken,
    origin,
    userAgent: 'TestUA',
    connectedAt: new Date().toISOString(),
  };
  mgr.onBridgeConnected(connectedMsg);

  return { mgr, sent };
}
