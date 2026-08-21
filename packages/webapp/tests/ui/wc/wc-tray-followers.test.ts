import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaderSyncManager } from '../../../src/scoops/tray-leader-sync.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';
import type { PageLeaderTrayHandle } from '../../../src/ui/page-leader-tray.js';
import { buildFollowersSection } from '../../../src/ui/wc/wc-monitor.js';
import {
  createLeaderOptionsFactory,
  getLeaderConnectedFollowers,
} from '../../../src/ui/wc/wc-tray.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  addEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
}

describe('WC tray connected follower mapping', () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maps stalled metadata and a capability-less transient CLI', () => {
    const handle = {
      sync: {
        getExecCapableBootstrapIds: () => new Set(['browser-1']),
        getBrowserCapableBootstrapIds: () => new Set(['browser-1']),
        getTeleportEligibleBootstrapIds: () => new Set(['browser-1']),
        getFollowerMotds: () => new Map([['browser-1', 'remote browser']]),
        getSprinkleInstances: () => [],
        getFollowerDetails: () => [
          {
            bootstrapId: 'browser-1',
            runtime: 'slicc-extension-offscreen',
            connectedAt: '2026-08-03T08:00:00.000Z',
            lastActivity: 1,
            floatType: 'extension' as const,
            hostOrigin: 'https://host.example',
            selectedScoopJid: 'research',
            health: 'stalled' as const,
          },
          {
            bootstrapId: 'cli-1',
            runtime: 'slicc-cli',
            connectedAt: '2026-08-03T08:01:00.000Z',
            lastActivity: 2,
            floatType: 'unknown' as const,
            health: 'live' as const,
          },
        ],
      },
      peers: {
        getPeers: () => [
          {
            controllerId: 'controller-browser',
            bootstrapId: 'browser-1',
            attempt: 1,
            state: 'connected' as const,
            connectedAt: '2026-08-03T08:00:00.000Z',
            runtime: 'slicc-extension-offscreen',
          },
          {
            controllerId: 'controller-cli',
            bootstrapId: 'cli-1',
            attempt: 1,
            state: 'connected' as const,
            connectedAt: '2026-08-03T08:01:00.000Z',
            runtime: 'slicc-cli',
          },
        ],
      },
    } as unknown as PageLeaderTrayHandle;

    expect(getLeaderConnectedFollowers(handle)).toEqual([
      {
        runtimeId: 'follower-browser-1',
        bootstrapId: 'browser-1',
        runtime: 'slicc-extension-offscreen',
        connectedAt: '2026-08-03T08:00:00.000Z',
        lastActivity: 1,
        floatType: 'extension',
        hostOrigin: 'https://host.example',
        selectedScoopJid: 'research',
        health: 'stalled',
        peerState: 'connected',
        exec: true,
        cdp: true,
        teleportEligible: true,
        motd: 'remote browser',
      },
      {
        runtimeId: 'follower-cli-1',
        bootstrapId: 'cli-1',
        runtime: 'slicc-cli',
        connectedAt: '2026-08-03T08:01:00.000Z',
        lastActivity: 2,
        floatType: 'unknown',
        hostOrigin: undefined,
        selectedScoopJid: undefined,
        health: 'live',
        peerState: 'connected',
        exec: false,
        cdp: false,
        // Exec-only CLI follower: never a teleport destination.
        teleportEligible: false,
        motd: undefined,
      },
    ]);
  });

  it('keeps connecting rows uncounted through connect and death', () => {
    let floatbarCount = 0;
    let peerState: 'connecting' | 'connected' = 'connecting';
    const sync = new LeaderSyncManager({
      sendControl: vi.fn(),
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
      onFollowerCountChanged: (count) => {
        floatbarCount = count;
      },
    });
    const channel = new FakeChannel();
    const handle = {
      sync,
      peers: {
        getPeers: () => [
          {
            bootstrapId: 'follower-1',
            state: peerState,
            runtime: 'slicc-cli',
          },
        ],
      },
    } as unknown as PageLeaderTrayHandle;

    let followers = getLeaderConnectedFollowers(handle);
    let section = buildFollowersSection(followers);
    expect(followers).toHaveLength(1);
    expect(followers[0].peerState).toBe('connecting');
    expect(section.rows[0].status).toBe('idle');
    expect(section.count).toBe(floatbarCount);
    expect(floatbarCount).toBe(0);

    peerState = 'connected';
    sync.addFollower('follower-1', channel, { runtime: 'slicc-cli' });
    followers = getLeaderConnectedFollowers(handle);
    section = buildFollowersSection(followers);
    expect(followers).toHaveLength(1);
    expect(followers[0]).toMatchObject({
      runtimeId: 'follower-1',
      health: 'live',
      peerState: 'connected',
    });
    expect(section.rows[0].status).toBe('active');
    expect(section.count).toBe(floatbarCount);
    expect(floatbarCount).toBe(1);

    channel.readyState = 'closed';
    vi.advanceTimersByTime(40_000);
    followers = getLeaderConnectedFollowers(handle);
    section = buildFollowersSection(followers);
    expect(followers).toHaveLength(0);
    expect(section.count).toBe(floatbarCount);
    expect(floatbarCount).toBe(0);
  });

  it('uses the registry count for the floatbar while mirroring connecting rows', () => {
    const floatbar = { setAttribute: vi.fn() };
    const dispatchEvent = vi.fn();
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const handle = {
      sync: {
        getExecCapableBootstrapIds: () => new Set(),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map(),
        getFollowerDetails: () => [],
        getSprinkleInstances: () => [],
      },
      peers: {
        getPeers: () => [
          {
            bootstrapId: 'pending-peer',
            state: 'connecting' as const,
            runtime: 'slicc-cli',
          },
        ],
      },
    } as unknown as PageLeaderTrayHandle;
    const deps = {
      refs: { floatbar },
      client: {},
      baseFloatLabel: 'standalone · live',
      window: { dispatchEvent },
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
    const state = {
      leader: handle,
      follower: null,
      persistenceGuard: {
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
      lockRelease: null,
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[1];
    const options = createLeaderOptionsFactory(
      deps,
      state,
      {} as Parameters<typeof createLeaderOptionsFactory>[2]
    )('https://tray.example');

    options.onFollowerCountChanged?.(0);

    expect(floatbar.setAttribute).toHaveBeenCalledWith('label', 'standalone · live');
    expect(storage.setItem).toHaveBeenCalledWith(
      'slicc.leaderTrayFollowers',
      expect.stringContaining('"peerState":"connecting"')
    );
    // A connecting peer is mirrored to the shim but is NOT a follower yet, so
    // the floatbar segment stays empty and the sync dialog hears about it.
    expect((floatbar as unknown as { followers: unknown[] }).followers).toEqual([]);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'slicc:followers-changed' })
    );
  });

  it('feeds the floatbar one HUD row per connected follower', () => {
    const floatbar = { setAttribute: vi.fn() };
    const storage = { setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const handle = {
      sync: {
        getExecCapableBootstrapIds: () => new Set(['cli-1']),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map([['cli-1', 'lars@build-box']]),
        getSprinkleInstances: () => [],
        getFollowerDetails: () => [
          {
            bootstrapId: 'cli-1',
            runtime: 'slicc-cli',
            connectedAt: new Date().toISOString(),
            lastActivity: 1,
            floatType: 'unknown' as const,
            health: 'live' as const,
          },
        ],
      },
      peers: {
        getPeers: () => [
          { bootstrapId: 'cli-1', state: 'connected' as const, runtime: 'slicc-cli' },
        ],
      },
    } as unknown as PageLeaderTrayHandle;
    const deps = {
      refs: { floatbar },
      client: {},
      baseFloatLabel: 'standalone · live',
      window: { dispatchEvent: vi.fn() },
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
    const state = {
      leader: handle,
      follower: null,
      persistenceGuard: { activate: vi.fn(), deactivate: vi.fn() },
      lockRelease: null,
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[1];

    createLeaderOptionsFactory(
      deps,
      state,
      {} as Parameters<typeof createLeaderOptionsFactory>[2]
    )('https://tray.example').onFollowerCountChanged?.(1);

    // The count no longer rides in the label string — it has its own segment.
    expect(floatbar.setAttribute).toHaveBeenCalledWith('label', 'tray · live');
    expect((floatbar as unknown as { followers: unknown[] }).followers).toEqual([
      {
        id: 'follower-cli-1',
        icon: 'terminal',
        title: 'CLI · cli-1',
        detail: 'lars@build-box',
        state: 'active',
        stateText: 'connected 0s',
        chips: ['can run commands'],
      },
    ]);
  });
});
