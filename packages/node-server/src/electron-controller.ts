import { type ChildProcess, execFile as nodeExecFile, spawn } from 'child_process';
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
  buildElectronOverlayEntryUrl,
  ELECTRON_OVERLAY_APP_PATH,
  type ElectronInspectableTarget,
  getElectronOverlayEntryDistPath,
  getElectronServeOrigin,
  selectBestOverlayTargets,
} from './electron-runtime.js';

const execFile = promisify(nodeExecFile);
const ELECTRON_OVERLAY_SYNC_INTERVAL_MS = 1500;
/**
 * Cadence of the per-connection overlay presence re-check. Covers SPAs that
 * re-render their DOM root (evicting `#slicc-electron-overlay-root`) without
 * emitting any navigation event for the event-driven re-injection to hook.
 */
const ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS = 2000;

/**
 * Query param name used to mark the role of an overlay tab on the hosted
 * launcher URL. The pinned leader carries `role=leader`; auto-follow
 * followers carry `role=follower`. The hosted webapp interprets these to
 * decide which tab anchors the CDP bridge vs. follows the leader.
 */
export const BRIDGE_ROLE_QUERY_PARAM = 'role';
export const BRIDGE_ROLE_LEADER = 'leader';
export const BRIDGE_ROLE_FOLLOWER = 'follower';

/**
 * Thin-bridge coordinates for the Electron overlay. The injected overlay
 * always loads from a hosted launcher (`hostedLeaderOrigin`, defaulting to
 * production `https://www.sliccy.ai`) and dials back to the local `/cdp`
 * WebSocket using the per-process bridge token. This is the only overlay
 * path — the legacy bundled-UI overlay served from the local serve port
 * was retired.
 */
export interface ThinBridgeConfig {
  hostedLeaderOrigin: string;
  bridgeWsUrl: string;
  bridgeToken: string;
}

export type OverlayRole = typeof BRIDGE_ROLE_LEADER | typeof BRIDGE_ROLE_FOLLOWER;

/**
 * Build the thin-bridge config for the Electron overlay injector. The
 * hosted-leader origin defaults to production `https://www.sliccy.ai`
 * (overridable via `SLICC_HOSTED_LEADER_ORIGIN` / `WORKER_BASE_URL`), so
 * the only genuinely unresolvable case is a missing per-process bridge
 * token — in which case this returns `null` and the caller fails fast
 * rather than falling back to a (now-retired) bundled overlay.
 */
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
}

/**
 * Build the hosted launcher URL for an overlay injection. Mirrors the
 * standalone Path A launch-URL shape (`bridge`, `bridgeToken` query
 * params) with one Electron-specific addition: a `role` param that pins
 * the first injected tab as the leader and marks every subsequent tab as
 * an auto-follow follower.
 */
export function buildThinOverlayAppUrl(opts: ThinOverlayUrlOptions): string {
  const url = new URL(ELECTRON_OVERLAY_APP_PATH, opts.hostedLeaderOrigin);
  url.searchParams.set(BRIDGE_WS_QUERY_PARAM, opts.bridgeWsUrl);
  url.searchParams.set(BRIDGE_TOKEN_QUERY_PARAM, opts.bridgeToken);
  url.searchParams.set(BRIDGE_ROLE_QUERY_PARAM, opts.role);
  if (opts.activeTab && opts.activeTab !== 'chat') {
    url.searchParams.set('tab', opts.activeTab);
  }
  return url.toString();
}

/**
 * Resolve the hosted leader origin Chrome / Electron should open in thin
 * mode. Prefers explicit overrides (`SLICC_HOSTED_LEADER_ORIGIN`, then
 * `WORKER_BASE_URL`) so dev can point at staging; defaults to production
 * `https://www.sliccy.ai`. Trailing slashes are stripped so callers can
 * safely concatenate paths.
 */
