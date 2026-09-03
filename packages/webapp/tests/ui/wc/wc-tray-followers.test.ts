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
      window: { dispatchEvent },
      workUnits: { subscribeList: () => () => undefined },
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

    expect(floatbar.setAttribute).not.toHaveBeenCalledWith('label', expect.anything());
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
      workUnits: { subscribeList: () => () => undefined },
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

    // The count lives in the followers segment only — label is not mutated.
    expect(floatbar.setAttribute).not.toHaveBeenCalledWith('label', expect.anything());
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

describe('WC tray follower message routing (#2382)', () => {
  /**
   * The leader adapter under test, over a fake kernel client and a fake
   * `WorkUnitClient`. Only the pieces `onFollowerMessage` / `onFollowerAbort`
   * touch are real.
   */
  function makeLeaderOptions(leaderSelectedJid: string | null) {
    const sends: Array<{ id: string; text: string; messageId?: string }> = [];
    const stops: string[] = [];
    const addUserMessage = vi.fn();
    const deps = {
      refs: { floatbar: { setAttribute: vi.fn() }, switcher: { scoops: [] } },
      client: {
        selectedScoopJid: leaderSelectedJid,
        getScoops: () => [],
        getMessagesForScoop: () => [],
      },
      workUnits: {
        send: (id: string, input: { text: string; messageId?: string }) => {
          sends.push({ id, text: input.text, messageId: input.messageId });
          return Promise.resolve();
        },
        signal: (id: string) => {
          stops.push(id);
          return Promise.resolve();
        },
        subscribeList: () => () => undefined,
      },
      agentHandle: { sendMessage: vi.fn(), onEvent: () => () => undefined, stop: vi.fn() },
      getController: () => ({ addUserMessage }),
      getSelectedJid: () => leaderSelectedJid ?? 'cone',
      window: { dispatchEvent: vi.fn() },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      sprinkleManager: { available: () => [], opened: () => [] },
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
    // A real manager with no followers: `onFollowerMessage` also refreshes the
    // worker-realm follower shim, which walks the whole capability surface.
    const sync = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => leaderSelectedJid ?? 'cone',
      onFollowerMessage: () => {},
      onFollowerAbort: () => {},
    });
    const broadcastUserMessage = vi
      .spyOn(sync, 'broadcastUserMessage')
      .mockImplementation(() => {});
    const state = {
      leader: { sync, peers: { getPeers: () => [] } },
      follower: null,
      persistenceGuard: { activate: vi.fn(), deactivate: vi.fn() },
      lockRelease: null,
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[1];
    const options = createLeaderOptionsFactory(
      deps,
      state,
      {} as Parameters<typeof createLeaderOptionsFactory>[2]
    )('https://tray.example');
    return { addUserMessage, broadcastUserMessage, options, sends, stops };
  }

  it('delivers a follower’s prompt to the unit that follower is reading', async () => {
    const { options, sends, addUserMessage, broadcastUserMessage } = makeLeaderOptions('cone_a');

    options.onFollowerMessage('hi from B', 'fm1', undefined, { targetScoopJid: 'cone_b' });
    await Promise.resolve();

    // The leader is displaying A; the follower is reading B. The prompt lands
    // in B, and A's transcript — the one on this screen — gets no bubble for a
    // message that is not its own.
    expect(sends).toEqual([{ id: 'cone_b', text: 'hi from B', messageId: 'fm1' }]);
    expect(addUserMessage).not.toHaveBeenCalled();
    // The echo still goes out: followers reading B need to see it.
    expect(broadcastUserMessage).toHaveBeenCalledWith('hi from B', 'fm1', undefined);
  });

  it('still renders the bubble when the follower is reading what the leader shows', async () => {
    const { options, sends, addUserMessage } = makeLeaderOptions('cone_a');

    options.onFollowerMessage('same unit', 'fm2', undefined, { targetScoopJid: 'cone_a' });
    await Promise.resolve();

    expect(sends).toEqual([{ id: 'cone_a', text: 'same unit', messageId: 'fm2' }]);
    expect(addUserMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the leader’s selection for a peer that named no unit', async () => {
    const { options, sends, addUserMessage } = makeLeaderOptions('cone_a');

    options.onFollowerMessage('no target', 'fm3');
    await Promise.resolve();

    expect(sends).toEqual([{ id: 'cone_a', text: 'no target', messageId: 'fm3' }]);
    expect(addUserMessage).toHaveBeenCalledTimes(1);
  });

  it('aborts the unit the follower is reading, not the one on screen', async () => {
    const { options, stops } = makeLeaderOptions('cone_a');

    options.onFollowerAbort('cone_b');
    await Promise.resolve();

    expect(stops).toEqual(['cone_b']);
  });
});
