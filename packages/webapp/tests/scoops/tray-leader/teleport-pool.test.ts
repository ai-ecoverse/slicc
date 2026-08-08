import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
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
  const onTeleportEligibilityChanged = vi.fn();
  const pool = new TeleportPool(context, {
    cleanupOrphanedRemoteTransports,
    onTeleportEligibilityChanged,
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
  return { cleanupOrphanedRemoteTransports, followers, onTeleportEligibilityChanged, pool, sent };
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

  it('treats advertised capabilities as authoritative for every kind', () => {
    // An iOS-style browser target that says network:false must be excluded
    // even though its kind is not cherry — the historical cherry-only check
    // let it through and teleport "succeeded" with zero cookies.
    const targets = [
      {
        targetId: 'ios-tab',
        kind: 'browser' as const,
        capabilities: { navigate: true, network: false, screenshot: true },
      },
      {
        targetId: 'desktop-tab',
        kind: 'browser' as const,
        capabilities: { navigate: true, network: true, screenshot: true },
      },
      // Legacy peer: no capabilities advertised — optimistic acceptance stays.
      { targetId: 'legacy-tab', kind: 'browser' as const },
    ];
    expect(
      selectTeleportPool(targets, { requireNetwork: true }).map((target) => target.targetId)
    ).toEqual(['desktop-tab', 'legacy-tab']);
  });

  it('gates zero-target followers on the hello browser capability', () => {
    const { followers, pool } = createHarness();
    // Exec-only follower (Go CLI): connected, mapped, zero advertised targets,
    // no browser capability. Its tab.open would hang — must never be selected.
    followers.followers.set('cli-bootstrap', {
      bootstrapId: 'cli-bootstrap',
      runtime: 'slicc-cli',
      floatType: 'unknown',
      lastActivity: 99999,
      peerCapabilities: { exec: true },
      sync: { send: vi.fn(() => true) },
    } as unknown as ConnectedFollower);
    followers.runtimeToBootstrap.set('cli-runtime', 'cli-bootstrap');
    expect(pool.getBestFollowerForTeleport()).toBeNull();

    // A browser follower that has said hello but not yet advertised targets
    // IS eligible: the capability vouches for it during the advertise window.
    const cli = followers.followers.get('cli-bootstrap');
    if (!cli) throw new Error('missing follower');
    cli.peerCapabilities = { exec: true, browser: true };
    expect(pool.getBestFollowerForTeleport()).toEqual(
      expect.objectContaining({ runtimeId: 'cli-runtime', bootstrapId: 'cli-bootstrap' })
    );
  });

  it('requires an explicit network-capable target from iOS followers (skew guard)', () => {
    const { followers, pool } = createHarness();
    followers.followers.set('ios-bootstrap', {
      bootstrapId: 'ios-bootstrap',
      runtime: 'slicc-ios',
      floatType: 'ios',
      lastActivity: 99999,
      peerCapabilities: { exec: true, browser: true },
      sync: { send: vi.fn(() => true) },
    } as unknown as ConnectedFollower);
    // Pre-capability iOS app: bare targets, silent Network no-op. Hello
    // capability alone must NOT qualify it.
    pool.handleFollowerTargetsAdvertise('ios-bootstrap', {
      type: 'targets.advertise',
      runtimeId: 'ios-runtime',
      targets: [{ targetId: 'wk1', title: 'Tab', url: 'https://example.com' }],
    });
    expect(pool.getBestFollowerForTeleport()).toBeNull();
    expect(pool.getTeleportEligibleBootstrapIds().has('ios-bootstrap')).toBe(false);

    // Capability-advertising iOS app with a real Network domain qualifies.
    pool.handleFollowerTargetsAdvertise('ios-bootstrap', {
      type: 'targets.advertise',
      runtimeId: 'ios-runtime',
      targets: [
        {
          targetId: 'wk1',
          title: 'Tab',
          url: 'https://example.com',
          kind: 'browser',
          capabilities: { navigate: true, network: true, screenshot: true },
        },
      ],
    });
    expect(pool.getBestFollowerForTeleport()).toEqual(
      expect.objectContaining({ runtimeId: 'ios-runtime', bootstrapId: 'ios-bootstrap' })
    );
  });

  it('notifies on every advertise, because eligibility flips without a follower-count change', () => {
    // Found live on the simulator: iOS joins with no tabs open, so it
    // advertises nothing and is correctly ineligible. Opening its first tab
    // makes it capable — but kernel-side selection reads a cached snapshot,
    // which nothing refreshed until an unrelated user message happened to fire,
    // so `teleport` skipped a follower that could serve it.
    const { followers, onTeleportEligibilityChanged, pool } = createHarness();
    followers.followers.set('ios-bootstrap', {
      bootstrapId: 'ios-bootstrap',
      runtime: 'slicc-ios',
      floatType: 'ios',
      lastActivity: 99999,
      peerCapabilities: { exec: true, browser: true },
      sync: { send: vi.fn(() => true) },
    } as unknown as ConnectedFollower);

    pool.handleFollowerTargetsAdvertise('ios-bootstrap', {
      type: 'targets.advertise',
      runtimeId: 'ios-runtime',
      targets: [],
    });
    expect(onTeleportEligibilityChanged).toHaveBeenCalledTimes(1);
    expect(pool.getTeleportEligibleBootstrapIds().has('ios-bootstrap')).toBe(false);

    pool.handleFollowerTargetsAdvertise('ios-bootstrap', {
      type: 'targets.advertise',
      runtimeId: 'ios-runtime',
      targets: [
        {
          targetId: 'wk1',
          title: 'Tab',
          url: 'https://example.com',
          kind: 'browser',
          capabilities: { navigate: true, network: true, screenshot: true },
        },
      ],
    });
    expect(onTeleportEligibilityChanged).toHaveBeenCalledTimes(2);
    expect(pool.getTeleportEligibleBootstrapIds().has('ios-bootstrap')).toBe(true);
    expect(pool.getTeleportEligibleBootstrapIds().has('ios-bootstrap')).toBe(true);
  });
});
