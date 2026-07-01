import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/chrome-launch.js', () => ({
  probeCdpAlive: vi.fn(),
}));

import { closeLaunchedBrowserGracefully } from '../src/browser-shutdown.js';
import { probeCdpAlive } from '../src/chrome-launch.js';

function fakeLauncherProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), { kill: vi.fn() }) as unknown as ChildProcess;
}

describe('closeLaunchedBrowserGracefully', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No CDP endpoint to send Browser.close to in these tests — exercises the
    // fallback path so behavior hinges entirely on the reachability polling below.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no CDP')));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(probeCdpAlive).mockReset();
  });

  it('does not treat the macOS `open` launcher exiting as the browser having closed', async () => {
    // Regression: on macOS Chrome is launched via `open -W`, which dies immediately on
    // SIGINT independent of whether Chrome itself has closed. Killing/exiting the
    // launcher must not short-circuit the CDP-based confirmation.
    const browser = fakeLauncherProcess();
    vi.mocked(probeCdpAlive).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const promise = closeLaunchedBrowserGracefully(
      { launchedBrowserProcess: browser, launchedBrowserLabel: 'Chrome' },
      12345
    );
    browser.emit('exit', null, 'SIGINT');
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(probeCdpAlive).toHaveBeenCalledWith(12345);
    expect(browser.kill).not.toHaveBeenCalled();
  });

  it('kills the launcher if the CDP endpoint is still reachable past the deadline', async () => {
    const browser = fakeLauncherProcess();
    vi.mocked(probeCdpAlive).mockResolvedValue(true);

    const promise = closeLaunchedBrowserGracefully(
      { launchedBrowserProcess: browser, launchedBrowserLabel: 'Chrome' },
      12345
    );
    await vi.advanceTimersByTimeAsync(3100);
    await promise;

    expect(browser.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does nothing when no browser was launched', async () => {
    await closeLaunchedBrowserGracefully(
      { launchedBrowserProcess: null, launchedBrowserLabel: 'Chrome' },
      12345
    );
    expect(probeCdpAlive).not.toHaveBeenCalled();
  });
});
