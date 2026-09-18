import {
  BRIDGE_ROLE_FOLLOWER,
  BRIDGE_ROLE_LEADER,
  BRIDGE_ROLE_QUERY_PARAM,
  type CDPPayload,
  ELECTRON_OVERLAY_APP_PATH,
  SLICC_HOSTED_ORIGIN,
  TRAY_QUERY_PARAM,
} from '@slicc/shared-ts';
import {
  type ChildProcess,
  execFile as nodeExecFile,
  type SpawnOptions,
  spawn,
} from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';
import { WebSocket } from 'ws';
import { inflateSync } from 'zlib';
import { BRIDGE_TOKEN_QUERY_PARAM, BRIDGE_WS_QUERY_PARAM } from './bridge-security.js';
import {
  buildElectronAppLaunchSpec,
  buildElectronOverlayBootstrapScript,
  type ElectronInspectableTarget,
  getElectronOverlayEntryDistPath,
  selectBestOverlayTargets,
} from './electron-runtime.js';

const execFile = promisify(nodeExecFile);
const ELECTRON_OVERLAY_SYNC_INTERVAL_MS = 1500;

const ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS = 2000;

export { BRIDGE_ROLE_FOLLOWER, BRIDGE_ROLE_LEADER, BRIDGE_ROLE_QUERY_PARAM };

export interface ThinBridgeConfig {
  hostedLeaderOrigin: string;
  bridgeWsUrl: string;
  bridgeToken: string;
}

export type OverlayRole = typeof BRIDGE_ROLE_LEADER | typeof BRIDGE_ROLE_FOLLOWER;

export function resolveOverlayThinBridge(
  env: Record<string, string | undefined>,
  bridgeToken: string | null,
  servePort: number
): ThinBridgeConfig | null {
  if (!bridgeToken) return null;
  return {
    hostedLeaderOrigin: resolveHostedLeaderOrigin(env),
    bridgeWsUrl: `ws://localhost:${servePort}/cdp`,
    bridgeToken,
  };
}

export interface ThinOverlayUrlOptions extends ThinBridgeConfig {
  role: OverlayRole;
  activeTab?: string;

  trayJoinUrl?: string | null;
}

export function buildThinOverlayAppUrl(opts: ThinOverlayUrlOptions): string {
  const url = new URL(ELECTRON_OVERLAY_APP_PATH, opts.hostedLeaderOrigin);
  url.searchParams.set(BRIDGE_WS_QUERY_PARAM, opts.bridgeWsUrl);
  url.searchParams.set(BRIDGE_TOKEN_QUERY_PARAM, opts.bridgeToken);
  url.searchParams.set(BRIDGE_ROLE_QUERY_PARAM, opts.role);
  if (opts.activeTab && opts.activeTab !== 'chat') {
    url.searchParams.set('tab', opts.activeTab);
  }
  if (opts.trayJoinUrl != null) {
    url.searchParams.set(TRAY_QUERY_PARAM, opts.trayJoinUrl);
  }
  return url.toString();
}

export function resolveHostedLeaderOrigin(
  env: Record<string, string | undefined> = process.env
): string {
  const explicit = env['SLICC_HOSTED_LEADER_ORIGIN'] ?? env['WORKER_BASE_URL'];
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  return SLICC_HOSTED_ORIGIN;
}

interface RunningProcessInfo {
  pid: number;
  commandLine: string;
  executablePath: string | null;
}

interface Win32CimProcessEntry {
  ProcessId?: number | string;
  CommandLine?: string;
  ExecutablePath?: string | null;
}

export type CdpSend = (method: string, params?: CDPPayload) => number;

export interface CdpPostDataEntry {
  bytes?: string;
}

interface CdpFetchPausedHttpRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;

  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: CdpPostDataEntry[];
}

interface CdpFetchRequestPausedEvent {
  params?: {
    requestId?: string;
    request?: CdpFetchPausedHttpRequest;
  };
}

function commandLineExecutableMatchesPattern(commandLine: string, pattern: string): boolean {
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

export function parseUnixProcessList(stdout: string): RunningProcessInfo[] {
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

export function parseWindowsProcessList(stdout: string): RunningProcessInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const parsed = JSON.parse(trimmed) as Win32CimProcessEntry | Win32CimProcessEntry[];
  const entries = Array.isArray(parsed) ? parsed : [parsed];

  return entries
    .map((entry) => ({
      pid: Number.parseInt(String(entry['ProcessId'] ?? ''), 10),
      commandLine: String(entry['CommandLine'] ?? ''),
      executablePath: entry['ExecutablePath'] == null ? null : String(entry['ExecutablePath']),
    }))
    .filter((processInfo) => Number.isFinite(processInfo.pid) && processInfo.pid > 0);
}

export async function listRunningProcesses(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => Promise<{ stdout: string }> = execFile
): Promise<RunningProcessInfo[]> {
  if (platform === 'win32') {
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress',
    ]);
    return parseWindowsProcessList(stdout);
  }

  const { stdout } = await run('ps', ['-ax', '-o', 'pid=', '-o', 'command=']);
  return parseUnixProcessList(stdout);
}

