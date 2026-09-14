import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

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

  it('sends Browser.close through the advertised CDP WebSocket', async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const received = new Promise<string>((resolve) => {
      wss.once('connection', (socket) =>
        socket.once('message', (data) => resolve(data.toString()))
      );
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}` }))
        )
    );
    vi.mocked(probeCdpAlive).mockResolvedValue(false);

    try {
      await closeLaunchedBrowserGracefully(
        { launchedBrowserProcess: fakeLauncherProcess(), launchedBrowserLabel: 'Chrome' },
        12345
      );
      expect(JSON.parse(await received)).toEqual({ id: 1, method: 'Browser.close' });
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to polling when the CDP socket send throws', async () => {
    const socket = {
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'open') queueMicrotask(listener);
        return socket;
      }),
      send: vi.fn(() => {
        throw new Error('socket closed');
      }),
      close: vi.fn(),
    };
    vi.mocked(probeCdpAlive).mockResolvedValue(false);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://fake' })));

    const closing = closeLaunchedBrowserGracefully(
      { launchedBrowserProcess: fakeLauncherProcess(), launchedBrowserLabel: 'Chrome' },
      12345,
      {
        fetchImpl,
        createWebSocket: () => socket as unknown as WebSocket,
      }
    );
    await closing;
    expect(socket.send).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
  });
});
