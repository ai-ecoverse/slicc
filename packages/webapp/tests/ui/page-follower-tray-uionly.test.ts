/**
 * Behavioral tests for the `uiOnly` follower mode of `startPageFollowerTray`.
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
    this['requestSnapshot'] = vi.fn();
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

describe('startPageFollowerTray uiOnly advertise suppression', () => {
  beforeEach(() => {
    capturedOnConnected = null;
    capturedSyncCallbacks = null;
    mockAdvertiseTargets = vi.fn();
  });

  it('uiOnly=true: interval path does NOT call advertiseTargets', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), uiOnly: true, _refreshIntervalMs: 50 };
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

  it('uiOnly=true: onTargetsChanged callback does NOT call advertiseTargets', async () => {
    const opts = { ...makeBaseOptions(), uiOnly: true };
    const handle = startPageFollowerTray(opts);
    capturedOnConnected!(fakeConnection());

    expect(capturedSyncCallbacks?.onTargetsChanged).toBeDefined();
    capturedSyncCallbacks!.onTargetsChanged!();
    await Promise.resolve(); // refreshTargets is async (awaits listPages)

    expect(mockAdvertiseTargets).not.toHaveBeenCalled();
    handle.stop();
  });

  it('uiOnly=true: chat sync (setChatAgent, requestSnapshot) still wired', () => {
    const opts = { ...makeBaseOptions(), uiOnly: true };
    const handle = startPageFollowerTray(opts);
    capturedOnConnected!(fakeConnection());

    expect(opts.setChatAgent).toHaveBeenCalledTimes(1);
    const syncArg = (opts.setChatAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(syncArg.requestSnapshot).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('uiOnly=false (positive control): interval path DOES call advertiseTargets', async () => {
    vi.useFakeTimers();
    try {
      const opts = { ...makeBaseOptions(), uiOnly: false, _refreshIntervalMs: 50 };
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
