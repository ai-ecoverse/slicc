import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger.js';
import { CDPRouter } from '../../../src/scoops/tray-leader/cdp-router.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function addFollower(registry: FollowerRegistry, bootstrapId: string) {
  const sent: LeaderToFollowerMessage[] = [];
  const send = vi.fn((message: LeaderToFollowerMessage) => {
    sent.push(message);
    return true;
  });
  registry.followers.set(bootstrapId, {
    bootstrapId,
    sync: { send, close: vi.fn() },
    unsubscribe: vi.fn(),
    keepalive: { stop: vi.fn() },
  } as unknown as ConnectedFollower);
  return { sent };
}

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = createLog();
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  };
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const router = new CDPRouter(context, { getBridgeTransport: () => undefined });
  return { followers, router };
}

describe('CDPRouter', () => {
  it('reassembles out-of-order chunked responses before forwarding them', () => {
    const { followers, router } = createHarness();
    const requester = addFollower(followers, 'requester');
    const target = addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    router.forwardCDPRequest(
      'request-1',
      'runtime-target',
      'tab-1',
      'Runtime.evaluate',
      { expression: '1 + 1' },
      undefined,
      'requester'
    );
    expect(target.sent).toEqual([
      expect.objectContaining({ type: 'cdp.request', requestId: 'request-1' }),
    ]);

    const result = { result: { value: 'chunked-value' } };
    const serialized = JSON.stringify(result);
    const midpoint = Math.floor(serialized.length / 2);
    router.handleCDPResponse({
      type: 'cdp.response',
      requestId: 'request-1',
      chunkData: serialized.slice(midpoint),
      chunkIndex: 1,
      totalChunks: 2,
    });
    expect(requester.sent).toEqual([]);

    router.handleCDPResponse({
      type: 'cdp.response',
      requestId: 'request-1',
      chunkData: serialized.slice(0, midpoint),
      chunkIndex: 0,
      totalChunks: 2,
    });
    expect(requester.sent).toEqual([{ type: 'cdp.response', requestId: 'request-1', result }]);
  });

  it('disconnect cleanup rejects pending transport requests before runtime removal', async () => {
    const cleanupOrder: string[] = [];
    let followers!: FollowerRegistry;
    const onRemoteTransportsCleaned = vi.fn((runtimeId: string) => {
      cleanupOrder.push('transport');
      expect(followers.runtimeToBootstrap.has(runtimeId)).toBe(true);
    });
    const harness = createHarness({ onRemoteTransportsCleaned });
    followers = harness.followers;
    addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    followers.onFollowerRemoved({
      removeRuntime: () => cleanupOrder.push('registry'),
    });
    const transport = harness.router.createRemoteTransport('runtime-target', 'tab-1');
    const pending = transport.send('Page.navigate', { url: 'https://example.com' });

    followers.removeFollower('target');

    await expect(pending).rejects.toThrow('Transport disconnected');
    expect(transport.state).toBe('disconnected');
    expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('runtime-target');
    expect(cleanupOrder).toEqual(['transport', 'registry']);
    expect(followers.runtimeToBootstrap.has('runtime-target')).toBe(false);
  });
});
