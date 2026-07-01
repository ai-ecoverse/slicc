import type { ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

import { probeCdpAlive } from './chrome-launch.js';

export interface LaunchedBrowserHandle {
  launchedBrowserProcess: ChildProcess | null;
  launchedBrowserLabel: string;
}

/** Best-effort graceful close of the launched browser, escalating to SIGKILL. */
export async function closeLaunchedBrowserGracefully(
  state: LaunchedBrowserHandle,
  cdpPort: number
): Promise<void> {
  const browser = state.launchedBrowserProcess;
  if (!browser) return;

  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    const json = (await res.json()) as { webSocketDebuggerUrl: string };
    const browserWs = new WebSocket(json.webSocketDebuggerUrl);
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
  } catch {
    // CDP not available, or the send/response was too slow — the launched browser
    // may still be starting up; fall through to the reachability poll below.
  }

  // On macOS Chrome is launched via `open` (see planChromeSpawn), so `browser` is the
  // launcher process, not Chrome itself — its exit doesn't mean Chrome exited, and it
  // dies immediately on SIGINT regardless of Chrome's state. Poll the CDP endpoint
  // itself to confirm the browser actually shut down before declaring success.
  const deadline = Date.now() + 3000;
  let reachable = await probeCdpAlive(cdpPort);
  while (reachable && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    reachable = await probeCdpAlive(cdpPort);
  }
  if (reachable) {
    // On macOS `browser` is the `open` launcher (already exited, see above), so this
    // SIGKILL only helps on Linux/Windows where `browser` is Chrome itself. A hung
    // Chrome that ignores Browser.close will leak past the deadline on macOS; fixing
    // that needs finding the real Chrome pid (e.g. by unique --user-data-dir).
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  console.log(`${state.launchedBrowserLabel} closed`);
}
