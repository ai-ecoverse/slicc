import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

import {
  ElectronOverlayInjector,
  findMatchingElectronAppPids,
  resolveFetchProxyOrigin,
} from '../src/electron-controller.js';

describe('findMatchingElectronAppPids', () => {
  it('excludes the current CLI pid while keeping other matching Electron app pids', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 111,
            commandLine: 'node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 222,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 333,
            commandLine: '/Applications/Linear.app/Contents/MacOS/Linear',
            executablePath: '/Applications/Linear.app/Contents/MacOS/Linear',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        111
      )
    ).toEqual([222]);
  });

  it('excludes all Node.js tool-chain processes that have the app path as a CLI argument', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 100,
            commandLine: 'npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 101,
            commandLine:
              'npx tsx packages/node-server/src/index.ts --dev --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 102,
            commandLine:
              'tsx packages/node-server/src/index.ts --dev --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 103,
            commandLine: 'node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: '/usr/local/bin/node',
          },
          {
            pid: 200,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 201,
            commandLine:
              '/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper --type=renderer',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        103
      )
    ).toEqual([200, 201]);
  });

  it('matches via executablePath when commandLine has no app path', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 111,
            commandLine: '/Applications/Slack.app/Contents/Frameworks/Slack Helper --type=gpu',
            executablePath: '/Applications/Slack.app/Contents/Frameworks/Slack Helper',
          },
          {
            pid: 222,
            commandLine: '',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
          {
            pid: 333,
            commandLine: 'node server.js',
            executablePath: '/usr/local/bin/node',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([111, 222]);
  });

  it('handles case-insensitive Node.js executable names', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 50,
            commandLine: 'Node dist/node-server/index.js --electron /Applications/Slack.app',
            executablePath: null,
          },
          {
            pid: 51,
            commandLine:
              'NPX tsx packages/node-server/src/index.ts --electron /Applications/Slack.app',
            executablePath: null,
          },
          {
            pid: 60,
            commandLine: '/Applications/Slack.app/Contents/MacOS/Slack',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app'],
        999
      )
    ).toEqual([60]);
  });

  it('excludes full-path node executables (e.g. Homebrew-installed node)', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 400,
            commandLine:
              '/opt/homebrew/Cellar/node/25.2.1/bin/node --require /opt/homebrew/lib/node_modules/npm/node_modules/dotenv/config --electron /Applications/Slack.app',
            executablePath: '/opt/homebrew/Cellar/node/25.2.1/bin/node',
          },
          {
            pid: 401,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([401]);
  });

  it('excludes the `open` command used to launch macOS .app bundles', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 500,
            commandLine:
              'open -n -a /Applications/Slack.app -W --args --remote-debugging-port=9223',
            executablePath: '/usr/bin/open',
          },
          {
            pid: 501,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([501]);
  });

  it('excludes shell wrapper processes that have the app path in their arguments', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 600,
            commandLine:
              'zsh -c -l source /dev/stdin npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/bin/zsh',
          },
          {
            pid: 601,
            commandLine: 'bash -c npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/bin/bash',
          },
          {
            pid: 602,
            commandLine: 'timeout 30 npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/usr/bin/timeout',
          },
          {
            pid: 603,
            commandLine: 'env npm run dev:electron -- /Applications/Slack.app --kill',
            executablePath: '/usr/bin/env',
          },
          {
            pid: 604,
            commandLine: '/bin/sh -c npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/bin/sh',
          },
          {
            pid: 605,
            commandLine: 'sudo npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/sudo',
          },
          {
            pid: 606,
            commandLine: 'caffeinate -i npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/caffeinate',
          },
          {
            pid: 700,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([700]);
  });

  it('excludes full-path shell wrappers (e.g. /usr/local/bin/bash)', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 610,
            commandLine: '/usr/local/bin/bash -c npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/local/bin/bash',
          },
          {
            pid: 611,
            commandLine: '/usr/bin/env npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/env',
          },
          {
            pid: 612,
            commandLine: '/usr/bin/timeout 30 npm run dev:electron -- /Applications/Slack.app',
            executablePath: '/usr/bin/timeout',
          },
          {
            pid: 700,
            commandLine:
              '/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9223',
            executablePath: '/Applications/Slack.app/Contents/MacOS/Slack',
          },
        ],
        ['/Applications/Slack.app', '/Applications/Slack.app/Contents/MacOS/Slack'],
        999
      )
    ).toEqual([700]);
  });

  it('does not filter out non-Node processes that happen to have "node" in their path', () => {
    expect(
      findMatchingElectronAppPids(
        [
          {
            pid: 70,
            commandLine:
              '/Applications/Slack.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/crashpad_handler --monitor-self',
            executablePath: null,
          },
        ],
        ['/Applications/Slack.app'],
        999
      )
    ).toEqual([70]);
  });
});

