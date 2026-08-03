/**
 * Behavioral tests for `advertisesCdpTargets` on `startPageFollowerTray`.
 *
 * The flag gates whether the follower enumerates local CDP targets and
 * advertises them to the leader. A follower with no local CDP surface that
 * still polls dials `wss://<page-origin>/cdp` on a 5s loop forever (#1706).
 *
 * `advertiseTargets` lives on the `FollowerSyncManager` that
 * `startPageFollowerTray` constructs inside its private `wireFollowerSync`,
 * which only runs on a successful connection. To exercise the suppression
 * without real WebRTC we mock the two layers below the page helper:
 *   - `tray-webrtc.js` `startFollowerWithAutoReconnect` — capture its
 *     `onConnected` callback and return an inert handle (do NOT auto-connect).
 *   - `tray-follower-sync.js` `FollowerSyncManager` — capture its callbacks
 *     (esp. `onTargetsChanged`) and expose an `advertiseTargets` spy.
 *
 * These module mocks are file-scoped, which is why they live in this dedicated
 * file: the sibling `page-follower-tray.test.ts` exercises the real (un-mocked)
 * connection/boot path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartPageFollowerTrayOptions } from '../../src/ui/page-follower-tray.js';
import { startPageFollowerTray } from '../../src/ui/page-follower-tray.js';

// Captured across a connection so the tests can drive the wired callbacks.
let capturedOnConnected: ((conn: unknown) => void) | null = null;
let capturedSyncCallbacks: { onTargetsChanged?: () => void } | null = null;
let mockAdvertiseTargets: ReturnType<typeof vi.fn>;
let requestSnapshotSpies: ReturnType<typeof vi.fn>[];

// Mock the reconnect layer: capture `onConnected`, return an inert handle so the
// helper's pre-connection state is unchanged until we invoke `onConnected`.
vi.mock('../../src/scoops/tray-webrtc.js', () => ({
  startFollowerWithAutoReconnect: vi.fn(
    (_managerOpts: unknown, reconnectOpts: { onConnected: (conn: unknown) => void }) => {
      capturedOnConnected = reconnectOpts.onConnected;
      return { cancel: vi.fn(), reconnecting: false };
    }
  ),
}));

// Mock the sync layer: capture the callbacks and expose the advertise spy. The
// spy is read lazily in the constructor (which runs at connection time, after
// `beforeEach` installs a fresh spy).
vi.mock('../../src/scoops/tray-follower-sync.js', () => {
  const FollowerSyncManager = vi.fn(function (
    this: Record<string, unknown>,
    _channel: unknown,
    callbacks: { onTargetsChanged?: () => void }
  ) {
    capturedSyncCallbacks = callbacks;
    this['advertiseTargets'] = mockAdvertiseTargets;
    const requestSnapshot = vi.fn();
    requestSnapshotSpies.push(requestSnapshot);
    this['requestSnapshot'] = requestSnapshot;
    this['close'] = vi.fn();
  });
  return { FollowerSyncManager };
});

function makeFakeBrowserAPI(): StartPageFollowerTrayOptions['browserAPI'] {
  return {
    setTrayTargetProvider: vi.fn(),
    getTransport: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
  } as unknown as StartPageFollowerTrayOptions['browserAPI'];
}

function makeBaseOptions(): StartPageFollowerTrayOptions {
  return {
    joinUrl: 'https://tray.example.com/join/token',
    onSnapshot: vi.fn(),
    onUserMessage: vi.fn(),
    onStatus: vi.fn(),
    setChatAgent: vi.fn(),
    browserAPI: makeFakeBrowserAPI(),
    _fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('network down')),
    _sleep: vi.fn(() => new Promise<void>(() => {})),
    _refreshIntervalMs: 60_000,
  };
}

/** A minimal `FollowerTrayConnection` — wireFollowerSync reads these fields. */
function fakeConnection() {
  return { channel: {} as never, bootstrapId: 'boot-1', trayId: 'tray-1', controllerId: 'ctrl-1' };
}