export function resolveHostedLeaderOrigin(
  env: Record<string, string | undefined> = process.env
): string {
  const explicit = env['SLICC_HOSTED_LEADER_ORIGIN'] ?? env['WORKER_BASE_URL'];
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  return 'https://www.sliccy.ai';
}

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
    // (e.g. npx tsx packages/node-server/src/index.ts --electron /Applications/Slack.app)
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

// ---------------------------------------------------------------------------
// Theme detection — screenshot-based luminance analysis
// ---------------------------------------------------------------------------

/**
 * Parse the IHDR/IDAT/IEND chunks of a PNG buffer (signature already validated).
 * Other chunk types are intentionally skipped.
 */
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

    offset += 12 + chunkLength; // 4 (length) + 4 (type) + data + 4 (CRC)
  }

  return { width, height, bitDepth, colorType, idatChunks };
}

/**
 * Apply a single PNG row filter in place. Filter 0 (None) is a no-op so this
 * helper is not called for it. See the PNG spec §9 Filtering for details.
 */
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
      case 1: // Sub
        row[i] = (row[i]! + a) & 0xff;
        break;
      case 2: // Up
        row[i] = (row[i]! + b) & 0xff;
        break;
      case 3: // Average
        row[i] = (row[i]! + ((a + b) >>> 1)) & 0xff;
        break;
      case 4: {
        // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        row[i] = (row[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        break;
      }
      // case 0: None — no transformation needed
    }
  }
}

/**
 * Decode a base64 PNG into raw RGBA pixel data by parsing chunks and inflating.
 * Returns { width, height, pixels } where pixels is a Buffer of RGBA bytes.
 */
export function decodePngPixels(base64Data: string): {
  width: number;
  height: number;
  pixels: Buffer;
} {
  const buf = Buffer.from(base64Data, 'base64');

  // Validate PNG signature
  const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.subarray(0, 8).compare(PNG_SIGNATURE) !== 0) {
    throw new Error('Not a valid PNG');
  }

  const { width, height, bitDepth, colorType, idatChunks } = parsePngChunks(buf);

  if (width === 0 || height === 0) throw new Error('Missing IHDR chunk');
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);

  // Only support RGB (2) and RGBA (6) — CDP screenshots are always RGBA
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bytesPerPixel === 0) throw new Error(`Unsupported color type: ${colorType}`);

  const compressed = Buffer.concat(idatChunks);
  const inflated = inflateSync(compressed);

  // Each row has a 1-byte filter prefix followed by pixel data
  const rowBytes = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * 4); // Always output RGBA

  let prevRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowBytes);
    const filter = inflated[rowStart]!;
    const row = Buffer.from(inflated.subarray(rowStart + 1, rowStart + 1 + rowBytes));

    applyPngRowFilter(row, prevRow, filter, bytesPerPixel, rowBytes);

    for (let x = 0; x < width; x++) {
      const srcIdx = x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      pixels[dstIdx] = row[srcIdx]!; // R
      pixels[dstIdx + 1] = row[srcIdx + 1]!; // G
      pixels[dstIdx + 2] = row[srcIdx + 2]!; // B
      pixels[dstIdx + 3] = bytesPerPixel === 4 ? row[srcIdx + 3]! : 255; // A
    }

    prevRow = row;
  }

  return { width, height, pixels };
}

/**
 * Compute the average perceived luminance (0–255) from RGBA pixel data,
 * sampling a grid of pixels for performance.
 */
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
      // ITU-R BT.601 perceived luminance
      totalLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
      sampleCount++;
    }
  }

  return sampleCount > 0 ? totalLuminance / sampleCount : 128;
}

/**
 * Detect whether the target app is using a light or dark theme by taking
 * a CDP screenshot and analyzing the average luminance.
 * Returns 'light' or 'dark'.
 */
function detectAppThemeFromScreenshot(
  ws: WebSocket,
  send: (method: string, params?: Record<string, unknown>) => number
): Promise<'light' | 'dark'> {
  return new Promise((resolve) => {
    // Take a small JPEG screenshot for speed — we only need luminance
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
      } catch {
        /* ignore non-JSON messages */
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off('message', onMessage);
    };

    ws.on('message', onMessage);
  });
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