describe('resolveFetchProxyOrigin', () => {
  // Mirrors swift-server's `OverlayTargetSession.fetchProxyOrigin` tests
  // (ElectronLauncherTests.swift) — keeps the two runtimes byte-for-byte
  // aligned on which origin pattern feeds `Fetch.enable`.
  it('returns the parent http origin (preserves prior https behavior)', () => {
    expect(resolveFetchProxyOrigin('https://teams.example/calendar', 5711)).toBe(
      'https://teams.example'
    );
  });

  it('includes the explicit port when the parent origin has one', () => {
    expect(resolveFetchProxyOrigin('https://example.com:8443/path?q=1#x', 5711)).toBe(
      'https://example.com:8443'
    );
    expect(resolveFetchProxyOrigin('http://localhost:5710/?runtime=hosted-leader', 5711)).toBe(
      'http://localhost:5710'
    );
  });

  it('falls back to the overlay iframe http origin for file:// parents', () => {
    // file:// renderers (e.g. AEM Desktop) have no http origin, so the
    // previous build keyed Fetch.enable on `null/*` which silently no-oped.
    expect(
      resolveFetchProxyOrigin(
        'file:///Applications/AEM%20Desktop.app/Contents/Resources/app.asar/src/renderer/index.html',
        5711
      )
    ).toBe('http://localhost:5711');
  });

  it('falls back to the overlay iframe origin for app:// (and other non-http) schemes', () => {
    expect(resolveFetchProxyOrigin('app://something/foo', 5711)).toBe('http://localhost:5711');
  });

  it('threads the served port through the fallback', () => {
    expect(resolveFetchProxyOrigin('file:///opt/app/index.html', 5730)).toBe(
      'http://localhost:5730'
    );
  });

  it('falls back to the overlay iframe origin for invalid URLs', () => {
    expect(resolveFetchProxyOrigin('not a url', 5711)).toBe('http://localhost:5711');
  });
});

// -----------------------------------------------------------------------------
// Integration: ElectronOverlayInjector connect/inject flow over a fake CDP
// WebSocket. Drives the same code path the production injector uses, but with
// a controllable `probeDelayMs` so the probe → reload → escalation sequence
// finishes inside Vitest's default 5s budget.
// -----------------------------------------------------------------------------

interface RecordedMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface FakeCdpHarness {
  url: string;
  port: number;
  messages: RecordedMessage[];
  socket: () => WsWebSocket | undefined;
  waitFor: (
    predicate: (msg: RecordedMessage) => boolean,
    label: string
  ) => Promise<RecordedMessage>;
  close: () => Promise<void>;
}

