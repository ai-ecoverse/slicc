import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { TabRouter } from '../../../src/scoops/tray-leader/tab-router.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const options = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
  } satisfies LeaderSyncManagerOptions;
  const context: LeaderSyncContext = {
    options,
    followers,
    log,
    sendControl: options.sendControl,
  };
  const router = new TabRouter(context, {
    getTargetEntries: () => [],
    isCherryTarget: (target) => target.kind === 'cherry',
  });
  return { followers, router };
}

function addFollower(registry: FollowerRegistry, bootstrapId: string) {
  const sent: LeaderToFollowerMessage[] = [];
  registry.followers.set(bootstrapId, {
    bootstrapId,
    sync: {
      send: vi.fn((message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      }),
      close: vi.fn(),
    },
    unsubscribe: vi.fn(),
    keepalive: { stop: vi.fn() },
  } as unknown as ConnectedFollower);
  return sent;
}

describe('TabRouter', () => {
  it('rejects a leader request when its target follower disconnects', async () => {
    const { followers, router } = createHarness();
    addFollower(followers, 'target');
    followers.setRuntimeId('runtime-target', 'target');
    const pending = router.openRemoteTab('runtime-target', 'https://example.com');

    followers.removeFollower('target');

    await expect(pending).rejects.toThrow('disconnected');
    expect(followers.runtimeToBootstrap.has('runtime-target')).toBe(false);
  });
});