/**
 * Resolve the `Fetch.enable` origin pattern for CSP-bypass escalation. Mirrors
 * swift-server's `OverlayTargetSession.fetchProxyOrigin` (Wave 5): prefer the
 * parent page's http(s) origin so interception is byte-for-byte the same as
 * before, but for `file://` (or other no-http-origin) targets fall back to the
 * overlay iframe's own `http://localhost:<servePort>` origin — that is what
 * actually needs unblocking when the parent is a local file.
 */
export function resolveFetchProxyOrigin(targetUrl: string, servePort: number): string {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.origin;
    }
  } catch {
    // Fall through to the localhost fallback below.
  }
  return `http://localhost:${servePort}`;
}

/**
 * Translate a Node http(s) response's headers into the array shape required by
 * `Fetch.fulfillRequest`, stripping CSP and other hop-by-hop headers that are
 * invalid in fulfill responses and rewriting `content-length` to match the
 * actually-buffered body length. Returns whether any CSP header was stripped
 * so the caller can log it.
 */
function buildFulfillResponseHeaders(
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
    // Update content-length to match actual body size
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

/**
 * Pre-built bootstrap scripts for thin-mode injection — one per overlay
 * role. The injector picks `leader` for the first injected target and
 * `follower` for every subsequent target.
 */
export interface ThinBootstrapSet {
  leader: string;
  follower: string;
}

/**
 * JS probe that reports whether the overlay iframe actually loaded. Walks the
 * `<slicc-launcher>` host's (open) shadow root to find the iframe
 * depth-agnostically, then classifies by cross-origin reachability: the
 * thin-bridge overlay is ALWAYS a different origin (hosted webapp) than the
 * app document, so a committed cross-origin navigation makes
 * `iframe.contentWindow.location.href` THROW — that throw is the ONLY success
 * signal. Any READABLE href (`about:blank`, `''`, or a CSP-blocked swap to
 * `chrome-error://chromewebdata/`) means the cross-origin nav did NOT commit,
 * so the overlay did not load and the setBypassCSP escalation must fire.
 * Returns `'ok'` only from the catch; otherwise `'no-host' / 'no-iframe' /
 * 'no-src' / 'blank:<href>'`.
 */
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

/**
 * JS probe that reports whether the overlay was *evicted* — i.e. the
 * `window.__SLICC_ELECTRON_OVERLAY__` marker is still present (the bootstrap
 * ran at least once on this document) but the `#slicc-electron-overlay-root`
 * host element is gone, which happens when an SPA framework (React/Vue)
 * re-renders the DOM root out from under it on an in-page route change.
 * Returns `'evicted'` only in that exact state so re-injection is gated to the
 * genuine eviction case and never loops while the host element is still
 * attached. A full document replacement wipes the marker too, so that case
 * reports `'ok'` here and is covered by the new-document hook instead.
 */
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
  /** Thin-mode bootstrap pair — the only overlay path. */
  private readonly thinBootstraps: ThinBootstrapSet;
  private readonly probeDelayMs: number;
  private readonly presenceCheckIntervalMs: number;
  private readonly connections = new Map<string, WebSocket>();
  private readonly cspBypassedTargets = new Set<string>();
  /**
   * URL of the target currently elected as the pinned leader. Cleared by
   * `syncTargets` when that target disappears so the next injection
   * re-elects a fresh leader.
   */
  private leaderTargetUrl: string | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  private constructor(
    cdpPort: number,
    servePort: number,
    thinBootstraps: ThinBootstrapSet,
    probeDelayMs: number = 1500,
    presenceCheckIntervalMs: number = ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS
  ) {
    this.cdpPort = cdpPort;
    this.servePort = servePort;
    this.thinBootstraps = thinBootstraps;
    this.probeDelayMs = probeDelayMs;
    this.presenceCheckIntervalMs = presenceCheckIntervalMs;
  }

  static async create(options: {
    cdpPort: number;
    servePort: number;
    dev: boolean;
    projectRoot: string;
    /**
     * Thin-bridge coordinates: the overlay loads from the hosted launcher
     * with bridge-URL + token query params and tabs are split into one
     * pinned leader and N auto-follow followers. Required — the legacy
     * bundled overlay path was retired.
     */
    thinBridge: ThinBridgeConfig;
  }): Promise<ElectronOverlayInjector> {
    const bundleSource = await loadElectronOverlayBundleSource(options);

    const thinBootstraps: ThinBootstrapSet = {
      leader: buildElectronOverlayBootstrapScript({
        bundleSource,
        appUrl: buildThinOverlayAppUrl({ ...options.thinBridge, role: BRIDGE_ROLE_LEADER }),
      }),
      follower: buildElectronOverlayBootstrapScript({
        bundleSource,
        appUrl: buildThinOverlayAppUrl({ ...options.thinBridge, role: BRIDGE_ROLE_FOLLOWER }),
      }),
    };

    return new ElectronOverlayInjector(options.cdpPort, options.servePort, thinBootstraps);
  }

  /**
   * Test-only factory: skips bundle loading and lets tests drive the per-target
   * connect flow directly with a controllable probe delay. Mirrors swift-server's
   * `_testing_*` hooks on `ElectronOverlayInjector`.
   */
  static _createForTesting(options: {
    cdpPort?: number;
    servePort: number;
    thinBootstraps?: ThinBootstrapSet;
    probeDelayMs?: number;
    presenceCheckIntervalMs?: number;
  }): ElectronOverlayInjector {
    return new ElectronOverlayInjector(
      options.cdpPort ?? 9223,
      options.servePort,
      options.thinBootstraps ?? { leader: '/* test-leader */', follower: '/* test-follower */' },
      options.probeDelayMs ?? 1500,
      options.presenceCheckIntervalMs ?? ELECTRON_OVERLAY_PRESENCE_CHECK_INTERVAL_MS
    );
  }

  /** Test-only: snapshot the elected leader target URL (null when no leader). */
  _testingLeaderTargetUrl(): string | null {
    return this.leaderTargetUrl;
  }

  /** Test-only: seed the elected leader (drives the follower-election path). */
  _testingSeedLeaderTargetUrl(url: string | null): void {
    this.leaderTargetUrl = url;
  }

  /** Test-only: drive the per-target connect flow without going through `start`. */
  _testingConnectToTarget(target: ElectronInspectableTarget): void {
    this.connectToTarget(target);
  }

  /** Test-only: seed the per-target "already bypassed" guard. */
  _testingSeedBypassedTarget(url: string): void {
    this.cspBypassedTargets.add(url);
  }

  /** Test-only: snapshot the per-target "already bypassed" guard set. */
  _testingBypassedTargets(): ReadonlySet<string> {
    return new Set(this.cspBypassedTargets);
  }

  /** Test-only: drive a single `syncTargets` pass without `start()`'s interval. */
  async _testingSyncTargets(): Promise<void> {
    await this.syncTargets();
  }

  /** Test-only: close any sockets opened by `_testingConnectToTarget`. */
  _testingCloseConnections(): void {
    for (const connection of this.connections.values()) {
      try {
        connection.close();
      } catch {
        // Ignore connection cleanup failures.
      }
    }
    this.connections.clear();
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

      // Thin mode: drop the elected leader if its target is no longer
      // present so the next injection re-elects. Without this a stale
      // leaderTargetUrl would block every future tab from becoming the
      // pinned leader after the original leader closed.
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
   * Check if the overlay iframe loaded successfully by evaluating a probe
   * script. Walks the `<slicc-launcher>` host's (open) shadow root to find the
   * iframe depth-agnostically and classifies by cross-origin reachability: the
   * thin-bridge overlay is ALWAYS a different origin than the app document, so
   * only a THROW on `iframe.contentWindow.location.href` (a committed
   * cross-origin navigation) counts as loaded. Any readable href — including a
   * CSP-blocked swap to `chrome-error://chromewebdata/` — means the nav did not
   * commit, so the Fetch-proxy escalation must still fire.
   * See {@link OVERLAY_LOADED_PROBE_EXPRESSION}.
   */
  private async probeOverlayIframeLoaded(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number
  ): Promise<boolean> {
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
        } catch {
          /* ignore */
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
      };

      ws.on('message', onMessage);
    });
  }

  /**
   * Pick the bootstrap script for `target`, electing the leader on first
   * use when thin-mode is active. Same target URL ↔ same role across
   * reconnects so a page that bounces its CDP session stays the leader
   * (no re-election on transient drops, only on `syncTargets` cleanup).
   */
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

  /**
   * Build a script that sets the SLICC theme preference in localStorage to
   * match the target app's detected theme, then runs the bootstrap. The
   * bootstrap is target-specific (leader vs. follower).
   */
  private buildThemedBootstrap(theme: 'light' | 'dark', target: ElectronInspectableTarget): string {
    const themeScript = `try{localStorage.setItem('slicc-theme',${JSON.stringify(theme)})}catch(e){}`;
    return `${themeScript}\n${this.resolveBootstrapForTarget(target)}`;
  }

  /**
   * Wrap the target's role bootstrap in a top-frame guard for use as a
   * `Page.addScriptToEvaluateOnNewDocument` source. The hook fires in every
   * frame of a new document, so without the guard the overlay iframe (the
   * hosted webapp, which also ships `__SLICC_ELECTRON_OVERLAY__`) would re-run
   * the bootstrap inside itself and recurse. Re-using `resolveBootstrapForTarget`
   * keeps the re-injected overlay's leader/follower role stable.
   */
  private buildNewDocumentBootstrap(target: ElectronInspectableTarget): string {
    const bootstrap = this.resolveBootstrapForTarget(target);
    return `(function(){try{if(window.top!==window.self)return;}catch(e){return;}\n${bootstrap}\n})();`;
  }

  /**
   * Evaluate {@link OVERLAY_EVICTED_PROBE_EXPRESSION} on the target and resolve
   * `true` only when the overlay marker is present but the host element is gone
   * — the SPA-DOM-root eviction case that re-injection must repair. Mirrors
   * {@link probeOverlayIframeLoaded}'s one-shot message-listener pattern.
   */
  private async probeOverlayEvicted(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number
  ): Promise<boolean> {
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
        } catch {
          /* ignore */
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', onMessage);
      };

      ws.on('message', onMessage);
    });
  }

  /**
   * Re-inject the overlay if (and only if) it was evicted from an
   * already-connected target — an in-page SPA route change or DOM-root
   * re-render that removed `#slicc-electron-overlay-root` while the
   * `__SLICC_ELECTRON_OVERLAY__` marker persists. Gated on the eviction probe
   * so it is idempotent and never loops while the host element is still
   * attached, and skipped while the CSP-bypass reload / Fetch-proxy escalation
   * owns injection (`pendingReload`). Re-uses the target's existing role
   * bootstrap, so no leader/follower re-election occurs.
   */
  private async reinjectIfEvicted(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number,
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

  /**
   * Handle the initial CDP `ws.on('open', ...)` event for a target: enable
   * Runtime/Page, set CSP bypass, detect theme, inject the overlay, and (on a
   * first connect) probe whether the overlay iframe actually loaded — falling
   * back to a CSP-bypass reload by setting `state.pendingReload` and
   * `state.pendingCspEscalation` for the message handler to continue from.
   *
   * Mutating flow flags (`pendingReload`, `pendingCspEscalation`,
   * `fetchProxyActive`) live on the shared `state` object so this helper
   * preserves the original closure-driven control flow exactly.
   */
  private handleSocketOpen(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number,
    target: ElectronInspectableTarget,
    state: ConnectFlowState
  ): void {
    const alreadyBypassed = this.cspBypassedTargets.has(target.url);
    console.log(
      `[electron-float] Connected to target, bypassed=${alreadyBypassed}, url=${target.url}`
    );

    send('Runtime.enable');
    send('Page.enable');

    // Install the role bootstrap as a permanent new-document hook (parity with
    // swift-server) so a full document reload / load-driven navigation of this
    // already-connected target re-injects the overlay automatically. Without
    // this, `syncTargets` only injects into brand-new CDP targets, so a reload
    // of an existing target would lose the overlay permanently (the marker is
    // wiped along with the host element, so the eviction re-check below can't
    // recover it).
    send('Page.addScriptToEvaluateOnNewDocument', {
      source: this.buildNewDocumentBootstrap(target),
    });

    // Set CSP bypass — affects future resource loads on the current page
    send('Page.setBypassCSP', { enabled: true });

    if (alreadyBypassed) {
      // Already reloaded with CSP bypass previously — detect theme and inject
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

    // First connection to this target URL: detect theme, then inject overlay.
    // After injection, probe whether the iframe loaded; if CSP blocked it, fall
    // back to reload+proxy. We probe/escalate regardless of URL scheme — file://
    // (and app://-style local) Electron renderers can still ship a meta CSP
    // (e.g. AEM Desktop's `default-src 'self'`) that blocks the overlay iframe.
    console.log(`[electron-float] Detecting theme before first overlay injection...`);
    void detectAppThemeFromScreenshot(ws, send).then((theme) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      console.log(`[electron-float] Injecting overlay (first attempt, theme=${theme})...`);
      send('Runtime.evaluate', {
        expression: this.buildThemedBootstrap(theme, target),
        awaitPromise: false,
      });

      // After a short delay, probe whether the overlay iframe loaded.
      // If CSP blocked it, reload the page so Page.setBypassCSP takes effect.
      // If that still doesn't work, escalate to the Fetch proxy.
      setTimeout(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const loaded = await this.probeOverlayIframeLoaded(ws, send);
        if (loaded) {
          console.log(`[electron-float] Overlay iframe loaded successfully — no CSP reload needed`);
          this.cspBypassedTargets.add(target.url);
          return;
        }

        // Phase 2: Page.setBypassCSP was already set — a simple reload should
        // make the browser ignore CSP headers on the fresh navigation.
        // Deliberately do NOT recordBypassed yet — if the CDP session
        // disconnects mid-reload (AEM Desktop's bootstrap recreates the
        // execution context, which closes our WS), the next reconnect
        // needs to re-run the reload path. Only record once the post-reload
        // probe confirms the iframe loaded. Mirrors swift-server d1c9f14d
        // (`shouldRecordBypassedAfter(probeAction:)` returns false for
        // `.reloadWithBypass`).
        console.log(
          `[electron-float] Overlay iframe blocked by CSP, reloading with bypass: ${target.url}`
        );
        state.pendingReload = true;
        state.pendingCspEscalation = true;
        send('Page.reload', { ignoreCache: true });
      }, this.probeDelayMs);
    });
  }

  /**
   * Handle `Page.loadEventFired` after a CSP-bypass reload: re-inject the
   * themed overlay, then (if this load came from the simple-reload path) probe
   * the iframe again and, if still blocked, escalate to the Fetch HTTP proxy
   * which strips CSP from the document response. The proxy reload also sets
   * `pendingReload` again so the next `loadEventFired` re-injects on top of
   * the stripped response.
   */
  private handlePageLoadAfterReload(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number,
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

    // If this was a simple reload (no proxy), check if the iframe loads now.
    // If it still doesn't, escalate to the Fetch proxy as a last resort.
    if (state.pendingCspEscalation) {
      state.pendingCspEscalation = false;
      setTimeout(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const loaded = await this.probeOverlayIframeLoaded(ws, send);
        if (loaded) {
          console.log(`[electron-float] Overlay iframe loaded after CSP reload — no proxy needed`);
          this.cspBypassedTargets.add(target.url);
          return;
        }

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

  /**
   * Handle a single `Fetch.requestPaused` event under the active Fetch proxy:
   * pass non-HTML requests straight through with `Fetch.continueRequest`, and
   * proxy HTML document requests through Node http/https so the response can
   * be returned via `Fetch.fulfillRequest` with CSP and hop-by-hop headers
   * stripped. `Fetch.fulfillRequest` is intentionally fire-and-forget — there
   * is no CDP reply for fulfill, and the response body is the document body.
   */
  private handleFetchRequestPaused(
    ws: WebSocket,
    send: (method: string, params?: Record<string, unknown>) => number,
    msg: { params?: { requestId?: string; request?: Record<string, unknown> } }
  ): void {
    const requestId = msg.params?.requestId;
    if (!requestId) {
      console.warn('[electron-float] Fetch.requestPaused without requestId, skipping');
      return;
    }
    const request = (msg.params?.request ?? {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      postData?: string;
    };
    const url = request.url || '';
    const method = request.method || 'GET';
    const requestHeaders = request.headers || {};
    const postData = request.postData;

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

    // Forward request body if present (for POST/PUT requests)
    if (postData) {
      proxyReq.write(postData);
    }
    proxyReq.end();
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

    const state: ConnectFlowState = {
      pendingReload: false,
      pendingCspEscalation: false,
      fetchProxyActive: false,
    };

    // Periodic presence re-check: covers SPAs that re-render their DOM root
    // (evicting the overlay) without firing a navigation event. Cleared on
    // close/error so it never outlives the connection.
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
        void this.reinjectIfEvicted(ws, send, target, state).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[electron-float] Presence-check re-injection failed: ${message}`);
        });
      }, this.presenceCheckIntervalMs);
    });

    // Handle CDP events: lifecycle events and Fetch interception
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Inject overlay after page load completes (after CSP-bypass reload)
        if (msg.method === 'Page.loadEventFired' && state.pendingReload) {
          this.handlePageLoadAfterReload(ws, send, target, state);
        }

        // In-page SPA route change (history.pushState / hashchange) — no new
        // document is created, so the new-document hook never fires. Re-inject
        // the role bootstrap if the host element was evicted. `Page.frameNavigated`
        // is handled only for the main frame (subframe navs never touch the
        // top-level overlay), and the eviction probe keeps the main-frame full
        // navigation a no-op (its marker is wiped, so the new-document hook owns it).
        const isMainFrameNavigated =
          msg.method === 'Page.frameNavigated' && !msg.params?.frame?.parentId;
        if (msg.method === 'Page.navigatedWithinDocument' || isMainFrameNavigated) {
          void this.reinjectIfEvicted(ws, send, target, state).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[electron-float] Navigation re-injection failed: ${message}`);
          });
        }

        if (msg.method === 'Fetch.requestPaused' && state.fetchProxyActive) {
          this.handleFetchRequestPaused(ws, send, msg);
        }
      } catch {
        // Ignore parse errors for non-JSON messages
      }
    });

    ws.on('close', () => {
      clearPresenceTimer();
      if (this.connections.get(targetId) === ws) {
        this.connections.delete(targetId);
      }
    });

    ws.on('error', (error) => {
      clearPresenceTimer();
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

/**
 * Per-connection control-flow flags shared between `handleSocketOpen`,
 * `handlePageLoadAfterReload`, and the message-loop in `connectToTarget`.
 * Lifted out of the closure so the helpers stay below the function-size cap
 * while preserving the original mutate-from-multiple-handlers semantics.
 */
interface ConnectFlowState {
  pendingReload: boolean;
  pendingCspEscalation: boolean;
  fetchProxyActive: boolean;
}
