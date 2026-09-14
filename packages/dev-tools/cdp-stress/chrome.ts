import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findChromeExecutable,
  getDefaultCdpLaunchTimeoutMs,
  waitForCdpPort,
} from '../../node-server/src/chrome-launch.js';

export interface ChromeHandle {
  wsUrl: string;
  port: number;
  proc: ChildProcess;
  kill: () => void;
}

export function chromeBinary(): string | null {
  return process.env['CHROME_BIN'] ?? findChromeExecutable();
}

export async function launchChrome(): Promise<ChromeHandle> {
  const bin = chromeBinary();
  if (!bin) throw new Error('No Chrome executable found (set CHROME_BIN)');
  const profile = mkdtempSync(join(tmpdir(), 'slicc-cdp-stress-'));
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const kill = () => {
    try {
      proc.kill('SIGKILL');
    } catch {}
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }, 500);
  };
  let port: number;
  try {
    port = await waitForCdpPort(proc, {
      userDataDir: profile,
      timeoutMs: Math.max(getDefaultCdpLaunchTimeoutMs(), 60_000),
    });
  } catch (e) {
    kill();
    throw e;
  }
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
  return { wsUrl: webSocketDebuggerUrl, port, proc, kill };
}