export function isPidAlive(
  pid: number,
  signal: (pid: number, signal: 0) => void = process.kill.bind(process)
): boolean {
  try {
    signal(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessLifecycle {
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal?: NodeJS.Signals) => void;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultProcessLifecycle: ProcessLifecycle = {
  isAlive: isPidAlive,
  kill: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function waitForPidsToExit(
  pids: number[],
  timeoutMs = 5000,
  lifecycle: ProcessLifecycle = defaultProcessLifecycle
): Promise<boolean> {
  const deadline = lifecycle.now() + timeoutMs;

  while (lifecycle.now() < deadline) {
    if (pids.every((pid) => !lifecycle.isAlive(pid))) return true;
    await lifecycle.sleep(100);
  }

  return pids.every((pid) => !lifecycle.isAlive(pid));
}

export async function terminateRunningApp(
  pids: number[],
  lifecycle: ProcessLifecycle = defaultProcessLifecycle
): Promise<void> {
  for (const pid of pids) {
    if (!lifecycle.isAlive(pid)) continue;
    try {
      lifecycle.kill(pid);
    } catch {}
  }

  if (await waitForPidsToExit(pids, 5000, lifecycle)) return;

  for (const pid of pids) {
    if (!lifecycle.isAlive(pid)) continue;
    try {
      lifecycle.kill(pid, 'SIGKILL');
    } catch {}
  }

  await waitForPidsToExit(pids, 3000, lifecycle);
}

export async function findRunningElectronAppPids(
  appPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<number[]> {
  const { processMatchPatterns } = buildElectronAppLaunchSpec(appPath, { cdpPort: 0, platform });
  const runningProcesses = await listRunningProcesses(platform);

  return findMatchingElectronAppPids(runningProcesses, processMatchPatterns);
}

export async function launchElectronApp(
  options: {
    appPath: string;
    cdpPort: number;
    kill: boolean;
    platform?: NodeJS.Platform;
  },
  dependencies: {
    exists?: (path: string) => boolean;
    findRunningPids?: (appPath: string, platform?: NodeJS.Platform) => Promise<number[]>;
    terminate?: (pids: number[]) => Promise<void>;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  } = {}
): Promise<{ child: ChildProcess; displayName: string }> {
  const launchSpec = buildElectronAppLaunchSpec(options.appPath, {
    cdpPort: options.cdpPort,
    platform: options.platform,
  });

  const exists = dependencies.exists ?? existsSync;
  if (!exists(launchSpec.resolvedAppPath)) {
    throw new Error(`Electron app not found at ${launchSpec.resolvedAppPath}`);
  }
  if (!exists(launchSpec.command)) {
    throw new Error(
      `Electron executable not found at ${launchSpec.command}. Pass the app executable path directly if needed.`
    );
  }
  const runningPids = await (dependencies.findRunningPids ?? findRunningElectronAppPids)(
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
    await (dependencies.terminate ?? terminateRunningApp)(runningPids);
  }

  const spawnProcess = dependencies.spawn ?? spawn;
  const child = isMacAppBundle
    ? spawnProcess(
        'open',
        ['-n', '-a', launchSpec.resolvedAppPath, '-W', '--args', ...launchSpec.args],
        {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        }
      )
    : spawnProcess(launchSpec.command, launchSpec.args, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

  return {
    child,
    displayName: launchSpec.displayName,
  };
}

function parsePngChunks(buf: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  idatChunks: Buffer[];
} {
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  let offset = 8;

  while (offset < buf.length) {
    const chunkLength = buf.readUInt32BE(offset);
    const chunkType = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength);

    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8]!;
      colorType = chunkData[9]!;
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (chunkType === 'IEND') {
      break;
    }

    offset += 12 + chunkLength;
  }

  return { width, height, bitDepth, colorType, idatChunks };
}

function applyPngRowFilter(
  row: Buffer,
  prevRow: Buffer,
  filter: number,
  bytesPerPixel: number,
  rowBytes: number
): void {
  for (let i = 0; i < rowBytes; i++) {
    const a = i >= bytesPerPixel ? row[i - bytesPerPixel]! : 0;
    const b = prevRow[i]!;
    const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel]! : 0;

    switch (filter) {
      case 1:
        row[i] = (row[i]! + a) & 0xff;
        break;
      case 2:
        row[i] = (row[i]! + b) & 0xff;
        break;
      case 3:
        row[i] = (row[i]! + ((a + b) >>> 1)) & 0xff;
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
    }
  }
}

export function decodePngPixels(base64Data: string): {
  width: number;
  height: number;
  pixels: Buffer;
} {
  const buf = Buffer.from(base64Data, 'base64');

  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new Error('Not a valid PNG');
  }

  const { width, height, bitDepth, colorType, idatChunks } = parsePngChunks(buf);

  if (width === 0 || height === 0) throw new Error('Missing IHDR chunk');
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);

  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bytesPerPixel === 0) throw new Error(`Unsupported color type: ${colorType}`);

  const compressed = Buffer.concat(idatChunks);
  const inflated = inflateSync(compressed);

  const rowBytes = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * 4);

  let prevRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowBytes);
    const filter = inflated[rowStart]!;
    const row = Buffer.from(inflated.subarray(rowStart + 1, rowStart + 1 + rowBytes));

    applyPngRowFilter(row, prevRow, filter, bytesPerPixel, rowBytes);

    for (let x = 0; x < width; x++) {
      const srcIdx = x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      pixels[dstIdx] = row[srcIdx]!;
      pixels[dstIdx + 1] = row[srcIdx + 1]!;
      pixels[dstIdx + 2] = row[srcIdx + 2]!;
      pixels[dstIdx + 3] = bytesPerPixel === 4 ? row[srcIdx + 3]! : 255;
    }

    prevRow = row;
  }

  return { width, height, pixels };
}