async function startFakeCdpTarget(
  onMessage: (msg: RecordedMessage, socket: WsWebSocket) => void
): Promise<FakeCdpHarness> {
  const httpServer: Server = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind fake CDP server');
  }
  const port = address.port;
  const wss = new WebSocketServer({ server: httpServer, path: '/devtools/page/1' });
  const messages: RecordedMessage[] = [];
  let activeSocket: WsWebSocket | undefined;
  const pending: Array<{
    predicate: (msg: RecordedMessage) => boolean;
    resolve: (msg: RecordedMessage) => void;
  }> = [];

  wss.on('connection', (socket) => {
    activeSocket = socket;
    socket.on('message', (data) => {
      let msg: RecordedMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      messages.push(msg);
      onMessage(msg, socket);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].predicate(msg)) {
          pending[i].resolve(msg);
          pending.splice(i, 1);
        }
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/devtools/page/1`,
    port,
    messages,
    socket: () => activeSocket,
    waitFor: (predicate, label) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<RecordedMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 4000);
        pending.push({
          predicate,
          resolve: (msg) => {
            clearTimeout(timer);
            resolve(msg);
          },
        });
      });
    },
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe('ElectronOverlayInjector connect flow (file:// parity with swift-server Wave 5)', () => {
  it('probes file:// targets and escalates to Fetch proxy keyed on http://localhost:<servePort>', async () => {
    const servePort = 5711;
    const targetUrl =
      'file:///Applications/AEM%20Desktop.app/Contents/Resources/app.asar/src/renderer/index.html';

    const harness = await startFakeCdpTarget((msg, socket) => {
      if (msg.method === 'Page.captureScreenshot' && typeof msg.id === 'number') {
        // No screenshot data → theme detection resolves immediately to 'dark'.
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
      }
      if (
        msg.method === 'Runtime.evaluate' &&
        typeof msg.id === 'number' &&
        typeof msg.params?.expression === 'string' &&
        (msg.params.expression as string).includes('slicc-electron-overlay-root')
      ) {
        // Probe expression — pretend the overlay host never mounted so the
        // injector escalates: first to reload+bypass, then to Fetch proxy.
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'no-host' } },
          })
        );
      }
    });

    try {
      const injector = ElectronOverlayInjector._createForTesting({
        servePort,
        probeDelayMs: 20,
      });

      injector._testingConnectToTarget({
        id: '1',
        type: 'page',
        title: 'AEM Desktop',
        url: targetUrl,
        webSocketDebuggerUrl: harness.url,
      });

      // Phase 1: CSP bypass + first probe must run regardless of file:// scheme.
      await harness.waitFor((m) => m.method === 'Page.setBypassCSP', 'Page.setBypassCSP');
      await harness.waitFor(
        (m) =>
          m.method === 'Runtime.evaluate' &&
          typeof m.params?.expression === 'string' &&
          (m.params.expression as string).includes('slicc-electron-overlay-root'),
        'first probe Runtime.evaluate'
      );

      // Phase 2: probe returned 'no-host' → reload-with-bypass must engage.
      const firstReload = await harness.waitFor(
        (m) => m.method === 'Page.reload',
        'Page.reload after first probe failure'
      );
      expect(firstReload.params).toEqual({ ignoreCache: true });

      // Simulate the page load completing so the injector continues to the
      // post-reload probe + Fetch-proxy escalation branch.
      harness.socket()?.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));

      // Phase 3: post-reload probe runs again, also returns 'no-host', and
      // Fetch.enable must be sent — keyed on the overlay iframe origin
      // (http://localhost:<servePort>), NOT on `file://*` or `null/*`.
      const fetchEnable = await harness.waitFor(
        (m) => m.method === 'Fetch.enable',
        'Fetch.enable after CSP-reload escalation'
      );
      const patterns = (fetchEnable.params as { patterns?: Array<{ urlPattern?: string }> })
        ?.patterns;
      expect(patterns).toBeDefined();
      expect(patterns?.[0]?.urlPattern).toBe(`http://localhost:${servePort}/*`);
      expect(patterns?.[0]?.urlPattern).not.toMatch(/^file:/);
      expect(patterns?.[0]?.urlPattern).not.toContain('null');

      injector._testingCloseConnections();
    } finally {
      await harness.close();
    }
  });

  it('does NOT record bypass when the WS disconnects mid-reload (re-runs full bypass flow on reconnect)', async () => {
    // Regression for the mid-reload disconnect hazard (swift parity with
    // d1c9f14d's `shouldRecordBypassedAfter(probeAction:)` returning false for
    // `.reloadWithBypass`). If the CDP WS drops between `Page.reload` and the
    // post-reload probe, the target must NOT be marked bypassed — otherwise
    // the reconnect's `alreadyBypassed` guard would skip the reload path and
    // the iframe would stay permanently CSP-blocked.
    const servePort = 5711;
    const targetUrl = 'file:///Applications/AEM%20Desktop.app/index.html';

    const harness = await startFakeCdpTarget((msg, socket) => {
      if (msg.method === 'Page.captureScreenshot' && typeof msg.id === 'number') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
      }
      if (
        msg.method === 'Runtime.evaluate' &&
        typeof msg.id === 'number' &&
        typeof msg.params?.expression === 'string' &&
        (msg.params.expression as string).includes('slicc-electron-overlay-root')
      ) {
        // First probe fails → injector escalates to reload-with-bypass.
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'no-host' } },
          })
        );
      }
    });

    try {
      const injector = ElectronOverlayInjector._createForTesting({
        servePort,
        probeDelayMs: 20,
      });

      injector._testingConnectToTarget({
        id: '1',
        type: 'page',
        title: 'AEM Desktop',
        url: targetUrl,
        webSocketDebuggerUrl: harness.url,
      });

      // Drive the flow up to Page.reload (the post-reload probe never runs
      // because we never send loadEventFired here — simulating a mid-reload
      // WS drop).
      await harness.waitFor((m) => m.method === 'Page.setBypassCSP', 'Page.setBypassCSP');
      await harness.waitFor(
        (m) =>
          m.method === 'Runtime.evaluate' &&
          typeof m.params?.expression === 'string' &&
          (m.params.expression as string).includes('slicc-electron-overlay-root'),
        'first probe Runtime.evaluate'
      );
      await harness.waitFor(
        (m) => m.method === 'Page.reload',
        'Page.reload after first probe failure'
      );

      // The fix: target must NOT be in cspBypassedTargets yet. The previous
      // code recorded it BEFORE the post-reload probe confirmed load, which
      // meant a mid-reload disconnect would permanently mark it bypassed and
      // skip the reload path on reconnect.
      expect(injector._testingBypassedTargets().has(targetUrl)).toBe(false);

      injector._testingCloseConnections();
    } finally {
      await harness.close();
    }
  });

  it('records bypass only after the post-reload probe confirms the iframe loaded', async () => {
    // Companion to the mid-reload-disconnect regression: once the post-reload
    // probe returns loaded=true, the target IS recorded so subsequent
    // reconnects use the inject-only fast path. Mirrors swift's
    // `shouldRecordBypassedAfter(postReloadAction: .done)` = true.
    const servePort = 5711;
    const targetUrl = 'file:///opt/app/index.html';
    let probeCount = 0;

    const harness = await startFakeCdpTarget((msg, socket) => {
      if (msg.method === 'Page.captureScreenshot' && typeof msg.id === 'number') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
      }
      if (
        msg.method === 'Runtime.evaluate' &&
        typeof msg.id === 'number' &&
        typeof msg.params?.expression === 'string' &&
        (msg.params.expression as string).includes('slicc-electron-overlay-root')
      ) {
        probeCount++;
        // First probe (pre-reload) fails so we escalate; second probe
        // (post-reload) succeeds so we should record bypass.
        const value = probeCount === 1 ? 'no-host' : 'ok';
        socket.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value } },
          })
        );
      }
    });

    try {
      const injector = ElectronOverlayInjector._createForTesting({
        servePort,
        probeDelayMs: 20,
      });

      injector._testingConnectToTarget({
        id: '1',
        type: 'page',
        title: 'Local',
        url: targetUrl,
        webSocketDebuggerUrl: harness.url,
      });

      await harness.waitFor((m) => m.method === 'Page.reload', 'Page.reload');
      // Mid-reload: still not recorded.
      expect(injector._testingBypassedTargets().has(targetUrl)).toBe(false);

      harness.socket()?.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));

      // Wait for the post-reload probe (probeCount === 2) to run, then give
      // the injector a beat to record the bypass.
      const deadline = Date.now() + 2000;
      while (probeCount < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(probeCount).toBeGreaterThanOrEqual(2);
      expect(injector._testingBypassedTargets().has(targetUrl)).toBe(true);

      injector._testingCloseConnections();
    } finally {
      await harness.close();
    }
  });

  it('already-bypassed guard skips probe + reload + Fetch.enable for file:// targets', async () => {
    const servePort = 5711;
    const targetUrl = 'file:///tmp/index.html';

    const harness = await startFakeCdpTarget((msg, socket) => {
      if (msg.method === 'Page.captureScreenshot' && typeof msg.id === 'number') {
        socket.send(JSON.stringify({ id: msg.id, result: {} }));
      }
      // Intentionally do NOT answer any probe Runtime.evaluate — if the
      // alreadyBypassed guard fails, the test will see one queued and fail
      // the "no probe" assertion below.
    });

    try {
      const injector = ElectronOverlayInjector._createForTesting({
        servePort,
        probeDelayMs: 20,
      });
      injector._testingSeedBypassedTarget(targetUrl);
      expect(injector._testingBypassedTargets().has(targetUrl)).toBe(true);

      injector._testingConnectToTarget({
        id: '1',
        type: 'page',
        title: 'Local',
        url: targetUrl,
        webSocketDebuggerUrl: harness.url,
      });

      await harness.waitFor((m) => m.method === 'Page.setBypassCSP', 'Page.setBypassCSP');
      // Wait long enough that the probe-delay would have fired if the guard
      // were broken (probeDelayMs=20 → 200ms is plenty of headroom).
      await new Promise((resolve) => setTimeout(resolve, 200));

      const probes = harness.messages.filter(
        (m) =>
          m.method === 'Runtime.evaluate' &&
          typeof m.params?.expression === 'string' &&
          (m.params.expression as string).includes('slicc-electron-overlay-root')
      );
      const reloads = harness.messages.filter((m) => m.method === 'Page.reload');
      const fetches = harness.messages.filter((m) => m.method === 'Fetch.enable');

      expect(probes).toHaveLength(0);
      expect(reloads).toHaveLength(0);
      expect(fetches).toHaveLength(0);

      injector._testingCloseConnections();
    } finally {
      await harness.close();
    }
  });
});
