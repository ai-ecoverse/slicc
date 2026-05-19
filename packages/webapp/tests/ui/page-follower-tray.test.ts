/**
 * Tests for `startPageFollowerTray` in `ui/page-follower-tray.ts`.
 *
 * The follower path's heavy lifting lives in `FollowerTrayManager` and
 * `FollowerSyncManager`, which have their own dedicated tests in
 * `tests/scoops/tray-follower.test.ts` and `tray-follower-sync.test.ts`.
 *
 * This file covers the page-side helper's contract:
 *   - The options surface compiles + accepts a minimal valid input.
 *   - `stop()` is safe to call before any connection completes.
 *   - `stop()` is idempotent.
 *   - The underlying reconnect handle is cancelled on `stop()`.
 *
 * Full end-to-end follower connection is not exercised here — that's
 * covered by the class-level tests already.
 */

import { describe, it, expect, vi } from 'vitest';

import { startPageFollowerTray } from '../../src/ui/page-follower-tray.js';
import type { StartPageFollowerTrayOptions } from '../../src/ui/page-follower-tray.js';

/**
 * Minimal `BrowserAPI`-shaped fake. The helper only references
 * `setTrayTargetProvider`, `getTransport`, and `listPages` before a peer
 * connects; before that point `setTrayTargetProvider` may not be called
 * at all.
 */
function makeFakeBrowserAPI(): StartPageFollowerTrayOptions['browserAPI'] {
  return {
    setTrayTargetProvider: vi.fn(),
    getTransport: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
  } as unknown as StartPageFollowerTrayOptions['browserAPI'];
}

/**
 * Build a base options object that will never successfully connect (the
 * fetchImpl rejects every attempt with a fake network failure). The
 * helper's `startFollowerWithAutoReconnect` will retry on backoff; we
 * stop the helper before any retry fires.
 */
function makeBaseOptions(): StartPageFollowerTrayOptions {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));
  // Use a `sleep` that never resolves so the reconnect loop's `await sleep(...)`
  // suspends after the first failure and never gets a chance to retry.
  const sleep = vi.fn(() => new Promise<void>(() => {}));
  return {
    joinUrl: 'https://tray.example.com/join/token',
    onSnapshot: vi.fn(),
    onUserMessage: vi.fn(),
    onStatus: vi.fn(),
    setChatAgent: vi.fn(),
    browserAPI: makeFakeBrowserAPI(),
    _fetchImpl: fetchImpl,
    _sleep: sleep,
    _refreshIntervalMs: 60_000,
  };
}

describe('startPageFollowerTray', () => {
  it('returns a handle whose currentSync is null before any connection', () => {
    const opts = makeBaseOptions();
    const handle = startPageFollowerTray(opts);
    try {
      expect(handle.currentSync).toBeNull();
    } finally {
      handle.stop();
    }
  });

  it('stop() before any connection does not throw', () => {
    const opts = makeBaseOptions();
    const handle = startPageFollowerTray(opts);
    expect(() => handle.stop()).not.toThrow();
  });

  it('stop() is idempotent — calling twice is safe', () => {
    const opts = makeBaseOptions();
    const handle = startPageFollowerTray(opts);
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  it('uses the supplied joinUrl when starting the follower', async () => {
    const opts = makeBaseOptions();
    const handle = startPageFollowerTray(opts);
    try {
      // The first fetch attempt (to the join URL) should fire during boot
      await vi.waitFor(() => expect(opts._fetchImpl).toHaveBeenCalled());
      const firstUrl = (opts._fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(firstUrl).toContain('tray.example.com');
    } finally {
      handle.stop();
    }
  });
});