export function computeAverageLuminance(
  pixels: Buffer,
  width: number,
  height: number,
  sampleStep = 4
): number {
  let totalLuminance = 0;
  let sampleCount = 0;

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx]!;
      const g = pixels[idx + 1]!;
      const b = pixels[idx + 2]!;

      totalLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
      sampleCount++;
    }
  }

  return sampleCount > 0 ? totalLuminance / sampleCount : 128;
}

export function detectAppThemeFromScreenshot(
  ws: WebSocket,
  send: CdpSend
): Promise<'light' | 'dark'> {
  return new Promise((resolve) => {
    const screenshotId = send('Page.captureScreenshot', {
      format: 'png',
      quality: 30,
      clip: { x: 0, y: 0, width: 160, height: 120, scale: 0.25 },
      optimizeForSpeed: true,
    });

    const timeout = setTimeout(() => {
      cleanup();
      console.log('[electron-float] Theme detection timed out, defaulting to dark');
      resolve('dark');
    }, 5000);

    const onMessage = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== screenshotId) return;

        cleanup();

        const base64 = msg.result?.data;
        if (!base64) {
          console.log('[electron-float] Theme detection: no screenshot data, defaulting to dark');
          resolve('dark');
          return;
        }

        try {
          const { width, height, pixels } = decodePngPixels(base64);
          const luminance = computeAverageLuminance(pixels, width, height);
          const theme = luminance > 128 ? 'light' : 'dark';
          console.log(
            `[electron-float] Theme detection: luminance=${luminance.toFixed(1)}, theme=${theme} (${width}x${height})`
          );
          resolve(theme);
        } catch (decodeError: unknown) {
          const message = decodeError instanceof Error ? decodeError.message : String(decodeError);
          console.error('[electron-float] Theme detection decode failed:', message);
          resolve('dark');
        }
      } catch {}
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
    };

    ws.on('message', onMessage);
  });
}

async function loadElectronOverlayBundleSource(options: { projectRoot: string }): Promise<string> {
  return await readFile(getElectronOverlayEntryDistPath(options.projectRoot), 'utf8');
}

export function resolveFetchProxyOrigin(targetUrl: string, servePort: number): string {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin;
    }
  } catch {}
  return `http://localhost:${servePort}`;
}

function isPureAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

export type CdpPostBody =
  | { kind: 'none' }
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'unrecoverable'; reason: string };

export function decodeCdpRequestPostBody(request: {
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: CdpPostDataEntry[];
}): CdpPostBody {
  const entries = request.postDataEntries;
  if (entries && entries.length > 0) {
    const chunks: Buffer[] = [];
    for (const entry of entries) {
      if (typeof entry.bytes !== 'string') {
        return {
          kind: 'unrecoverable',
          reason: 'postDataEntries contains a file/blob element with no bytes',
        };
      }
      chunks.push(Buffer.from(entry.bytes, 'base64'));
    }
    return { kind: 'bytes', bytes: Buffer.concat(chunks) };
  }

  const postData = request.postData;
  if (typeof postData === 'string' && postData.length > 0) {
    if (isPureAscii(postData)) {
      return { kind: 'bytes', bytes: Buffer.from(postData, 'latin1') };
    }
    return {
      kind: 'unrecoverable',
      reason: 'postData is not pure ASCII and no postDataEntries were provided',
    };
  }

  if (request.hasPostData) {
    return { kind: 'unrecoverable', reason: 'hasPostData is set but CDP provided no body' };
  }
  return { kind: 'none' };
}

