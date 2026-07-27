import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/core/logger.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import { selectTeleportPool, TeleportPool } from '../../../src/scoops/tray-leader/teleport-pool.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createHarness() {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as Logger;
  const followers = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  followers.followers.set('bootstrap', {
    bootstrapId: 'bootstrap',
    runtime: 'slicc-standalone',
    floatType: 'standalone',
    lastActivity: 42,
    sync: {
      send: vi.fn((message: LeaderToFollowerMessage) => {
        sent.push(message);
        return true;
      }),
    },
  } as unknown as ConnectedFollower);
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
  const cleanupOrphanedRemoteTransports = vi.fn();
  const pool = new TeleportPool(context, {
    cleanupOrphanedRemoteTransports,
    getPreviewTargetEntries: () => [
      {
        targetId: 'preview:token:conn',
        localTargetId: 'conn',
        runtimeId: 'preview',
        title: 'Preview',
        url: 'https://preview.example',
        isLocal: false,
        kind: 'preview',
      },
    ],
  });
  return { cleanupOrphanedRemoteTransports, followers, pool, sent };
}

describe('TeleportPool', () => {
  it('advertises connected browser targets but keeps preview targets leader-only', () => {
    const { cleanupOrphanedRemoteTransports, followers, pool, sent } = createHarness();
    pool.handleFollowerTargetsAdvertise('bootstrap', {
      type: 'targets.advertise',
      runtimeId: 'runtime',
      targets: [{ targetId: 'tab', title: 'Tab', url: 'https://example.com' }],
    });

    expect(cleanupOrphanedRemoteTransports).toHaveBeenCalledWith('runtime');
    expect(followers.runtimeToBootstrap.get('runtime')).toBe('bootstrap');
    expect(pool.getTargets().map((target) => target.kind)).toEqual(['browser', 'preview']);
    expect(sent.at(-1)).toEqual({
      type: 'targets.registry',
      targets: [expect.objectContaining({ targetId: 'runtime:tab', kind: 'browser' })],
    });
    expect(pool.getBestFollowerForTeleport()).toEqual(
      expect.objectContaining({
        runtimeId: 'runtime',
        bootstrapId: 'bootstrap',
        floatType: 'standalone',
      })
    );
  });

  it('excludes preview and non-network cherry targets from network teleports', () => {
    const targets = [
      { targetId: 'browser', kind: 'browser' as const },
      { targetId: 'preview', kind: 'preview' as const },
      {
        targetId: 'cherry',
        kind: 'cherry' as const,
        capabilities: { navigate: true, network: false, screenshot: true },
      },
    ];
    expect(
      selectTeleportPool(targets, { requireNetwork: true }).map((target) => target.targetId)
    ).toEqual(['browser']);
  });
});