describe('startPageFollowerTray CDP advertise suppression', () => {
  beforeEach(() => {
    capturedOnConnected = null;
    capturedSyncCallbacks = null;
    mockAdvertiseTargets = vi.fn();
    requestSnapshotSpies = [];
  });

  it('advertisesCdpTargets=false: interval path does NOT call advertiseTargets', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), advertisesCdpTargets: false, _refreshIntervalMs: 50 };
      const handle = startPageFollowerTray(opts);
      expect(capturedOnConnected).not.toBeNull();
      capturedOnConnected!(fakeConnection());

      await vi.runAllTimersAsync();

      expect(mockAdvertiseTargets).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('advertisesCdpTargets=false: onTargetsChanged callback does NOT call advertiseTargets', async () => {
    const opts = { ...makeBaseOptions(), advertisesCdpTargets: false };
    const handle = startPageFollowerTray(opts);
    capturedOnConnected!(fakeConnection());

    expect(capturedSyncCallbacks?.onTargetsChanged).toBeDefined();
    capturedSyncCallbacks!.onTargetsChanged!();
    await Promise.resolve(); // refreshTargets is async (awaits listPages)

    expect(mockAdvertiseTargets).not.toHaveBeenCalled();
    handle.stop();
  });

  it('advertisesCdpTargets=false: chat sync (setChatAgent, requestSnapshot) still wired', () => {
    const opts = { ...makeBaseOptions(), advertisesCdpTargets: false };
    const handle = startPageFollowerTray(opts);
    capturedOnConnected!(fakeConnection());

    expect(opts.setChatAgent).toHaveBeenCalledTimes(1);
    const syncArg = (opts.setChatAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(syncArg.requestSnapshot).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('requests the preserved scoop on every fresh reconnect sync', () => {
    const opts = {
      ...makeBaseOptions(),
      advertisesCdpTargets: false,
      getSelectedScoopJid: () => 'research',
    };
    const handle = startPageFollowerTray(opts);

    capturedOnConnected!(fakeConnection());
    capturedOnConnected!({ ...fakeConnection(), bootstrapId: 'boot-2' });

    expect(requestSnapshotSpies).toHaveLength(2);
    expect(requestSnapshotSpies[0]).toHaveBeenCalledWith('research');
    expect(requestSnapshotSpies[1]).toHaveBeenCalledWith('research');
    handle.stop();
  });

  it('advertisesCdpTargets=true (positive control): interval path DOES call advertiseTargets', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), advertisesCdpTargets: true, _refreshIntervalMs: 50 };
      const handle = startPageFollowerTray(opts);
      capturedOnConnected!(fakeConnection());

      await vi.advanceTimersByTimeAsync(120);

      expect(mockAdvertiseTargets).toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression (#1706): suppression must stop the POLLING, not just the
  // advertisement. The bug users hit was the dialing itself — every tick
  // called `listPages()`, which opened a doomed `wss://<hosted-origin>/cdp`
  // socket. Asserting only on `advertiseTargets` would still pass while that
  // loop ran, so assert the transport is never touched at all.
  it('advertisesCdpTargets=false: never calls listPages (no CDP dialing at all)', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), advertisesCdpTargets: false, _refreshIntervalMs: 50 };
      const handle = startPageFollowerTray(opts);
      capturedOnConnected!(fakeConnection());

      await vi.advanceTimersByTimeAsync(500); // 10 refresh windows

      expect(opts.browserAPI.listPages).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // The option is optional; an omitted flag keeps the historical
  // advertise-by-default behavior for local-bridge followers.
  it('omitted flag defaults to advertising', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), _refreshIntervalMs: 50 };
      const handle = startPageFollowerTray(opts);
      capturedOnConnected!(fakeConnection());

      await vi.advanceTimersByTimeAsync(120);

      expect(mockAdvertiseTargets).toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
