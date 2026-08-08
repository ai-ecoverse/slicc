import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  FollowerRegistry,
  type FollowerRegistryOptions,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  sent: string[] = [];
  private readonly messageListeners: ((event: { data: string }) => void)[] = [];

  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (() => void) | ((event: { data: string }) => void)
  ): void {
    if (type === 'message')
      this.messageListeners.push(listener as (event: { data: string }) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }
}

function createLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createRegistry(overrides: Partial<FollowerRegistryOptions> = {}): FollowerRegistry {
  return new FollowerRegistry({
    log: createLog(),
    onMessage: vi.fn(),
    ...overrides,
  });
}

describe('FollowerRegistry', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('adds and removes followers and reports follower count changes', () => {
    const onFollowerCountChanged = vi.fn();
    const registry = createRegistry({ onFollowerCountChanged });
    const first = new FakeChannel();
    const second = new FakeChannel();

    registry.addFollower('b1', first);
    registry.addFollower('b2', second);
    registry.removeFollower('b1');
    registry.removeFollower('b2');

    expect(onFollowerCountChanged.mock.calls.map(([count]) => count)).toEqual([1, 2, 1, 0]);
    expect(first.readyState).toBe('closed');
    expect(second.readyState).toBe('closed');
    expect(registry.followers.size).toBe(0);
  });

  it('removes a dead follower before invoking onFollowerDead', () => {
    const calls: string[] = [];
    const channel = new FakeChannel();
    const registry = createRegistry({
      onFollowerDead: (bootstrapId) => {
        calls.push(bootstrapId);
        expect(registry.followers.has(bootstrapId)).toBe(false);
      },
    });
    registry.addFollower('dead', channel);
    channel.readyState = 'closed';

    vi.advanceTimersByTime(40_000);

    expect(calls).toEqual(['dead']);
  });

  it('resolves advertised and canonical runtime ids', () => {
    const registry = createRegistry();
    registry.addFollower('cli-1', new FakeChannel());
    registry.addFollower('browser-1', new FakeChannel());
    registry.setRuntimeId('runtime-browser', 'browser-1');

    expect(registry.resolveFollowerByRuntimeId('runtime-browser')?.bootstrapId).toBe('browser-1');
    expect(registry.resolveFollowerByRuntimeId('follower-cli-1')?.bootstrapId).toBe('cli-1');
    expect(registry.runtimeIdForBootstrap('browser-1')).toBe('runtime-browser');
    expect(registry.resolveFollowerByRuntimeId('missing')).toBeNull();

    registry.removeFollower('cli-1');
    registry.removeFollower('browser-1');
  });

  it('filters followers by exec and browser capability', () => {
    const registry = createRegistry();
    const exec = registry.addFollower('exec', new FakeChannel());
    registry.addFollower('browser', new FakeChannel());
    exec.peerCapabilities = { exec: true };
    exec.peerMotd = 'remote shell';
    registry.setRuntimeId('runtime-browser', 'browser');

    expect(registry.getExecCapableBootstrapIds()).toEqual(new Set(['exec']));
    expect(registry.getBrowserCapableBootstrapIds()).toEqual(new Set(['browser']));
    expect(registry.getFollowerMotds()).toEqual(new Map([['exec', 'remote shell']]));

    registry.removeFollower('exec');
    registry.removeFollower('browser');
  });

  it('exposes follower metadata and live keepalive health through a read snapshot', () => {
    const registry = createRegistry();
    const follower = registry.addFollower('b1', new FakeChannel(), {
      runtime: 'slicc-electron',
      connectedAt: '2026-08-03T08:00:00.000Z',
    });
    follower.hostOrigin = 'https://host.example';
    follower.selectedScoopJid = 'research';

    expect(registry.getFollowerDetails()).toEqual([
      expect.objectContaining({
        bootstrapId: 'b1',
        runtime: 'slicc-electron',
        connectedAt: '2026-08-03T08:00:00.000Z',
        floatType: 'electron',
        hostOrigin: 'https://host.example',
        selectedScoopJid: 'research',
        health: 'live',
      }),
    ]);

    vi.advanceTimersByTime(40_000);
    expect(registry.getFollowerDetails()[0].health).toBe('stalled');

    follower.keepalive.receivePong();
    expect(registry.getFollowerDetails()[0].health).toBe('live');
    registry.removeFollower('b1');
  });

  it('throttles repeated broadcast send-error logs per follower', () => {
    const log = createLog();
    const registry = createRegistry({ log });
    const follower = registry.addFollower('stuck', new FakeChannel());
    follower.sync.send = vi.fn(() => {
      throw new Error('stuck channel');
    });
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(60_101);

    registry.broadcastToAllFollowers({ type: 'status', scoopStatus: 'one', scoopJid: 'cone' });
    registry.broadcastToAllFollowers({ type: 'status', scoopStatus: 'two', scoopJid: 'cone' });
    registry.broadcastToAllFollowers({ type: 'status', scoopStatus: 'three', scoopJid: 'cone' });

    expect(log.error).toHaveBeenCalledTimes(2);
    registry.removeFollower('stuck');
  });
});
