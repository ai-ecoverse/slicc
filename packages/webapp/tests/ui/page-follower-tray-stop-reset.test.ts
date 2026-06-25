/**
 * Regression: `startPageFollowerTray().stop()` must force the follower runtime
 * status to `inactive`, even when the underlying reconnect handle's `cancel()`
 * is a no-op.
 *
 * After a reconnect loop gives up (`tray-webrtc.ts` sets `state: 'error'` and
 * nulls `activeManager`), the handle's `cancel()` does `activeManager?.stop()`
 * — a no-op — so nothing resets the page-side follower status. That status is
 * mirrored to the `slicc.followerTrayStatus` shim, so the worker-side `host`
 * would keep reporting a phantom `status: follower (error)` after a `host leave`
 * or a switch to leading. `stop()` is the teardown boundary; it must clear the
 * status unconditionally.
 *
 * We mock `startFollowerWithAutoReconnect` to return a handle whose `cancel()`
 * does nothing — the exact post-gave-up shape — and assert `stop()` still lands
 * the status on `inactive`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/scoops/tray-webrtc.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/scoops/tray-webrtc.js')>();
  return {
    ...actual,
    // A reconnect handle that has already given up: cancel() is inert because
    // its activeManager is null. This is what makes the teardown reset load-bearing.
    startFollowerWithAutoReconnect: vi.fn(() => ({
      cancel: vi.fn(),
      get reconnecting() {
        return false;
      },
    })),
  };
});

import {
  type FollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';
import {
  type StartPageFollowerTrayOptions,
  startPageFollowerTray,
} from '../../src/ui/page-follower-tray.js';

function inactive(): FollowerTrayRuntimeStatus {
  return {
    state: 'inactive',
    joinUrl: null,
    trayId: null,
    error: null,
    lastPingTime: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastError: null,
  };
}

function makeOptions(): StartPageFollowerTrayOptions {
  return {
    joinUrl: 'https://www.sliccy.ai/join/tray-1.secret',
    onSnapshot: vi.fn(),
    onUserMessage: vi.fn(),
    onStatus: vi.fn(),
    setChatAgent: vi.fn(),
    browserAPI: {
      setTrayTargetProvider: vi.fn(),
      getTransport: vi.fn(),
      listPages: vi.fn().mockResolvedValue([]),
    } as unknown as StartPageFollowerTrayOptions['browserAPI'],
    _fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('unused — reconnect mocked')),
    _sleep: vi.fn(() => new Promise<void>(() => {})),
    _refreshIntervalMs: 60_000,
  };
}

describe('startPageFollowerTray stop() clears follower status', () => {
  afterEach(() => {
    setFollowerTrayRuntimeStatus(inactive());
    vi.clearAllMocks();
  });

  it('forces follower status to inactive on stop even when the reconnect gave up (cancel is a no-op)', () => {
    const handle = startPageFollowerTray(makeOptions());

    // Simulate the post-gave-up page state the failed-join reconnect leaves
    // behind: error, with a join URL still attached.
    setFollowerTrayRuntimeStatus({
      ...inactive(),
      state: 'error',
      joinUrl: 'https://www.sliccy.ai/join/tray-1.secret',
      trayId: 'tray-1',
      error: 'Reconnect failed after 10 attempts',
      reconnectAttempts: 10,
      lastError: 'Network unreachable',
    });

    handle.stop();

    expect(getFollowerTrayRuntimeStatus().state).toBe('inactive');
    expect(getFollowerTrayRuntimeStatus().joinUrl).toBeNull();
    expect(getFollowerTrayRuntimeStatus().error).toBeNull();
  });
});
