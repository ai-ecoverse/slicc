import { execFile as nodeExecFile, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';

import { WebSocket } from 'ws';

import {
  buildElectronAppLaunchSpec,
  buildElectronOverlayAppUrl,
  buildElectronOverlayBootstrapScript,
  buildElectronOverlayEntryUrl,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  selectBestOverlayTargets,
  type ElectronInspectableTarget,
} from './electron-runtime.js';

const execFile = promisify(nodeExecFile);
const ELECTRON_OVERLAY_SYNC_INTERVAL_MS = 1500;

interface RunningProcessInfo {
  pid: number;
  commandLine: string;
  executablePath: string | null;
}

function commandLineExecutableMatchesPattern(commandLine: string, pattern: string): boolean {
  // Extract the executable (first whitespace-separated token) from the command line.
  // Only match when the target app path is the executable itself, not an argument —
  // this avoids false positives when the path appears as a CLI flag (e.g. --kill /App.app).
  const executable = commandLine.trimStart().split(/\s+/)[0] ?? '';
  return (
    executable === pattern ||
    executable.startsWith(pattern + '/') ||
    executable.startsWith(pattern + '\\')
  );
}

export function findMatchingElectronAppPids(
  runningProcesses: RunningProcessInfo[],
  processMatchPatterns: string[],
  currentPid = process.pid
): number[] {
  const matches = runningProcesses.filter((processInfo) => {
    // Skip Node.js tool-chain processes and shell wrappers — they may have the app path
    // as a CLI argument but are not the Electron app itself
    // (e.g. npx tsx src/cli/index.ts --electron /Applications/Slack.app)
    // Shell wrappers like `zsh -c ... /Applications/Slack.app --kill` or
    // `timeout 30 npm run dev:electron -- /Applications/Slack.app` also match.
    const cmdTrimmed = processInfo.commandLine.trimStart();
    if (
      /^(\/\S*\/)?(node|npx|tsx|npm|open|bash|zsh|sh|csh|fish|dash|timeout|env|sudo|caffeinate)\b/i.test(
        cmdTrimmed
      )
    )
      return false;

    return processMatchPatterns.some((pattern) => {
      return (
        commandLineExecutableMatchesPattern(processInfo.commandLine, pattern) ||
        (processInfo.executablePath?.includes(pattern) ?? false)
      );
    });
  });

  return Array.from(
    new Set(matches.map((processInfo) => processInfo.pid).filter((pid) => pid !== currentPid))
  );
}

export class ElectronAppAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElectronAppAlreadyRunningError';
  }
}

function parseUnixProcessList(stdout: string): RunningProcessInfo[] {
  const processes: RunningProcessInfo[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;

    const pid = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;

    processes.push({
      pid,
      commandLine: match[2] ?? '',
      executablePath: null,
    });
  }

  return processes;
}

function parseWindowsProcessList(stdout: string): RunningProcessInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as Record<string, unknown> | Array<Record<string, unknown>>;
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  return entries
    .map((entry) => ({
      pid: Number.parseInt(String(entry['ProcessId'] ?? ''), 10),
      commandLine: String(entry['CommandLine'] ?? ''),
      executablePath: entry['ExecutablePath'] == null ? null : String(entry['ExecutablePath']),
    }))
    .filter((processInfo) => Number.isFinite(processInfo.pid) && processInfo.pid > 0);
}

async function listRunningProcesses(
  platform: NodeJS.Platform = process.platform
): Promise<RunningProcessInfo[]> {
  if (platform === 'win32') {
    const { stdout } = await execFile('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
    ]);
    return parseWindowsProcessList(stdout);
  }

  const { stdout } = await execFile('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  return parseUnixProcessList(stdout);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidsToExit(pids: number[], timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return pids.every((pid) => !isPidAlive(pid));
}

async function terminateRunningApp(pids: number[]): Promise<void> {
  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid);
    } catch {
      // Ignore individual termination failures and fall back to force-kill below if needed.
    }
  }

  if (await waitForPidsToExit(pids)) return;

  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ignore final cleanup failures.
    }
  }

  await waitForPidsToExit(pids, 3000);
}

