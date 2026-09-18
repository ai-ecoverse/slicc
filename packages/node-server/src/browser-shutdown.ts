import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

import { probeCdpAlive } from './chrome-launch.js';

export interface LaunchedBrowserHandle {
  launchedBrowserProcess: ChildProcess | null;
  launchedBrowserLabel: string;
}

export interface BrowserShutdownDependencies {
  fetchImpl?: typeof fetch;
  createWebSocket?: (url: string) => WebSocket;
}

export async function closeLaunchedBrowserGracefully(
  state: LaunchedBrowserHandle,
  cdpPort: number,
  dependencies: BrowserShutdownDependencies = {}
): Promise<void> {
  const browser = state.launchedBrowserProcess;
  if (!browser) return;

  try {
    const res = await (dependencies.fetchImpl ?? fetch)(
      `http://127.0.0.1:${cdpPort}/json/version`,
      {
        signal: AbortSignal.timeout(500),
      }
    );
    const json = (await res.json()) as { webSocketDebuggerUrl: string };
    const browserWs = (dependencies.createWebSocket ?? ((url) => new WebSocket(url)))(
      json.webSocketDebuggerUrl
    );
    await new Promise<void>((resolve, reject) => {
      browserWs.on('open', () => {
        try {
          browserWs.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
          browserWs.close();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      browserWs.on('error', reject);
    });
  } catch {}

  const deadline = Date.now() + 3000;
  let reachable = await probeCdpAlive(cdpPort);
  while (reachable && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    reachable = await probeCdpAlive(cdpPort);
  }
  if (reachable) {
    try {
      browser.kill('SIGKILL');
    } catch {}
  }
  console.log(`${state.launchedBrowserLabel} closed`);
}
