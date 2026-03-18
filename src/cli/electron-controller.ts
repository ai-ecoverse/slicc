import { execFile as nodeExecFile, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { promisify } from 'util';

import { WebSocket } from 'ws';

import {
  buildElectronAppLaunchSpec,
  buildElectronOverlayAppUrl,
  buildElectronOverlayBootstrapScript,
  buildElectronOverlayEntryUrl,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  shouldInjectElectronOverlayTarget,
  type ElectronInspectableTarget,
} from './electron-runtime.js';

const execFile = promisify(nodeExecFile);
const ELECTRON_OVERLAY_SYNC_INTERVAL_MS = 1500;

interface RunningProcessInfo {
  pid: number;
  commandLine: string;
  executablePath: string | null;
}

export function findMatchingElectronAppPids(
  runningProcesses: RunningProcessInfo[],
  processMatchPatterns: string[],
  currentPid = process.pid,
): number[] {
  const matches = runningProcesses.filter((processInfo) => {
    return processMatchPatterns.some((pattern) => {
      // Match the executable (first token of commandLine), not arguments.
      // This avoids matching our own CLI process which passes the app path as an argument.
      const executable = processInfo.commandLine.split(/\s+/)[0] ?? '';
      return executable.includes(pattern)
        || (processInfo.executablePath?.includes(pattern) ?? false);
    });
  });

  return Array.from(
    new Set(matches.map((processInfo) => processInfo.pid).filter((pid) => pid !== currentPid)),
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
  platform: NodeJS.Platform = process.platform,
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
  platform: NodeJS.Platform = process.platform,
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
      `Electron executable not found at ${launchSpec.command}. Pass the app executable path directly if needed.`,
    );
  }

  const runningPids = await findRunningElectronAppPids(launchSpec.resolvedAppPath, options.platform);
  if (runningPids.length > 0 && !options.kill) {
    throw new ElectronAppAlreadyRunningError(
      `${launchSpec.displayName} is already running. Re-run with --kill to relaunch it with remote debugging enabled.`,
    );
  }
  if (runningPids.length > 0) {
    await terminateRunningApp(runningPids);
  }

  const child = spawn(launchSpec.command, launchSpec.args, {
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
      throw new Error(`Failed to fetch electron overlay entry: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }

  return await readFile(getElectronOverlayEntryDistPath(options.projectRoot), 'utf8');
}

export class ElectronOverlayInjector {
  private readonly cdpPort: number;
  private readonly bootstrapScript: string;
  private readonly connections = new Map<string, WebSocket>();
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
      const injectableTargets = targets.filter(shouldInjectElectronOverlayTarget);
      const liveConnectionIds = new Set(injectableTargets.map((target) => target.webSocketDebuggerUrl!));

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

  private connectToTarget(target: ElectronInspectableTarget): void {
    const targetId = target.webSocketDebuggerUrl!;
    const ws = new WebSocket(targetId);
    this.connections.set(targetId, ws);

    let messageId = 1;
    const send = (method: string, params?: Record<string, unknown>) => {
      ws.send(JSON.stringify({ id: messageId++, method, params }));
    };

    ws.on('open', () => {
      send('Page.enable');
      send('Runtime.enable');
      send('Page.addScriptToEvaluateOnNewDocument', { source: this.bootstrapScript });
      send('Runtime.evaluate', { expression: this.bootstrapScript, awaitPromise: false });
      console.log(`[electron-float] Overlay injector attached to ${target.url}`);
    });

    ws.on('close', () => {
      if (this.connections.get(targetId) === ws) {
        this.connections.delete(targetId);
      }
    });

    ws.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[electron-float] Overlay target connection failed for ${target.url}:`, message);
      if (this.connections.get(targetId) === ws) {
        this.connections.delete(targetId);
      }
    });
  }
}