async function findRunningElectronAppPids(
  appPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<number[]> {
  const { processMatchPatterns } = buildElectronAppLaunchSpec(appPath, { cdpPort: 0, platform });
  const runningProcesses = await listRunningProcesses(platform);

  return findMatchingElectronAppPids(runningProcesses, processMatchPatterns);
}

export async function launchElectronApp(options: {
  appPath: string;
  cdpPort: number;
  kill: boolean;
  platform?: NodeJS.Platform;
}): Promise<{ child: ChildProcess; displayName: string }> {
  const launchSpec = buildElectronAppLaunchSpec(options.appPath, {
    cdpPort: options.cdpPort,
    platform: options.platform,
  });

  if (!existsSync(launchSpec.resolvedAppPath)) {
    throw new Error(`Electron app not found at ${launchSpec.resolvedAppPath}`);
  }
  if (!existsSync(launchSpec.command)) {
    throw new Error(
      `Electron executable not found at ${launchSpec.command}. Pass the app executable path directly if needed.`
    );
  }
  const runningPids = await findRunningElectronAppPids(
    launchSpec.resolvedAppPath,
    options.platform
  );
  const platform = options.platform ?? process.platform;
  const isMacAppBundle =
    platform === 'darwin' && launchSpec.resolvedAppPath.toLowerCase().endsWith('.app');

  if (runningPids.length > 0 && !options.kill) {
    throw new ElectronAppAlreadyRunningError(
      `${launchSpec.displayName} is already running. Re-run with --kill to relaunch it with remote debugging enabled.`
    );
  }
  if (runningPids.length > 0) {
    await terminateRunningApp(runningPids);
  }

  const child = isMacAppBundle
    ? spawn('open', ['-n', '-a', launchSpec.resolvedAppPath, '-W', '--args', ...launchSpec.args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
    : spawn(launchSpec.command, launchSpec.args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

  return {
    child,
    displayName: launchSpec.displayName,
  };
}

async function loadElectronOverlayBundleSource(options: {
  dev: boolean;
  servePort: number;
  projectRoot: string;
}): Promise<string> {
  const serveOrigin = getElectronServeOrigin(options.servePort);

  if (options.dev) {
    const response = await fetch(buildElectronOverlayEntryUrl(serveOrigin));
    if (!response.ok) {
      throw new Error(
        `Failed to fetch electron overlay entry: ${response.status} ${response.statusText}`
      );
    }
    return await response.text();
  }

  return await readFile(getElectronOverlayEntryDistPath(options.projectRoot), 'utf8');
}

export class ElectronOverlayInjector {
  private readonly cdpPort: number;
  private readonly bootstrapScript: string;
  private readonly connections = new Map<string, WebSocket>();
  private readonly cspBypassedTargets = new Set<string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  private constructor(cdpPort: number, bootstrapScript: string) {
    this.cdpPort = cdpPort;
    this.bootstrapScript = bootstrapScript;
  }

  static async create(options: {
    cdpPort: number;
    servePort: number;
    dev: boolean;
    projectRoot: string;
  }): Promise<ElectronOverlayInjector> {
    const bundleSource = await loadElectronOverlayBundleSource(options);
    const bootstrapScript = buildElectronOverlayBootstrapScript({
      bundleSource,
      appUrl: buildElectronOverlayAppUrl(getElectronServeOrigin(options.servePort)),
    });

    return new ElectronOverlayInjector(options.cdpPort, bootstrapScript);
  }

  async start(): Promise<void> {
    await this.syncTargets();
    this.syncTimer = setInterval(() => {
      void this.syncTargets();
    }, ELECTRON_OVERLAY_SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {
        // Ignore connection cleanup failures.
      }
    }
    this.connections.clear();
  }

  private async syncTargets(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`);
      if (!response.ok) {
        throw new Error(`CDP target listing failed with ${response.status} ${response.statusText}`);
      }

      const targets = (await response.json()) as ElectronInspectableTarget[];
      const pageCount = targets.filter(t => t.type === 'page').length;
      const injectableTargets = selectBestOverlayTargets(targets);
      if (injectableTargets.length < pageCount) {
        console.log(`[electron-float] Selected ${injectableTargets.length}/${pageCount} page targets for overlay injection`);
        for (const t of injectableTargets) {
          console.log(`[electron-float]   → ${t.title || '(untitled)'} @ ${t.url.substring(0, 80)}`);
        }
      }
      const liveConnectionIds = new Set(
        injectableTargets.map((target) => target.webSocketDebuggerUrl!)
      );

      for (const [targetId, connection] of this.connections.entries()) {
        if (liveConnectionIds.has(targetId)) continue;
        try {
          connection.close();
        } catch {
          // Ignore stale connection cleanup failures.
        }
        this.connections.delete(targetId);
      }

      for (const target of injectableTargets) {
        const targetId = target.webSocketDebuggerUrl!;
        if (this.connections.has(targetId)) continue;
        this.connectToTarget(target);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[electron-float] Overlay sync failed:', message);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Check if the overlay iframe loaded successfully by evaluating a probe script.
   * Returns true if the iframe element exists and has started loading content.
   */
  private async probeOverlayIframeLoaded(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const probeId = send('Runtime.evaluate', {
        expression: `(function() {
          var host = document.getElementById('slicc-electron-overlay-root');
          if (!host || !host.shadowRoot) return 'no-host';
          var sidebar = host.shadowRoot.querySelector('slicc-electron-sidebar');
          if (!sidebar || !sidebar.shadowRoot) return 'no-sidebar';
          var iframe = sidebar.shadowRoot.querySelector('iframe');
          if (!iframe) return 'no-iframe';
          if (!iframe.src) return 'no-src';
          return 'ok';
        })()`,
        awaitPromise: false,
        returnByValue: true,
      });

      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 3000);

      const onMessage = (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === probeId) {
            cleanup();
            const value = msg.result?.result?.value;
            resolve(value === 'ok');
          }
        } catch { /* ignore */ }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
      };

      ws.on('message', onMessage);
    });
  }

  private connectToTarget(target: ElectronInspectableTarget): void {
    const targetId = target.webSocketDebuggerUrl!;
    const ws = new WebSocket(targetId);
    this.connections.set(targetId, ws);

    let messageId = 1;
    const send = (method: string, params?: Record<string, unknown>): number => {
      const id = messageId++;
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };

    const cspBypassedTargets = this.cspBypassedTargets;
    const bootstrapScript = this.bootstrapScript;
    let pendingReload = false;
    let pendingCspEscalation = false;
    let fetchProxyActive = false;

    ws.on('open', () => {
      const isWebContent = target.url.startsWith('https://');
      const alreadyBypassed = cspBypassedTargets.has(target.url);
      console.log(`[electron-float] Connected to target, web=${isWebContent}, bypassed=${alreadyBypassed}, url=${target.url}`);

      send('Runtime.enable');
      send('Page.enable');

      // Set CSP bypass — affects future resource loads on the current page
      send('Page.setBypassCSP', { enabled: true });

      if (alreadyBypassed) {
        // Already reloaded with CSP bypass previously — just inject
        console.log(`[electron-float] Injecting overlay (CSP already bypassed)...`);
        send('Runtime.evaluate', { expression: bootstrapScript, awaitPromise: false });
        return;
      }

      // First connection to this target URL: inject overlay immediately, then
      // check if the iframe loaded. If CSP blocked it, fall back to reload+proxy.
      console.log(`[electron-float] Injecting overlay (first attempt)...`);
      send('Runtime.evaluate', { expression: bootstrapScript, awaitPromise: false });

      if (!isWebContent) {
        // Local content (file://, app protocol) — CSP is not an issue
        return;
      }

      // After a short delay, probe whether the overlay iframe loaded.
      // If CSP blocked it, reload the page so Page.setBypassCSP takes effect.
      // If that still doesn't work, escalate to the Fetch proxy.
      setTimeout(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const loaded = await this.probeOverlayIframeLoaded(ws, send);
        if (loaded) {
          console.log(`[electron-float] Overlay iframe loaded successfully — no CSP reload needed`);
          cspBypassedTargets.add(target.url);
          return;
        }

        // Phase 2: Page.setBypassCSP was already set — a simple reload should
        // make the browser ignore CSP headers on the fresh navigation.
        console.log(`[electron-float] Overlay iframe blocked by CSP, reloading with bypass: ${target.url}`);
        cspBypassedTargets.add(target.url);
        pendingReload = true;
        pendingCspEscalation = true;
        send('Page.reload', { ignoreCache: true });
      }, 1500);
    });

    // Handle CDP events: lifecycle events and Fetch interception
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Inject overlay after page load completes (after CSP-bypass reload)
        if (msg.method === 'Page.loadEventFired' && pendingReload) {
          pendingReload = false;
          console.log(`[electron-float] Page loaded after CSP reload, injecting overlay...`);
          if (ws.readyState !== WebSocket.OPEN) return;
          send('Runtime.evaluate', { expression: bootstrapScript, awaitPromise: false });

          // If this was a simple reload (no proxy), check if the iframe loads now.
          // If it still doesn't, escalate to the Fetch proxy as a last resort.
          if (pendingCspEscalation) {
            pendingCspEscalation = false;
            setTimeout(async () => {
              if (ws.readyState !== WebSocket.OPEN) return;
              const loaded = await this.probeOverlayIframeLoaded(ws, send);
              if (loaded) {
                console.log(`[electron-float] Overlay iframe loaded after CSP reload — no proxy needed`);
                return;
              }

              console.log(`[electron-float] CSP reload insufficient, escalating to Fetch proxy: ${target.url}`);
              fetchProxyActive = true;
              const urlOrigin = new URL(target.url).origin;
              send('Fetch.enable', {
                patterns: [{ urlPattern: `${urlOrigin}/*`, requestStage: 'Request' }],
              });
              pendingReload = true;
              send('Page.reload', { ignoreCache: true });
            }, 1500);
          }
        }

        if (msg.method === 'Fetch.requestPaused' && fetchProxyActive) {
          const requestId = msg.params?.requestId;
          if (!requestId) {
            console.warn('[electron-float] Fetch.requestPaused without requestId, skipping');
            return;
          }
          const url = msg.params?.request?.url || '';
          const method = msg.params?.request?.method || 'GET';
          const requestHeaders = msg.params?.request?.headers || {};
          const postData = msg.params?.request?.postData;

          // Only proxy HTML document requests (Accept header contains text/html)
          const acceptHeader = requestHeaders['Accept'] || requestHeaders['accept'] || '';
          if (!acceptHeader.includes('text/html')) {
            send('Fetch.continueRequest', { requestId });
            return;
          }

          console.log(`[electron-float] Proxying request to strip CSP: ${url.substring(0, 60)}`);

          // Make the request ourselves using Node.js http/https
          const parsedUrl = new URL(url);
          const transport = parsedUrl.protocol === 'https:' ? https : http;

          const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: requestHeaders,
          };

          const proxyReq = transport.request(options, (proxyRes) => {
            const bodyChunks: Buffer[] = [];
            proxyRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
            proxyRes.on('end', () => {
              if (ws.readyState !== WebSocket.OPEN) return;

              const fullBody = Buffer.concat(bodyChunks);

              // Build response headers, stripping CSP and hop-by-hop headers
              // that are invalid in Fetch.fulfillRequest responses
              const HOP_BY_HOP = new Set([
                'content-security-policy',
                'content-security-policy-report-only',
                'transfer-encoding',
                'connection',
                'keep-alive',
              ]);
              const responseHeaders: Array<{ name: string; value: string }> = [];
              let strippedCSP = false;
              for (const [name, value] of Object.entries(proxyRes.headers)) {
                const lower = name.toLowerCase();
                if (lower.includes('content-security-policy')) {
                  strippedCSP = true;
                  continue;
                }
                if (HOP_BY_HOP.has(lower)) continue;
                // Update content-length to match actual body size
                if (lower === 'content-length') {
                  responseHeaders.push({ name, value: String(fullBody.length) });
                  continue;
                }
                if (Array.isArray(value)) {
                  value.forEach(v => responseHeaders.push({ name, value: v }));
                } else if (value) {
                  responseHeaders.push({ name, value });
                }
              }

              if (strippedCSP) {
                console.log(`[electron-float] Stripped CSP from: ${url.substring(0, 60)}`);
              }

              send('Fetch.fulfillRequest', {
                requestId,
                responseCode: proxyRes.statusCode || 200,
                responseHeaders,
                body: fullBody.toString('base64'),
              });
            });
          });

          proxyReq.on('error', (err) => {
            console.error(`[electron-float] Proxy request failed for ${url.substring(0, 60)}:`, err.message);
            if (ws.readyState === WebSocket.OPEN) {
              send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
            }
          });

          // Forward request body if present (for POST/PUT requests)
          if (postData) {
            proxyReq.write(postData);
          }
          proxyReq.end();
        }
      } catch {
        // Ignore parse errors for non-JSON messages
      }
    });

    ws.on('close', () => {
      if (this.connections.get(targetId) === ws) {
        this.connections.delete(targetId);
      }
    });

    ws.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[electron-float] Overlay target connection failed for ${target.url}:`,
        message
      );
      if (this.connections.get(targetId) === ws) {
        this.connections.delete(targetId);
      }
    });
  }
}
