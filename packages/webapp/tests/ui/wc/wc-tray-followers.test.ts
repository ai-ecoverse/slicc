// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

// `buildFollowerOptions` now touches the composer chrome, which pulls the
// component library into this module graph.
installWcDomStubs();

import type { LeaderTrayRuntimeStatus } from '../../../src/scoops/tray-leader.js';
import { LeaderSyncManager } from '../../../src/scoops/tray-leader-sync.js';
import type { FollowerToLeaderMessage } from '../../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';
import { formatLeaderOutput } from '../../../src/shell/supplemental-commands/host-command.js';
import type { PageLeaderTrayHandle } from '../../../src/ui/page-leader-tray.js';
import { buildFollowersSection } from '../../../src/ui/wc/wc-monitor.js';
import {
  createLeaderOptionsFactory,
  getLeaderConnectedFollowers,
} from '../../../src/ui/wc/wc-tray.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  private readonly listeners: Array<(event: { data: string }) => void> = [];
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
  /** Deliver one follower→leader frame, as the data channel would. */
  simulateMessage(message: FollowerToLeaderMessage): void {
    const data = JSON.stringify(message);
    for (const listener of this.listeners) listener({ data });
  }
}

function activeLeaderStatus(): LeaderTrayRuntimeStatus {
  return {
    state: 'leader',
    session: {
      workerBaseUrl: 'https://tray.example.com/base',
      trayId: 'tray-123',
      createdAt: '2026-09-22T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/controller-1',
      joinUrl: 'https://tray.example.com/join/tray-123',
      webhookUrl: 'https://tray.example.com/webhooks/tray-123',
      leaderKey: 'leader-key',
      leaderWebSocketUrl: 'wss://tray.example.com/ws',
      runtime: 'slicc-standalone',
    },
    error: null,
  };
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
        getComputerCapableBootstrapIds: () => new Set(),
        getAbsorbedBootstrapIds: () => new Set(),
        getBrowserCapableBootstrapIds: () => new Set(['browser-1']),
        getTeleportEligibleBootstrapIds: () => new Set(['browser-1']),
        getFollowerMotds: () => new Map([['browser-1', 'remote browser']]),
        getPartnerMotds: () => new Map(),
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
        computer: false,
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
        computer: false,
        // Exec-only CLI follower: never a teleport destination.
        teleportEligible: false,
        motd: undefined,
      },
    ]);
  });

  it('shows a --computer Mac as one entry holding exec and native capture', () => {
    // `slicc <url> follow --computer` dials twice. The CLI keeps the roster
    // entry, the launcher lends it `computer`, and the launcher itself drops
    // off so `computer add ssh` has one unambiguous target (#3260).
    const peer = (bootstrapId: string, runtime: string) => ({
      controllerId: `controller-${bootstrapId}`,
      bootstrapId,
      attempt: 1,
      state: 'connected' as const,
      connectedAt: '2026-09-21T08:00:00.000Z',
      runtime,
    });
    const handle = {
      sync: {
        getExecCapableBootstrapIds: () => new Set(['cli-1']),
        getComputerCapableBootstrapIds: () => new Set(['cli-1', 'mac-1']),
        getAbsorbedBootstrapIds: () => new Set(['mac-1']),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map([['cli-1', 'slicc-cli exec target']]),
        getPartnerMotds: () => new Map(),
        getSprinkleInstances: () => [],
        getFollowerDetails: () => [
          {
            bootstrapId: 'cli-1',
            runtime: 'slicc-cli',
            connectedAt: '2026-09-21T08:00:00.000Z',
            lastActivity: 2,
            floatType: 'unknown' as const,
            health: 'live' as const,
          },
          {
            bootstrapId: 'mac-1',
            runtime: 'sliccstart-computer',
            connectedAt: '2026-09-21T08:00:01.000Z',
            lastActivity: 3,
            floatType: 'unknown' as const,
            health: 'live' as const,
          },
        ],
      },
      peers: {
        getPeers: () => [peer('cli-1', 'slicc-cli'), peer('mac-1', 'sliccstart-computer')],
      },
    } as unknown as PageLeaderTrayHandle;

    const followers = getLeaderConnectedFollowers(handle);
    expect(followers.map((f) => f.bootstrapId)).toEqual(['cli-1']);
    expect(followers[0]).toMatchObject({
      runtimeId: 'follower-cli-1',
      exec: true,
      computer: true,
      motd: 'slicc-cli exec target',
    });
  });

  it('prints a folded --computer Mac as one host entry tagged [ssh] [computer] (#3381)', () => {
    // End-to-end over the real registry: two peers say hello with the same
    // `pairId`, and the `host` renderer is what the agent reads. The unit-level
    // fold already passed while `host` on a real Mac still showed two entries
    // tagged `[ssh]` only, so the assertion that matters is on the OUTPUT.
    const sync = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
    });
    const cli = new FakeChannel();
    sync.addFollower('cli-1', cli, { runtime: 'slicc-cli' });
    cli.simulateMessage({
      type: 'hello',
      protocolVersion: 7,
      capabilities: { exec: true },
      motd: 'slicc-cli exec target · trieloff@Mac-Studio-2025 · darwin/arm64 · runner: bash -c',
      pairId: 'pair-2ffe3b1c593741a10e3286b12d9c6838',
    });
    const launcher = new FakeChannel();
    sync.addFollower('mac-1', launcher, { runtime: 'sliccstart-computer' });
    launcher.simulateMessage({
      type: 'hello',
      protocolVersion: 7,
      capabilities: { exec: false, computer: true },
      pairId: 'pair-2ffe3b1c593741a10e3286b12d9c6838',
    });
    const handle = {
      sync,
      peers: {
        getPeers: () => [
          { bootstrapId: 'cli-1', state: 'connected' as const, runtime: 'slicc-cli' },
          { bootstrapId: 'mac-1', state: 'connected' as const, runtime: 'sliccstart-computer' },
        ],
      },
    } as unknown as PageLeaderTrayHandle;

    const output = formatLeaderOutput(activeLeaderStatus(), getLeaderConnectedFollowers(handle));

    expect(output).toContain('  - follower-cli-1 (slicc-cli) [ssh] [computer]');
    expect(output).toContain(
      '      slicc-cli exec target · trieloff@Mac-Studio-2025 · darwin/arm64 · runner: bash -c'
    );
    // One machine, one entry: the absorbed launcher is neither a second row nor
    // an anonymous "other follower" tally.
    expect(output).not.toContain('mac-1');
    expect(output).not.toContain('other follower');
  });

  /** A real registry holding one `follow --computer` Mac: the CLI and its launcher. */
  function pairedMac(launcherHello: { computer: boolean; motd?: string }): PageLeaderTrayHandle {
    const sync = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
    });
    const cli = new FakeChannel();
    sync.addFollower('cli-1', cli, { runtime: 'slicc-cli' });
    cli.simulateMessage({
      type: 'hello',
      protocolVersion: 7,
      capabilities: { exec: true },
      motd: 'slicc-cli exec target · trieloff@Mac-Studio-2025 · darwin/arm64 · runner: bash -c',
      pairId: 'pair-2ffe3b1c593741a10e3286b12d9c6838',
    });
    const launcher = new FakeChannel();
    sync.addFollower('mac-1', launcher, { runtime: 'sliccstart-computer' });
    launcher.simulateMessage({
      type: 'hello',
      protocolVersion: 7,
      capabilities: { exec: false, computer: launcherHello.computer },
      motd: launcherHello.motd,
      pairId: 'pair-2ffe3b1c593741a10e3286b12d9c6838',
    });
    return {
      sync,
      peers: {
        getPeers: () => [
          { bootstrapId: 'cli-1', state: 'connected' as const, runtime: 'slicc-cli' },
          { bootstrapId: 'mac-1', state: 'connected' as const, runtime: 'sliccstart-computer' },
        ],
      },
    } as unknown as PageLeaderTrayHandle;
  }

  it('keeps the launcher MOTD naming a missing grant on the folded entry', () => {
    // The common `follow --computer` Mac: Screen Recording granted, Accessibility
    // not. The fold removes the launcher from the roster, so its MOTD — the only
    // place the missing grant is named — has to survive on the CLI's entry, and
    // beside the CLI's own line, not instead of it.
    const handle = pairedMac({
      computer: true,
      motd: 'Native screen capture on Mac-Studio-2025 — input needs Accessibility in System Settings → Privacy & Security',
    });
    const followers = getLeaderConnectedFollowers(handle);

    expect(followers.map((f) => f.bootstrapId)).toEqual(['cli-1']);
    expect(followers[0].motd).toContain('slicc-cli exec target');
    expect(followers[0].computerMotd).toContain('input needs Accessibility');

    const output = formatLeaderOutput(activeLeaderStatus(), followers);
    expect(output).toContain('  - follower-cli-1 (slicc-cli) [ssh] [computer]');
    expect(output).toContain('      slicc-cli exec target');
    expect(output).toContain(
      '      Native screen capture on Mac-Studio-2025 — input needs Accessibility'
    );
  });

  it('still folds an ungranted launcher into one entry, without lending it capture', () => {
    // An honest launcher with Screen Recording denied advertises
    // `computer: false`. It is still the same machine as the CLI (shared
    // `pairId`), so it folds — but the CLI's entry must not read `[computer]`,
    // or `computer add ssh` would skip the `screencapture` fallback again.
    const handle = pairedMac({
      computer: false,
      motd: 'Mac-Studio-2025: no native screen capture — grant Screen Recording in System Settings → Privacy & Security',
    });
    const followers = getLeaderConnectedFollowers(handle);

    expect(followers.map((f) => f.bootstrapId)).toEqual(['cli-1']);
    expect(followers[0]).toMatchObject({ exec: true, computer: false });
    expect(followers[0].computerMotd).toContain('grant Screen Recording');

    const output = formatLeaderOutput(activeLeaderStatus(), followers);
    expect(output).toContain('  - follower-cli-1 (slicc-cli) [ssh]\n');
    expect(output).not.toContain('[computer]');
    expect(output).not.toContain('mac-1');
    expect(output).toContain('grant Screen Recording');
  });

  it('names an unpaired computer-only follower instead of hiding it in the count (#3381)', () => {
    // A Sliccstart capture follower with no `pairId` (GUI Sliccstart, or a CLI
    // whose launcher lost its token) folds into nothing. It is still a machine
    // the agent can look at, so it gets a printable id — `computer add ssh`
    // accepts a computer-only follower.
    const sync = new LeaderSyncManager({
      sendControl: () => {},
      getMessages: () => [],
      getScoopJid: () => 'cone',
      onFollowerMessage: vi.fn(),
      onFollowerAbort: vi.fn(),
    });
    const launcher = new FakeChannel();
    sync.addFollower('mac-2', launcher, { runtime: 'sliccstart-computer' });
    launcher.simulateMessage({
      type: 'hello',
      protocolVersion: 7,
      capabilities: { exec: false, computer: true },
      motd: 'Native screen capture on Mac-Studio-2025',
    });
    const handle = {
      sync,
      peers: {
        getPeers: () => [
          { bootstrapId: 'mac-2', state: 'connected' as const, runtime: 'sliccstart-computer' },
        ],
      },
    } as unknown as PageLeaderTrayHandle;

    const output = formatLeaderOutput(activeLeaderStatus(), getLeaderConnectedFollowers(handle));

    expect(output).toContain('  - follower-mac-2 (sliccstart-computer) [computer]');
    expect(output).toContain('      Native screen capture on Mac-Studio-2025');
    expect(output).not.toContain('other follower');
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
        getComputerCapableBootstrapIds: () => new Set(),
        getAbsorbedBootstrapIds: () => new Set(),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map(),
        getPartnerMotds: () => new Map(),
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
        getComputerCapableBootstrapIds: () => new Set(),
        getAbsorbedBootstrapIds: () => new Set(),
        getBrowserCapableBootstrapIds: () => new Set(),
        getTeleportEligibleBootstrapIds: () => new Set(),
        getFollowerMotds: () => new Map([['cli-1', 'lars@build-box']]),
        getPartnerMotds: () => new Map(),
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
  function makeLeaderOptions(leaderSelectedJid: string | null, sendError?: Error) {
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
          return sendError ? Promise.reject(sendError) : Promise.resolve();
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
    return { addUserMessage, broadcastUserMessage, deps, options, sends, stops };
  }

  it('resolves an accepted outcome naming the unit once the kernel takes the prompt', async () => {
    const { options } = makeLeaderOptions('cone_a');
    const outcome = await options.onFollowerMessage('hi', 'fm4', undefined, {
      targetScoopJid: 'cone_b',
    });
    expect(outcome).toEqual({ scoopJid: 'cone_b', state: 'accepted' });
  });

  it('resolves a rejected outcome carrying the kernel error when the send fails', async () => {
    const { options, deps } = makeLeaderOptions('cone_a', new Error('kernel gone'));
    const outcome = await options.onFollowerMessage('hi', 'fm5', undefined, {
      targetScoopJid: 'cone_a',
    });
    expect(outcome).toEqual({ scoopJid: 'cone_a', state: 'rejected', error: 'kernel gone' });
    expect(deps.log.warn).toHaveBeenCalledWith('follower message delivery failed', {
      error: 'kernel gone',
    });
  });

  it('rejects at once when neither side has a unit to deliver to', async () => {
    const { options, deps, sends } = makeLeaderOptions(null);
    const outcome = await options.onFollowerMessage('lost', 'fm6');
    expect(sends).toEqual([]);
    // The local no-selection report still runs on the leader.
    expect(deps.agentHandle.sendMessage).toHaveBeenCalledWith('lost', 'fm6', undefined, undefined);
    expect(outcome).toMatchObject({ scoopJid: '', state: 'rejected', error: expect.any(String) });
  });

  it('delivers a follower’s prompt to the unit that follower is reading', async () => {
    const { options, sends, addUserMessage, broadcastUserMessage } = makeLeaderOptions('cone_a');

    options.onFollowerMessage('hi from B', 'fm1', undefined, { targetScoopJid: 'cone_b' });
    await Promise.resolve();

    // The leader is displaying A; the follower is reading B. The prompt lands
    // in B, and A's transcript — the one on this screen — gets no bubble for a
    // message that is not its own.
    expect(sends).toEqual([{ id: 'cone_b', text: 'hi from B', messageId: 'fm1' }]);
    expect(addUserMessage).not.toHaveBeenCalled();
    // The echo still goes out, and names B: followers reading B need to see
    // it, and followers reading A — the unit on this screen — must not.
    expect(broadcastUserMessage).toHaveBeenCalledWith('hi from B', 'fm1', undefined, 'cone_b');
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

  it('proxies ranged preview reads, slicing when the client has no windowed read', async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const ranged = { readFileRange: vi.fn(async () => new Uint8Array([9])), readFile: vi.fn() };
    const plain = { readFile: vi.fn(async () => bytes) };
    let fs: object = ranged;
    const deps = {
      refs: {},
      client: {},
      workUnits: { subscribeList: () => () => undefined },
      openFs: async () => fs,
    } as unknown as Parameters<typeof createLeaderOptionsFactory>[0];
    const options = createLeaderOptionsFactory(
      deps,
      {} as Parameters<typeof createLeaderOptionsFactory>[1],
      {} as Parameters<typeof createLeaderOptionsFactory>[2]
    )('https://tray.example');

    expect(await options.vfs!.readFileRange('/a.mp4', 1, 2)).toEqual(new Uint8Array([9]));
    expect(ranged.readFileRange).toHaveBeenCalledWith('/a.mp4', 1, 2);

    fs = plain;
    expect(await options.vfs!.readFileRange('/a.mp4', 2, 10)).toEqual(new Uint8Array([2, 3, 4, 5]));
    expect(plain.readFile).toHaveBeenCalledWith('/a.mp4', { encoding: 'binary' });
  });
});