function buildProxyRequestHeaders(
  requestHeaders: Record<string, string>,
  bodyLength: number | null
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (name.toLowerCase() === 'content-length') continue;
    headers[name] = value;
  }
  if (bodyLength !== null) {
    headers['Content-Length'] = String(bodyLength);
  }
  return headers;
}

export function buildFulfillResponseHeaders(
  rawHeaders: http.IncomingHttpHeaders,
  contentLength: number
): { responseHeaders: Array<{ name: string; value: string }>; strippedCSP: boolean } {
  const HOP_BY_HOP = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'transfer-encoding',
    'connection',
    'keep-alive',
  ]);
  const responseHeaders: Array<{ name: string; value: string }> = [];
  let strippedCSP = false;
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (lower.includes('content-security-policy')) {
      strippedCSP = true;
      continue;
    }
    if (HOP_BY_HOP.has(lower)) continue;

    if (lower === 'content-length') {
      responseHeaders.push({ name, value: String(contentLength) });
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => {
        responseHeaders.push({ name, value: v });
      });
    } else if (value) {
      responseHeaders.push({ name, value });
    }
  }
  return { responseHeaders, strippedCSP };
}

export interface ThinBootstrapSet {
  leader: string;
  follower: string;

  status: string;
}

export function logOverlayReinjectionFailure(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[electron-float] ${context} re-injection failed: ${message}`);
}

export const logPresenceReinjectionFailure = (error: unknown): void => {
  logOverlayReinjectionFailure('Presence-check', error);
};

export const logNavigationReinjectionFailure = (error: unknown): void => {
  logOverlayReinjectionFailure('Navigation', error);
};

export const OVERLAY_STATUS_MESSAGE_EGRESS_BLOCKED =
  'SLICC is attached to this app, but it blocks embedded panels. Drive it from the SLICC leader window.';

export const OVERLAY_EGRESS_BLOCK_ERROR_TEXTS: readonly string[] = [
  'net::ERR_ACCESS_DENIED',
  'net::ERR_NETWORK_ACCESS_DENIED',
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_ADMINISTRATOR',
];

export function isOverlayEgressBlockError(errorText: string | undefined): boolean {
  return typeof errorText === 'string' && OVERLAY_EGRESS_BLOCK_ERROR_TEXTS.includes(errorText);
}

export const OVERLAY_LOADED_PROBE_EXPRESSION = `(function() {
          var host = document.getElementById('slicc-electron-overlay-root');
          if (!host || !host.shadowRoot) return 'no-host';
          var iframe = host.shadowRoot.querySelector('iframe');
          if (!iframe) return 'no-iframe';
          if (!iframe.src) return 'no-src';
          try {
            // Thin-bridge overlay is ALWAYS cross-origin (hosted webapp) vs the app
            // document. A committed cross-origin navigation makes this access THROW.
            // Any READABLE href means the cross-origin nav did NOT commit — still
            // about:blank, or swapped to chrome-error://chromewebdata/ by a CSP block —
            // so the overlay did NOT load and the setBypassCSP escalation must fire.
            var href = iframe.contentWindow && iframe.contentWindow.location ? iframe.contentWindow.location.href : '';
            return 'blank:' + href;
          } catch (e) {
            return 'ok';
          }
        })()`;

export const OVERLAY_EVICTED_PROBE_EXPRESSION = `(function() {
          try {
            var hasMarker = typeof window.__SLICC_ELECTRON_OVERLAY__ !== 'undefined';
            var hasRoot = !!document.getElementById('slicc-electron-overlay-root');
            return (hasMarker && !hasRoot) ? 'evicted' : 'ok';
          } catch (e) {
            return 'ok';
          }
        })()`;

export class ElectronOverlayInjector {
  private readonly cdpPort: number;
  private readonly servePort: number;

  private readonly thinBootstraps: ThinBootstrapSet;
  private readonly probeDelayMs: number;
  private readonly presenceCheckIntervalMs: number;
  private readonly connections = new Map<string, WebSocket>();
  private readonly cspBypassedTargets = new Set<string>();

  private readonly bridgeToken: string;

  private readonly egressBlockedTargets = new Set<string>();

  private leaderTargetUrl: string | null = null;

  private readonly onEgressBlocked?: (targetUrl: string) => void;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private readonly runScheduledSync = async (): Promise<void> => {
    await this.syncTargets();
  };

  private constructor(
    cdpPort: number,
    servePort: number,
    thinBootstraps: ThinBootstrapSet,
    bridgeToken: string,
    onEgressBlocked?: (targetUrl: string) => void,
    probeDelayMs: number = 1500,
    presenceCheckIntervalMs: number = ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS
  ) {
    this.cdpPort = cdpPort;
    this.servePort = servePort;
    this.thinBootstraps = thinBootstraps;
    this.bridgeToken = bridgeToken;
    this.onEgressBlocked = onEgressBlocked;
    this.probeDelayMs = probeDelayMs;
    this.presenceCheckIntervalMs = presenceCheckIntervalMs;
  }

  static async create(options: {
    cdpPort: number;
    servePort: number;
    projectRoot: string;

    thinBridge: ThinBridgeConfig;

    onEgressBlocked?: (targetUrl: string) => void;

    trayJoinUrl?: string | null;
  }): Promise<ElectronOverlayInjector> {
    const bundleSource = await loadElectronOverlayBundleSource({
      projectRoot: options.projectRoot,
    });

    const thinBootstraps: ThinBootstrapSet = {
      leader: buildElectronOverlayBootstrapScript({
        bundleSource,
        appUrl: buildThinOverlayAppUrl({
          ...options.thinBridge,
          role: BRIDGE_ROLE_LEADER,

          trayJoinUrl: options.trayJoinUrl ?? '',
        }),
      }),
      follower: buildElectronOverlayBootstrapScript({
        bundleSource,
        appUrl: buildThinOverlayAppUrl({
          ...options.thinBridge,
          role: BRIDGE_ROLE_FOLLOWER,
          trayJoinUrl: '',
        }),
      }),
      status: buildElectronOverlayBootstrapScript({
        bundleSource,
        appUrl: '',
        statusMessage: OVERLAY_STATUS_MESSAGE_EGRESS_BLOCKED,
      }),
    };

    return new ElectronOverlayInjector(
      options.cdpPort,
      options.servePort,
      thinBootstraps,
      options.thinBridge.bridgeToken,
      options.onEgressBlocked
    );
  }

  static _createForTesting(options: {
    cdpPort?: number;
    servePort: number;
    thinBootstraps?: ThinBootstrapSet;
    bridgeToken?: string;
    onEgressBlocked?: (targetUrl: string) => void;
    probeDelayMs?: number;
    presenceCheckIntervalMs?: number;
  }): ElectronOverlayInjector {
    return new ElectronOverlayInjector(
      options.cdpPort ?? 9223,
      options.servePort,
      options.thinBootstraps ?? {
        leader: '/* test-leader */',
        follower: '/* test-follower */',
        status: '/* test-status */',
      },
      options.bridgeToken ?? 'test-bridge-token',
      options.onEgressBlocked,
      options.probeDelayMs ?? 1500,
      options.presenceCheckIntervalMs ?? ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS
    );
  }

  _testingLeaderTargetUrl(): string | null {
    return this.leaderTargetUrl;
  }

  _testingSeedLeaderTargetUrl(url: string | null): void {
    this.leaderTargetUrl = url;
  }

  _testingConnectToTarget(target: ElectronInspectableTarget): void {
    this.connectToTarget(target);
  }

  _testingSeedBypassedTarget(url: string): void {
    this.cspBypassedTargets.add(url);
  }

  _testingBypassedTargets(): ReadonlySet<string> {
    return new Set(this.cspBypassedTargets);
  }

  _testingEgressBlockedTargets(): ReadonlySet<string> {
    return new Set(this.egressBlockedTargets);
  }

  _testingSeedEgressBlockedTarget(url: string): void {
    this.egressBlockedTargets.add(url);
  }

  _testingSeedConnection(targetId: string, connection: Pick<WebSocket, 'close'>): void {
    this.connections.set(targetId, connection as WebSocket);
  }

  _testingDropConnection(targetId: string, connection: WebSocket): void {
    this.dropConnectionIfCurrent(targetId, connection);
  }

  async _testingRunScheduledSync(): Promise<void> {
    await this.runScheduledSync();
  }

  _testingProbeOverlayIframeLoaded(ws: WebSocket, send: CdpSend): Promise<boolean> {
    return this.probeOverlayIframeLoaded(ws, send);
  }

  _testingProbeOverlayEvicted(ws: WebSocket, send: CdpSend): Promise<boolean> {
    return this.probeOverlayEvicted(ws, send);
  }

  _testingHandleFetchRequestPaused(ws: WebSocket, send: CdpSend, msg: unknown): void {
    this.handleFetchRequestPaused(ws, send, msg as CdpFetchRequestPausedEvent);
  }

  async _testingSyncTargets(): Promise<void> {
    await this.syncTargets();
  }

  _testingCloseConnections(): void {
    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {}
    }
    this.connections.clear();
  }

  async start(): Promise<void> {
    await this.syncTargets();
    this.syncTimer = setInterval(this.runScheduledSync, ELECTRON_OVERLAY_SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {}
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
      const pageCount = targets.filter((t) => t.type === 'page').length;
      const injectableTargets = selectBestOverlayTargets(targets);
      if (injectableTargets.length < pageCount) {
        console.log(
          `[electron-float] Selected ${injectableTargets.length}/${pageCount} page targets for overlay injection`
        );
        for (const t of injectableTargets) {
          console.log(
            `[electron-float]   → ${t.title || '(untitled)'} @ ${t.url.substring(0, 80)}`
          );
        }
      }
      const liveConnectionIds = new Set(
        injectableTargets.map((target) => target.webSocketDebuggerUrl!)
      );

      if (this.leaderTargetUrl !== null) {
        const liveTargetUrls = new Set(injectableTargets.map((target) => target.url));
        if (!liveTargetUrls.has(this.leaderTargetUrl)) {
          this.leaderTargetUrl = null;
        }
      }

      for (const [targetId, connection] of this.connections.entries()) {
        if (liveConnectionIds.has(targetId)) continue;
        try {
          connection.close();
        } catch {}
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

  private dropConnectionIfCurrent(targetId: string, connection: WebSocket): void {
    if (this.connections.get(targetId) === connection) {
      this.connections.delete(targetId);
    }
  }

  private async probeOverlayIframeLoaded(ws: WebSocket, send: CdpSend): Promise<boolean> {
    return new Promise((resolve) => {
      const probeId = send('Runtime.evaluate', {
        expression: OVERLAY_LOADED_PROBE_EXPRESSION,
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
        } catch {}
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
      };

      ws.on('message', onMessage);
    });
  }

  private resolveBootstrapForTarget(target: ElectronInspectableTarget): string {
    if (this.leaderTargetUrl === target.url) {
      return this.thinBootstraps.leader;
    }
    if (this.leaderTargetUrl === null) {
      this.leaderTargetUrl = target.url;
      return this.thinBootstraps.leader;
    }
    return this.thinBootstraps.follower;
  }

  private buildThemedBootstrap(theme: 'light' | 'dark', target: ElectronInspectableTarget): string {
    const themeScript = `try{localStorage.setItem('slicc-theme',${JSON.stringify(theme)})}catch(e){}`;
    return `${themeScript}\n${this.resolveBootstrapForTarget(target)}`;
  }

  private buildNewDocumentBootstrap(target: ElectronInspectableTarget): string {
    const bootstrap = this.resolveBootstrapForTarget(target);
    return `(function(){try{if(window.top!==window.self)return;}catch(e){return;}\n${bootstrap}\n})();`;
  }

  private async probeOverlayEvicted(ws: WebSocket, send: CdpSend): Promise<boolean> {
    return new Promise((resolve) => {
      const probeId = send('Runtime.evaluate', {
        expression: OVERLAY_EVICTED_PROBE_EXPRESSION,
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
            resolve(msg.result?.result?.value === 'evicted');
          }
        } catch {}
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
      };

      ws.on('message', onMessage);
    });
  }

  private async reinjectIfEvicted(
    ws: WebSocket,
    send: CdpSend,
    target: ElectronInspectableTarget,
    state: ConnectFlowState
  ): Promise<void> {
    if (ws.readyState !== WebSocket.OPEN || state.pendingReload) return;
    const evicted = await this.probeOverlayEvicted(ws, send);
    if (!evicted || ws.readyState !== WebSocket.OPEN || state.pendingReload) return;
    console.log(`[electron-float] Overlay evicted, re-injecting: ${target.url}`);
    send('Runtime.evaluate', {
      expression: this.resolveBootstrapForTarget(target),
      awaitPromise: false,
    });
  }

  private handleSocketOpen(
    ws: WebSocket,
    send: CdpSend,
    target: ElectronInspectableTarget,
    state: ConnectFlowState
  ): void {
    const alreadyBypassed = this.cspBypassedTargets.has(target.url);
    console.log(
      `[electron-float] Connected to target, bypassed=${alreadyBypassed}, url=${target.url}`
    );

    send('Runtime.enable');
    send('Page.enable');

    if (this.egressBlockedTargets.has(target.url)) {
      state.egressBlocked = true;
      console.log(
        `[electron-float] ${target.url} blocks renderer egress — injecting status-only overlay`
      );
      this.injectStatusOverlay(send);
      return;
    }

    send('Network.enable');

    send('Page.addScriptToEvaluateOnNewDocument', {
      source: this.buildNewDocumentBootstrap(target),
    });

    send('Page.setBypassCSP', { enabled: true });

    if (alreadyBypassed) {
      console.log(
        `[electron-float] Detecting theme and injecting overlay (CSP already bypassed)...`
      );
      void detectAppThemeFromScreenshot(ws, send).then((theme) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        send('Runtime.evaluate', {
          expression: this.buildThemedBootstrap(theme, target),
          awaitPromise: false,
        });
      });
      return;
    }

    console.log(`[electron-float] Detecting theme before first overlay injection...`);
    void detectAppThemeFromScreenshot(ws, send).then((theme) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      console.log(`[electron-float] Injecting overlay (first attempt, theme=${theme})...`);
      send('Runtime.evaluate', {
        expression: this.buildThemedBootstrap(theme, target),
        awaitPromise: false,
      });

      setTimeout(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (state.egressBlocked) return;

        const loaded = await this.probeOverlayIframeLoaded(ws, send);
        if (loaded && !state.egressBlocked) {
          console.log(`[electron-float] Overlay iframe loaded successfully — no CSP reload needed`);
          this.cspBypassedTargets.add(target.url);
          send('Network.disable');
          return;
        }
        if (state.egressBlocked) return;

        console.log(
          `[electron-float] Overlay iframe blocked by CSP, reloading with bypass: ${target.url}`
        );
        state.pendingReload = true;
        state.pendingCspEscalation = true;
        send('Page.reload', { ignoreCache: true });
      }, this.probeDelayMs);
    });
  }

  private handlePageLoadAfterReload(
    ws: WebSocket,
    send: CdpSend,
    target: ElectronInspectableTarget,
    state: ConnectFlowState
  ): void {
    state.pendingReload = false;
    console.log(
      `[electron-float] Page loaded after CSP reload, detecting theme and injecting overlay...`
    );
    if (ws.readyState !== WebSocket.OPEN) return;
    void detectAppThemeFromScreenshot(ws, send).then((theme) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      send('Runtime.evaluate', {
        expression: this.buildThemedBootstrap(theme, target),
        awaitPromise: false,
      });
    });

    if (state.pendingCspEscalation) {
      state.pendingCspEscalation = false;
      setTimeout(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        if (state.egressBlocked) return;
        const loaded = await this.probeOverlayIframeLoaded(ws, send);
        if (loaded && !state.egressBlocked) {
          console.log(`[electron-float] Overlay iframe loaded after CSP reload — no proxy needed`);
          this.cspBypassedTargets.add(target.url);
          send('Network.disable');
          return;
        }
        if (state.egressBlocked) return;

        const fetchOrigin = resolveFetchProxyOrigin(target.url, this.servePort);
        console.log(
          `[electron-float] CSP reload insufficient, escalating to Fetch proxy: target=${target.url} origin=${fetchOrigin}`
        );
        state.fetchProxyActive = true;
        send('Fetch.enable', {
          patterns: [{ urlPattern: `${fetchOrigin}/*`, requestStage: 'Request' }],
        });
        state.pendingReload = true;
        send('Page.reload', { ignoreCache: true });
      }, this.probeDelayMs);
    }
  }

  private handleFetchRequestPaused(
    ws: WebSocket,
    send: CdpSend,
    msg: CdpFetchRequestPausedEvent
  ): void {
    const requestId = msg.params?.requestId;
    if (!requestId) {
      console.warn('[electron-float] Fetch.requestPaused without requestId, skipping');
      return;
    }
    const request = msg.params?.request ?? {};
    const url = request.url || '';
    const method = request.method || 'GET';
    const requestHeaders = request.headers || {};

    const acceptHeader = requestHeaders['Accept'] || requestHeaders['accept'] || '';
    if (!acceptHeader.includes('text/html')) {
      send('Fetch.continueRequest', { requestId });
      return;
    }

    const postBody = decodeCdpRequestPostBody(request);
    if (postBody.kind === 'unrecoverable') {
      console.error(
        `[electron-float] Cannot recover POST body byte-exactly (${postBody.reason}); failing instead of forwarding corrupt bytes: ${url.substring(0, 60)}`
      );
      send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      return;
    }

    console.log(`[electron-float] Proxying request to strip CSP: ${url.substring(0, 60)}`);

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: buildProxyRequestHeaders(
        requestHeaders,
        postBody.kind === 'bytes' ? postBody.bytes.length : null
      ),
    };

    const proxyReq = transport.request(options, (proxyRes) => {
      const bodyChunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      proxyRes.on('end', () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const fullBody = Buffer.concat(bodyChunks);
        const { responseHeaders, strippedCSP } = buildFulfillResponseHeaders(
          proxyRes.headers,
          fullBody.length
        );

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
      console.error(
        `[electron-float] Proxy request failed for ${url.substring(0, 60)}:`,
        err.message
      );
      if (ws.readyState === WebSocket.OPEN) {
        send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      }
    });

    if (postBody.kind === 'bytes') {
      proxyReq.write(postBody.bytes);
    }
    proxyReq.end();
  }

  private handleNetworkEventForEgressBlock(
    msg: {
      method?: string;
      params?: {
        requestId?: string;
        type?: string;
        request?: { url?: string };
        errorText?: string;
      };
    },
    send: CdpSend,
    target: ElectronInspectableTarget,
    state: ConnectFlowState
  ): void {
    const params = msg.params;
    if (!params) return;

    if (msg.method === 'Network.requestWillBeSent') {
      if (
        params.type === 'Document' &&
        typeof params.requestId === 'string' &&
        typeof params.request?.url === 'string' &&
        params.request.url.includes(this.bridgeToken)
      ) {
        state.overlayRequestIds.add(params.requestId);
      }
      return;
    }

    if (
      msg.method === 'Network.loadingFailed' &&
      typeof params.requestId === 'string' &&
      state.overlayRequestIds.has(params.requestId) &&
      isOverlayEgressBlockError(params.errorText)
    ) {
      state.egressBlocked = true;

      send('Network.disable');
      if (!this.egressBlockedTargets.has(target.url)) {
        this.egressBlockedTargets.add(target.url);
        console.log(
          `[electron-float] Overlay blocked by app network egress (${params.errorText}); ` +
            `the hosted overlay cannot load in ${target.url} — skipping CSP/Fetch escalation. ` +
            `Egress-blocked apps need the CDP-over-CDP follower path.`
        );

        this.onEgressBlocked?.(target.url);
      }

      this.injectStatusOverlay(send);
    }
  }

  private injectStatusOverlay(send: CdpSend): void {
    send('Page.addScriptToEvaluateOnNewDocument', { source: this.thinBootstraps.status });
    send('Runtime.evaluate', { expression: this.thinBootstraps.status, awaitPromise: false });
  }

  private connectToTarget(target: ElectronInspectableTarget): void {
    const targetId = target.webSocketDebuggerUrl!;
    const ws = new WebSocket(targetId);
    this.connections.set(targetId, ws);

    let messageId = 1;
    const send: CdpSend = (method, params) => {
      const id = messageId++;
      ws.send(JSON.stringify({ id, method, params }));
      return id;
    };

    const state: ConnectFlowState = {
      pendingReload: false,
      pendingCspEscalation: false,
      fetchProxyActive: false,
      egressBlocked: false,
      overlayRequestIds: new Set<string>(),
    };

    let presenceTimer: ReturnType<typeof setInterval> | null = null;
    const clearPresenceTimer = () => {
      if (presenceTimer) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
    };

    ws.on('open', () => {
      this.handleSocketOpen(ws, send, target, state);
      presenceTimer = setInterval(() => {
        void this.reinjectIfEvicted(ws, send, target, state).catch(logPresenceReinjectionFailure);
      }, this.presenceCheckIntervalMs);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.method === 'Page.loadEventFired' && state.pendingReload) {
          this.handlePageLoadAfterReload(ws, send, target, state);
        }

        const isMainFrameNavigated =
          msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId;
        if (msg.method === 'Page.navigatedWithinDocument' || isMainFrameNavigated) {
          void this.reinjectIfEvicted(ws, send, target, state).catch(
            logNavigationReinjectionFailure
          );
        }

        if (msg.method === 'Fetch.requestPaused' && state.fetchProxyActive) {
          this.handleFetchRequestPaused(ws, send, msg);
        }

        this.handleNetworkEventForEgressBlock(msg, send, target, state);
      } catch {}
    });

    ws.on('close', () => {
      clearPresenceTimer();
      this.dropConnectionIfCurrent(targetId, ws);
    });

    ws.on('error', (error) => {
      clearPresenceTimer();
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[electron-float] Overlay target connection failed for ${target.url}:`,
        message
      );
      this.dropConnectionIfCurrent(targetId, ws);
    });
  }
}

interface ConnectFlowState {
  pendingReload: boolean;
  pendingCspEscalation: boolean;
  fetchProxyActive: boolean;

  egressBlocked: boolean;

  overlayRequestIds: Set<string>;
}
