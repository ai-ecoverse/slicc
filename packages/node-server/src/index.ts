#!/usr/bin/env node
import { promises as fsPromises } from 'node:fs';
import { createSubstrate } from '@slicc/cloud-core';
import { type ChildProcess, spawn } from 'child_process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { createServer, type Server as HttpServer } from 'http';
import { createServer as createNetServer } from 'net';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isLoopbackBridgeOrigin,
  resolveServerBridgeToken,
  selectBridgeSubprotocol,
  validateBridgeToken,
  validateBridgeUpgrade,
} from './bridge-security.js';
import { applyCdpUnmask } from './cdp-proxy/cdp-unmask.js';
import { createCdpSessionUrlTracker } from './cdp-proxy/session-url-tracker.js';
import {
  buildChromeLaunchArgs,
  clearStaleDevToolsActivePort,
  ensureQaProfileScaffold,
  findChromeExecutable,
  legacyChromeCandidates,
  migrateLegacyDefaultChromeProfile,
  planChromeSpawn,
  resolveChromeLaunchProfile,
  waitForCdpPort,
} from './chrome-launch.js';
import { CliLogDedup } from './cli-log-dedup.js';
import { type ParsedCloudArgs, parseCloudArgs } from './cloud/dispatch.js';
import { runKill } from './cloud/kill.js';
import { runList } from './cloud/list.js';
import { runPause } from './cloud/pause.js';
import { FileRegistry } from './cloud/registry-file.js';
import { runResume } from './cloud/resume.js';
import { runStart } from './cloud/start.js';
import { registerCloudStatusEndpoint } from './cloud-status.js';
import {
  ElectronAppAlreadyRunningError,
  ElectronOverlayInjector,
  launchElectronApp,
  resolveOverlayThinBridge,
} from './electron-controller.js';
import { getElectronAppPorts } from './electron-runtime.js';
import { FileLogger } from './file-logger.js';
import { registerHostedBootstrapEndpoint } from './hosted-bootstrap.js';
import { resolveCliBrowserLaunchUrl } from './launch-url.js';
import { createHttpCdp, registerLeaderRestartEndpoint } from './leader-restart.js';
import { buildLocalApiDescriptor, sliccLinksMiddleware } from './links-middleware.js';
import { registerFetchProxyRoute } from './routes/fetch-proxy.js';
import { registerHandoffRoute } from './routes/handoff.js';
import { registerLickApiRoutes } from './routes/lick-api.js';
import { createLickBridge } from './routes/lick-bridge.js';
import { registerOAuthCallbackRoutes } from './routes/oauth-callback.js';
import { registerSecretRoutes } from './routes/secrets.js';
import { parseCliRuntimeFlags } from './runtime-flags.js';
import { EnvSecretStore } from './secrets/env-secret-store.js';
import { OauthSecretStore } from './secrets/oauth-secret-store.js';
import { SecretProxyManager } from './secrets/proxy-manager.js';
import { readOrCreateSessionId } from './secrets/session-id-file.js';
import { registerSecretsReloadEndpoint } from './secrets-reload-endpoint.js';
import { registerSudoApproveEndpoint } from './sudo/endpoint.js';
import { attachUiServing } from './ui-serving.js';

const Dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(Dirname, '..', '..');

// ---------------------------------------------------------------------------
// Cloud dispatcher — must run BEFORE any other boot logic
// ---------------------------------------------------------------------------
const _parsedCloudArgs = parseCloudArgs(process.argv.slice(2));
if (_parsedCloudArgs) {
  await runCloudSubcommand(_parsedCloudArgs);
  process.exit(0);
}

const RUNTIME_FLAGS = parseCliRuntimeFlags(process.argv.slice(2));

// Version command — exit immediately, no side effects
if (RUNTIME_FLAGS.version) {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const DEV_MODE = RUNTIME_FLAGS.dev;
const SERVE_ONLY = RUNTIME_FLAGS.serveOnly;
const ELECTRON_MODE = RUNTIME_FLAGS.electron;
const ELECTRON_APP = RUNTIME_FLAGS.electronApp;
const KILL_EXISTING_ELECTRON_APP = RUNTIME_FLAGS.kill;
/**
 * Standalone thin-bridge mode: production CLI with no bundled UI. The
 * launched Chrome opens a sliccy.ai-hosted leader; node-server is a thin
 * /cdp bridge + /api surface. Dev / electron / serve-only / hosted all
 * keep the bundled UI path (a separate path B / hosted task covers those).
 */
const THIN_BRIDGE_MODE = !DEV_MODE && !SERVE_ONLY && !ELECTRON_MODE && !RUNTIME_FLAGS.hosted;

// ---------------------------------------------------------------------------
// File logger — persistent log file in ~/.slicc/logs/
// ---------------------------------------------------------------------------
const fileLogger = new FileLogger({
  logDir: RUNTIME_FLAGS.logDir ?? undefined,
  logLevel: RUNTIME_FLAGS.logLevel,
  devMode: DEV_MODE,
});
if (fileLogger.logFile) {
  console.log(`Log file: ${fileLogger.logFile}`);
}

// ---------------------------------------------------------------------------
// Request logging middleware
// ---------------------------------------------------------------------------

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const { method, url } = req;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const tag = status >= 400 ? '\x1b[31m' : status >= 300 ? '\x1b[33m' : '\x1b[32m';
    const reset = '\x1b[0m';
    console.log(`${tag}${status}${reset} ${method} ${url} ${duration}ms`);
  });

  next();
}

// ---------------------------------------------------------------------------
// CDP helper — wait for the DevTools WebSocket endpoint to become available
// ---------------------------------------------------------------------------

async function waitForCDP(port: number, retries = 30, delayMs = 500): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl: string };
      return json.webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`CDP did not become available on port ${port}`);
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_RESET = '\x1b[0m';

function pipeChildOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[${label}:out] ${data}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[${label}:err] ${data}`);
  });
}

// ---------------------------------------------------------------------------
// Port selection — tries the preferred port, falls back to OS-assigned
// ---------------------------------------------------------------------------

function tryListenOnPort(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const assignedPort = addr && typeof addr === 'object' ? addr.port : port;
      server.close(() => resolve(assignedPort));
    });
  });
}

/**
 * Check that a port is free on both IPv4 (127.0.0.1) and IPv6 (::1).
 * On macOS, `localhost` resolves to `::1`, so a server bound only on
 * 127.0.0.1 is invisible to browsers connecting via `localhost`.
 * Checking both address families avoids dual-stack port conflicts
 * (e.g. a stale Vite process on `::1` while Express binds `127.0.0.1`).
 */
async function tryListenOnPortDualStack(port: number): Promise<number> {
  const assignedPort = await tryListenOnPort(port, '127.0.0.1');
  try {
    await tryListenOnPort(assignedPort, '::1');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw Object.assign(new Error(`Port ${assignedPort} in use on IPv6`), { code: 'EADDRINUSE' });
    }
    // ::1 may not be available on some systems — ignore non-EADDRINUSE errors
  }
  return assignedPort;
}

async function findAvailablePort(preferred: number): Promise<number> {
  try {
    return await tryListenOnPortDualStack(preferred);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return tryListenOnPort(0, '127.0.0.1');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CDP console forwarder — forwards in-page console output to CLI stdout
// ---------------------------------------------------------------------------

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: {
    description?: string;
    properties?: Array<{ name: string; type: string; value: string; subtype?: string }>;
    overflow?: boolean;
  };
}

function formatPreviewProperties(
  properties: Array<{ name: string; type: string; value: string; subtype?: string }>
): string {
  return properties
    .map((p) => {
      let val: string;
      if (p.type === 'object') val = p.subtype === 'array' ? '[...]' : '{...}';
      else if (p.type === 'string') val = `"${p.value}"`;
      else val = p.value;
      return `${p.name}: ${val}`;
    })
    .join(', ');
}

function formatRemoteObject(obj: RemoteObject): string {
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'object' && obj.subtype === 'null') return 'null';

  // Format objects/arrays using preview properties when available
  if (obj.type === 'object' && obj.preview?.properties && obj.preview.properties.length > 0) {
    const inner = formatPreviewProperties(obj.preview.properties);
    const suffix = obj.preview.overflow ? ', ...' : '';
    if (obj.subtype === 'array') return `[${inner}${suffix}]`;
    return `{ ${inner}${suffix} }`;
  }

  if (obj.preview?.description) return obj.preview.description;
  if (obj.description !== undefined) return obj.description;
  if (obj.value !== undefined) return String(obj.value);
  return `[${obj.type}]`;
}

function colorForType(type: string): string {
  switch (type) {
    case 'error':
      return ANSI_RED;
    case 'warning':
      return ANSI_YELLOW;
    default:
      return ANSI_CYAN;
  }
}

async function findPageTarget(
  cdpPort: number,
  pageUrl: string
): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = (await res.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const match = targets.find(
      (t) => t.type === 'page' && t.url.includes(`localhost:${pageUrl}`) && t.webSocketDebuggerUrl
    );
    return match ? { webSocketDebuggerUrl: match.webSocketDebuggerUrl! } : null;
  } catch {
    return null;
  }
}

async function attachConsoleForwarder(cdpPort: number, pageUrl: string): Promise<void> {
  const pageDedup = new CliLogDedup('[page]');
  const connect = async () => {
    // Poll for the page target
    let target: { webSocketDebuggerUrl: string } | null = null;
    for (let i = 0; i < 20; i++) {
      target = await findPageTarget(cdpPort, pageUrl);
      if (target) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!target) {
      console.log('[page] Could not find page target — console forwarding disabled');
      return;
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          method?: string;
          params?: Record<string, unknown>;
        };

        if (msg.method === 'Runtime.consoleAPICalled') {
          const params = msg.params as {
            type: string;
            args: RemoteObject[];
          };
          const type = params.type;
          const color = colorForType(type);
          const argsStr = params.args.map(formatRemoteObject).join(' ');
          const line = `[page:${type}] ${argsStr}`;
          if (pageDedup.shouldLog(line)) {
            console.log(`${color}[page:${type}]${ANSI_RESET} ${argsStr}`);
          }
        }

        if (msg.method === 'Runtime.exceptionThrown') {
          const params = msg.params as {
            exceptionDetails: {
              text: string;
              exception?: RemoteObject;
              stackTrace?: {
                callFrames: Array<{
                  functionName: string;
                  url: string;
                  lineNumber: number;
                  columnNumber: number;
                }>;
              };
            };
          };
          const details = params.exceptionDetails;
          const desc = details.exception?.description ?? details.text;
          console.log(`${ANSI_RED}[page:exception]${ANSI_RESET} ${desc}`);
          if (details.stackTrace) {
            for (const frame of details.stackTrace.callFrames) {
              const fn = frame.functionName || '<anonymous>';
              console.log(
                `${ANSI_RED}    at ${fn} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})${ANSI_RESET}`
              );
            }
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      // Reconnect after a short delay (page may have reloaded)
      setTimeout(() => {
        connect();
      }, 1000);
    });

    ws.on('error', () => {
      // Error will trigger close, which handles reconnection
    });
  };

  await connect();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const PREFERRED_SERVE_PORT = parseInt(process.env['PORT'] ?? '5710', 10);
const PREFERRED_CDP_PORT = RUNTIME_FLAGS.cdpPort;

/** Shared, mutable lifecycle state threaded through the boot + shutdown flow. */
interface ServerState {
  servePort: number;
  cdpPort: number;
  /** CDP port requested at launch (0 = let Chrome pick); distinct from the resolved cdpPort. */
  requestedCdpPort: number;
  serveOrigin: string;
  launchedBrowserProcess: ChildProcess | null;
  launchedBrowserLabel: string;
  overlayInjector: ElectronOverlayInjector | null;
  shuttingDown: boolean;
  discoveredTrayJoinUrl: string | null;
  /**
   * Per-process subprotocol token for the thin /cdp bridge. Minted in
   * `THIN_BRIDGE_MODE`; inherited from `SLICC_BRIDGE_TOKEN` when an
   * Electron host (or other parent) forwarded one — that's how the
   * Electron float's `--serve-only` child gates `/cdp` against the
   * same token the float's `BrowserWindow` carries. Null in remaining
   * legacy modes — `/cdp` stays ungated there because the connecting
   * client is always same-origin.
   */
  bridgeToken: string | null;
  // CDP WebSocket proxy state (one Chrome connection, swapped client).
  cdpUrl: string | null;
  chromeWs: WebSocket | null;
  activeClientWs: WebSocket | null;
  messageBuffer: unknown[] | null;
}

function createServerState(): ServerState {
  return {
    servePort: 0,
    cdpPort: 0,
    requestedCdpPort: 0,
    serveOrigin: '',
    launchedBrowserProcess: null,
    launchedBrowserLabel: 'Browser',
    overlayInjector: null,
    shuttingDown: false,
    discoveredTrayJoinUrl: RUNTIME_FLAGS.joinUrl ?? null,
    bridgeToken: resolveServerBridgeToken(process.env, { thinBridgeMode: THIN_BRIDGE_MODE }),
    cdpUrl: null,
    chromeWs: null,
    activeClientWs: null,
    messageBuffer: null,
  };
}

/**
 * Resolve the serve + CDP ports before anything else — the serve port must be
 * known before Chrome launches (the launch URL embeds it). Electron apps may
 * use a hash-derived dynamic port pair; otherwise we probe the preferred serve
 * port and let Chrome pick its own CDP port (requestedCdpPort=0).
 */
async function resolvePorts(state: ServerState): Promise<void> {
  let usingDynamicElectronPorts = false;
  if (ELECTRON_MODE && ELECTRON_APP && !RUNTIME_FLAGS.explicitCdpPort) {
    const ports = await getElectronAppPorts(ELECTRON_APP);
    state.cdpPort = ports.cdpPort;
    state.servePort = ports.servePort;
    state.requestedCdpPort = ports.cdpPort;
    usingDynamicElectronPorts = true;
  } else {
    state.servePort = await findAvailablePort(PREFERRED_SERVE_PORT);
    // Pass 0 for Chrome CDP so Chrome picks an available port (parsed from its
    // stderr) — avoids a race where Node's probe succeeds but Chrome can't bind.
    // Electron / serve-only modes keep the preferred port: in both cases the
    // CDP target is external (Electron app, or a user-launched Chrome / a
    // Playwright-launched Chrome with --remote-debugging-port=<PREFERRED>),
    // so the proxy needs the exact port up front.
    const useExternalCdpPort = ELECTRON_MODE || SERVE_ONLY;
    state.requestedCdpPort = useExternalCdpPort ? PREFERRED_CDP_PORT : 0;
    state.cdpPort = useExternalCdpPort ? PREFERRED_CDP_PORT : 0;
  }
  state.serveOrigin = `http://localhost:${state.servePort}`;

  if (usingDynamicElectronPorts) {
    console.log(
      `Dynamic port allocation for Electron app: CDP=${state.cdpPort}, serve=${state.servePort}`
    );
  } else if (state.servePort !== PREFERRED_SERVE_PORT) {
    console.log(`Port ${PREFERRED_SERVE_PORT} in use, serving on port ${state.servePort}`);
  }
  if (DEV_MODE) console.log('Starting in dev mode (Vite HMR enabled)');
  if (SERVE_ONLY) {
    console.log(`Starting in serve-only mode (reusing external CDP on port ${state.cdpPort})`);
  }
  if (ELECTRON_MODE) console.log('Starting in Electron mode');
}

/** Launch Chrome / Electron unless an external CDP provider is already running. */
async function launchBrowser(state: ServerState): Promise<void> {
  if (ELECTRON_MODE && !SERVE_ONLY) {
    await launchElectronTarget(state);
  } else if (!SERVE_ONLY) {
    await launchChromeTarget(state);
  }
}

/**
 * Poll an existing leader on the preferred port for its tray join URL. The
 * leader may still be minting its tray session, so retry a few times.
 */
async function discoverLeaderTrayJoinUrl(): Promise<string | null> {
  const leaderOrigin = `http://localhost:${PREFERRED_SERVE_PORT}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch(`${leaderOrigin}/api/tray-status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) break;
      const status = (await resp.json()) as { state?: string; joinUrl?: string | null };
      if (status.joinUrl) {
        console.log(`Discovered leader tray join URL: ${status.joinUrl}`);
        return status.joinUrl;
      }
      if (status.state === 'connecting') {
        // Leader is still setting up — wait and retry.
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.log(
          `Leader on port ${PREFERRED_SERVE_PORT} has no active tray (state: ${status.state ?? 'unknown'})`
        );
        break;
      }
    } catch {
      // Leader not reachable or no tray status endpoint — continue without tray.
      break;
    }
  }
  return null;
}

/**
 * Race the Electron app's CDP becoming available against the app exiting. A
 * quick exit before CDP connects usually means remote debugging is fused off.
 */
async function waitForElectronCdp(state: ServerState, displayName: string): Promise<void> {
  const child = state.launchedBrowserProcess!;
  let cdpConnected = false;
  let exitCode: number | null = null;
  let exitResolve: (() => void) | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  child.on('exit', (code) => {
    exitCode = code;
    exitResolve?.();
    if (state.shuttingDown) return;
    if (cdpConnected) {
      console.log(`${displayName} exited with code ${code}`);
      process.exit(0);
    }
    // CDP not yet connected — let waitForCDP handle it.
  });

  console.log(`Waiting for ${displayName} CDP on port ${state.cdpPort}...`);
  try {
    await Promise.race([
      waitForCDP(state.cdpPort, 40, 500).then(() => {
        cdpConnected = true;
      }),
      exitPromise.then(() => {
        if (!cdpConnected) throw new Error('app-exited');
      }),
    ]);
  } catch (_err) {
    if (exitCode !== null) {
      console.error(
        `\n${displayName} exited with code ${exitCode} before remote debugging was available.`
      );
      console.error(
        'This usually means the app has disabled remote debugging (EnableNodeCliInspectArguments fuse).'
      );
      console.error(
        'Some Electron apps disable this for security. Check if there is a developer/debug build available.\n'
      );
      process.exit(1);
    }
    throw new Error(`Could not connect to ${displayName} CDP on port ${state.cdpPort}`);
  }
}

async function launchElectronTarget(state: ServerState): Promise<void> {
  if (!ELECTRON_APP) {
    console.error(
      'Electron mode requires an app path. Pass --electron <path> or --electron-app=<path>.'
    );
    process.exit(1);
  }

  try {
    const { child, displayName } = await launchElectronApp({
      appPath: ELECTRON_APP,
      cdpPort: state.cdpPort,
      kill: KILL_EXISTING_ELECTRON_APP,
    });

    state.launchedBrowserProcess = child;
    state.launchedBrowserLabel = displayName;
    pipeChildOutput(child, 'electron-app');

    await waitForElectronCdp(state, displayName);
    console.log(`Connected to ${displayName} on CDP port ${state.cdpPort}`);

    // Auto-discover the leader's tray join URL when another instance is on the preferred port.
    if (!state.discoveredTrayJoinUrl && state.servePort !== PREFERRED_SERVE_PORT) {
      state.discoveredTrayJoinUrl = await discoverLeaderTrayJoinUrl();
    }
  } catch (error: unknown) {
    if (error instanceof ElectronAppAlreadyRunningError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Resolve the leader origin Chrome should open in thin-bridge mode. Prefers
 * an explicit `--lead <url>` / `WORKER_BASE_URL` so dev can point at staging;
 * defaults to production sliccy.ai.
 */
function resolveThinLeaderOrigin(): string {
  const explicit = RUNTIME_FLAGS.leadWorkerBaseUrl ?? process.env['WORKER_BASE_URL'] ?? null;
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  return 'https://www.sliccy.ai';
}

/** Build the Chrome launch URL, appending hosted-runtime + prompt query params. */
function buildBrowserLaunchUrl(state: ServerState): string {
  // Thin-bridge standalone: Chrome opens the hosted leader directly; the
  // local node-server serves no UI at all. Bridge coordinates ride as
  // query params so the leader can discover + authenticate /cdp.
  const serveOriginForLaunch =
    THIN_BRIDGE_MODE && state.bridgeToken ? resolveThinLeaderOrigin() : state.serveOrigin;

  let url = resolveCliBrowserLaunchUrl({
    serveOrigin: serveOriginForLaunch,
    lead: RUNTIME_FLAGS.lead,
    leadWorkerBaseUrl: RUNTIME_FLAGS.leadWorkerBaseUrl,
    envWorkerBaseUrl: process.env['WORKER_BASE_URL'] ?? null,
    join: RUNTIME_FLAGS.join,
    joinUrl: RUNTIME_FLAGS.joinUrl,
    bridgeWsUrl:
      THIN_BRIDGE_MODE && state.bridgeToken ? `ws://localhost:${state.servePort}/cdp` : null,
    bridgeToken: state.bridgeToken,
  });
  if (RUNTIME_FLAGS.hosted) {
    url += `${url.includes('?') ? '&' : '?'}runtime=hosted-leader`;
  }
  if (RUNTIME_FLAGS.prompt) {
    url += `${url.includes('?') ? '&' : '?'}prompt=${encodeURIComponent(RUNTIME_FLAGS.prompt)}`;
  }
  if (RUNTIME_FLAGS.join) {
    console.log(`Join launch URL: ${url}`);
  } else if (RUNTIME_FLAGS.lead) {
    console.log(`Lead launch URL: ${url}`);
  } else if (THIN_BRIDGE_MODE) {
    // Print WITHOUT the bridgeToken — it's a session capability.
    const sanitized = url.replace(/([?&])bridgeToken=[^&]+/, '$1bridgeToken=<redacted>');
    console.log(`Thin-bridge launch URL: ${sanitized}`);
  }
  return url;
}

function resolveChromeProfileOrExit(
  state: ServerState
): ReturnType<typeof resolveChromeLaunchProfile> {
  try {
    const resolved = resolveChromeLaunchProfile({
      projectRoot: PROJECT_ROOT,
      profile: RUNTIME_FLAGS.profile,
      servePort: state.servePort,
    });
    // Override the user data dir in hosted mode to use a persistent profile.
    if (RUNTIME_FLAGS.hosted) {
      resolved.userDataDir = process.env['CHROME_USER_DATA_DIR'] ?? '/data/profile';
    }
    return resolved;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function launchChromeTarget(state: ServerState): Promise<void> {
  const browserLaunchUrl = buildBrowserLaunchUrl(state);
  const chromeProfile = resolveChromeProfileOrExit(state);

  const chromePath = findChromeExecutable({
    executablePreference: !DEV_MODE && !chromeProfile.id ? 'installed' : 'chrome-for-testing',
  });
  if (!chromePath) {
    console.error('Could not find Chrome/Chromium. Please install Chrome or set CHROME_PATH.');
    process.exit(1);
  }
  console.log(`Found Chrome: ${chromePath}`);

  if (chromeProfile.id) {
    await ensureQaProfileScaffold(PROJECT_ROOT);
  } else if (!RUNTIME_FLAGS.hosted) {
    const profileDirName = basename(chromeProfile.userDataDir);
    await migrateLegacyDefaultChromeProfile(
      chromeProfile.userDataDir,
      legacyChromeCandidates(profileDirName)
    );
  }

  if (chromeProfile.extensionPath && !existsSync(chromeProfile.extensionPath)) {
    console.error(
      `Extension profile requires ${chromeProfile.extensionPath}. Run \`npm run build -w @slicc/chrome-extension\` first.`
    );
    process.exit(1);
  }

  if (chromeProfile.id) {
    console.log(`Using QA Chrome profile: ${chromeProfile.id}`);
    console.log(`Profile directory: ${chromeProfile.userDataDir}`);
    if (chromeProfile.extensionPath) {
      console.log(`Auto-loading unpacked extension from ${chromeProfile.extensionPath}`);
    }
  }

  const chromeArgs = buildChromeLaunchArgs({
    cdpPort: state.requestedCdpPort,
    launchUrl: browserLaunchUrl,
    profile: chromeProfile,
    hosted: RUNTIME_FLAGS.hosted,
  });

  // Chrome never clears DevToolsActivePort on shutdown, so a stale file from a
  // prior crash/SIGKILL would let our active-port poller win the race with the
  // wrong port. Clear it before spawn.
  await clearStaleDevToolsActivePort(chromeProfile.userDataDir);

  // On macOS, route through `/usr/bin/open` so LaunchServices owns the new Chrome
  // process — otherwise the launching terminal stays in Chrome's TCC responsibility
  // chain and silently breaks getUserMedia() camera/mic grants.
  const spawnPlan = planChromeSpawn({ executablePath: chromePath, chromeArgs });

  state.launchedBrowserProcess = spawn(spawnPlan.command, spawnPlan.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
  });
  state.launchedBrowserLabel = chromeProfile.displayName;

  // Use the stderr-vs-DevToolsActivePort race so this works in both direct-exec
  // mode (Linux/Windows stderr banner) and LaunchServices mode (macOS active-port file).
  state.cdpPort = await waitForCdpPort(state.launchedBrowserProcess, {
    userDataDir: chromeProfile.userDataDir,
  });
  console.log(`Chrome CDP listening on port ${state.cdpPort}`);

  pipeChildOutput(state.launchedBrowserProcess, 'chrome');

  state.launchedBrowserProcess.on('exit', (code) => {
    if (state.shuttingDown) return;
    console.log(`Chrome exited with code ${code}`);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// CDP WebSocket proxy — Chrome's browser-level debugger URL accepts only ONE
// concurrent WebSocket connection, so we keep a single chromeWs and swap the
// active client when a new one connects. All proxy state lives on ServerState.
// ---------------------------------------------------------------------------

interface CdpProxyContext {
  wss: WebSocketServer;
  secretProxy: SecretProxyManager;
  cdpDedup: CliLogDedup;
  cdpSessionUrls: ReturnType<typeof createCdpSessionUrlTracker>;
}

const CDP_PROXY_INSPECT_BYTES = 256 * 1024;
const CDP_PROXY_HARD_FRAME_CAP = 64 * 1024 * 1024;
const CDP_LOOP_EVENT_PREFIXES = [
  '{"method":"Network.webSocketFrameReceived"',
  '{"method":"Network.webSocketFrameSent"',
];

/**
 * Normalise the `ws` library's polymorphic message payload into a single Buffer
 * we can peek at and forward. Without this, a later `String(data)` would coerce
 * an `ArrayBuffer` to `"[object ArrayBuffer]"` and a `Buffer[]` to comma-joined
 * fragments, corrupting the CDP frame.
 */
function cdpFrameToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  // Rare fallback — string frames in text mode. Keep bytes faithful.
  return Buffer.from(String(data));
}

function closeWebSocketQuietly(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

/**
 * Reject a WebSocket upgrade before `handleUpgrade` runs. Writes a minimal
 * HTTP/1.1 response and destroys the underlying socket. RFC 6455 allows 401
 * / 403 here; we use 401 so a caller that retries with the correct
 * subprotocol/origin doesn't trip permanent CORS-style caches.
 */
function rejectUpgradeUnauthorized(socket: import('node:stream').Duplex, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 401 Unauthorized\r\n` +
        `Content-Type: text/plain\r\n` +
        `Connection: close\r\n` +
        `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
        `\r\n${reason}`
    );
  } catch {
    /* socket may already be gone */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
}

/**
 * Route `/cdp` and `/licks-ws` upgrades to their servers; leave others for Vite HMR.
 *
 * When `bridgeToken !== null` (thin standalone mode) the `/cdp` upgrade is
 * gated by `validateBridgeUpgrade`: bad origin or missing/wrong
 * `Sec-WebSocket-Protocol` token = socket destroyed before
 * `wss.emit('connection', ...)` ever fires. Legacy modes (dev / electron /
 * serve-only / hosted) pass `null` to keep same-origin behavior unchanged.
 * `/licks-ws` is loopback-only and stays ungated.
 */
function attachCdpUpgradeRouting(
  server: HttpServer,
  wss: WebSocketServer,
  lickWss: WebSocketServer,
  bridgeToken: string | null
): void {
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url!, `http://${request.headers.host}`);
    if (pathname === '/cdp') {
      if (bridgeToken !== null) {
        const gate = validateBridgeUpgrade({
          origin: request.headers.origin,
          subprotocolHeader: request.headers['sec-websocket-protocol'],
          expectedToken: bridgeToken,
        });
        if (!gate.ok) {
          console.warn(`[cdp-proxy] /cdp upgrade rejected: ${gate.reason}`);
          rejectUpgradeUnauthorized(socket, gate.reason ?? 'rejected');
          return;
        }
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/licks-ws') {
      lickWss.handleUpgrade(request, socket, head, (ws) => {
        lickWss.emit('connection', ws, request);
      });
    }
  });
}

/**
 * Apply the Client→Chrome unmask gate to a buffered frame on flush. Shared by
 * both buffer-drain sites (ensureChromeConnection already-open path + the
 * chromeWs 'open' handler); falls back to the original bytes on any error.
 */
function flushClientFrame(target: WebSocket, raw: unknown, ctx: CdpProxyContext): void {
  const original = String(raw);
  const { output } = applyCdpUnmask(original, {
    tracker: ctx.cdpSessionUrls,
    pipeline: ctx.secretProxy.rawPipeline,
  });
  target.send(output);
}

function flushBufferedClientFrames(
  state: ServerState,
  target: WebSocket,
  ctx: CdpProxyContext
): void {
  if (!state.messageBuffer) return;
  for (const msg of state.messageBuffer) {
    flushClientFrame(target, msg, ctx);
  }
  state.messageBuffer = null;
}

/**
 * Forward one Chrome→Client frame, dropping the self-amplifying
 * `Network.webSocketFrame*` feedback-loop events (the slicc UI runs inside the
 * Chrome it debugs, so those embed prior frames and blow past V8's string cap)
 * and any frame over the hard cap.
 */
function forwardChromeFrame(state: ServerState, buf: Buffer, ctx: CdpProxyContext): void {
  const byteLen = buf.length;
  // Peek at the first 256 KiB only — enough to identify the event type cheaply.
  const head = buf.subarray(0, CDP_PROXY_INSPECT_BYTES).toString();

  if (CDP_LOOP_EVENT_PREFIXES.some((p) => head.startsWith(p))) {
    const msg = `[cdp-proxy] Dropping Chrome feedback-loop event (${byteLen} bytes, ${head.slice(1, 60)}…)`;
    if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
    return;
  }
  if (byteLen > CDP_PROXY_HARD_FRAME_CAP) {
    const msg = `[cdp-proxy] Dropping oversized Chrome→Client frame (${byteLen} bytes)`;
    if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
    return;
  }

  const str = buf.toString();
  const msg = `[cdp-proxy] Chrome→Client: ${str.slice(0, 200)}`;
  if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
  // Sniff Target.attachedToTarget / targetInfoChanged / Page.frameNavigated so
  // the Client→Chrome unmask gate can resolve per-session hostnames.
  ctx.cdpSessionUrls.observeChromeToClient(str);
  if (state.activeClientWs && state.activeClientWs.readyState === WebSocket.OPEN) {
    state.activeClientWs.send(str);
  }
}

function ensureChromeConnection(
  state: ServerState,
  url: string,
  ctx: CdpProxyContext
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (state.chromeWs && state.chromeWs.readyState === WebSocket.OPEN) {
      // Already connected — flush any buffered messages and go direct.
      flushBufferedClientFrames(state, state.chromeWs, ctx);
      resolve();
      return;
    }
    closeWebSocketQuietly(state.chromeWs);

    state.messageBuffer = [];
    // Disable the ws library's per-message size cap (default 100 MiB). The slicc
    // UI runs INSIDE the Chrome it debugs, so Chrome's Network domain reports
    // every CDP frame back as `Network.webSocketFrame*` events embedding prior
    // payloads — an exponential loop that would trip the cap and close the
    // socket (code 1006). forwardChromeFrame drops those events by method.
    const chromeWs = new WebSocket(url, { maxPayload: 0 });
    state.chromeWs = chromeWs;

    chromeWs.on('open', () => {
      console.log('[cdp-proxy] chromeWs open');
      flushBufferedClientFrames(state, chromeWs, ctx);
      resolve();
    });
    chromeWs.on('message', (data) => {
      forwardChromeFrame(state, cdpFrameToBuffer(data), ctx);
    });
    chromeWs.on('close', (code, reason) => {
      console.log(`[cdp-proxy] Chrome WS closed. code=${code}, reason=${String(reason)}`);
      state.chromeWs = null;
    });
    chromeWs.on('error', (err) => {
      console.log(`[cdp-proxy] Chrome WS error: ${err}`);
      state.chromeWs = null;
      reject(err);
    });
  });
}

/** Forward one Client→Chrome frame, buffering it when Chrome isn't ready yet. */
function forwardClientFrame(state: ServerState, data: unknown, ctx: CdpProxyContext): void {
  const original = String(data);
  const preview = original.slice(0, 200);
  if (
    state.chromeWs &&
    state.chromeWs.readyState === WebSocket.OPEN &&
    state.messageBuffer === null
  ) {
    const msg = `[cdp-proxy] Client→Chrome: ${preview}`;
    if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
    const { output } = applyCdpUnmask(original, {
      tracker: ctx.cdpSessionUrls,
      pipeline: ctx.secretProxy.rawPipeline,
    });
    state.chromeWs.send(output);
  } else if (state.messageBuffer !== null) {
    // Buffer the ORIGINAL bytes; unmask runs on flush so the hostname tracker
    // reflects the state at send time.
    state.messageBuffer.push(data);
    const msg = `[cdp-proxy] Client→Chrome (buffered): ${preview}`;
    if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
  } else {
    console.log(`[cdp-proxy] Client→Chrome (DROPPED — no connection): ${preview}`);
  }
}

/**
 * Wait for `state.cdpPort` to be populated (i.e. `launchChromeTarget`'s
 * `waitForCdpPort` has resolved). Used by clients that race ahead of the
 * browser launch — primarily the thin-bridge case where `server.listen()`
 * runs BEFORE `launchBrowser` so the hosted leader can connect to /cdp
 * the moment Chrome opens it, even before Chrome's own CDP port is known.
 */
async function waitForServerCdpPort(state: ServerState, timeoutMs = 30_000): Promise<number> {
  if (state.cdpPort > 0) return state.cdpPort;
  const startedAt = Date.now();
  while (state.cdpPort === 0 && Date.now() - startedAt < timeoutMs) {
    if (state.shuttingDown) throw new Error('Server shutting down');
    await new Promise((r) => setTimeout(r, 50));
  }
  if (state.cdpPort === 0) {
    throw new Error('Chrome CDP port did not become available in time');
  }
  return state.cdpPort;
}

async function handleCdpClient(
  state: ServerState,
  clientWs: WebSocket,
  ctx: CdpProxyContext,
  cdpPort?: number
): Promise<void> {
  try {
    // Only one client active at a time — close the previous one.
    if (state.activeClientWs && state.activeClientWs.readyState === WebSocket.OPEN) {
      console.log('[cdp-proxy] Closing previous client connection');
      state.activeClientWs.close();
    }
    state.activeClientWs = clientWs;
    console.log('[cdp-proxy] New client connected');

    // Initialise the buffer BEFORE any await so messages arriving during
    // waitForCDP / ensureChromeConnection are captured, not dropped.
    if (state.messageBuffer === null) state.messageBuffer = [];

    // Register ALL handlers BEFORE any async work so no messages are lost.
    clientWs.on('message', (data) => {
      forwardClientFrame(state, data, ctx);
    });
    clientWs.on('close', () => {
      console.log('[cdp-proxy] Client disconnected');
      if (state.activeClientWs === clientWs) state.activeClientWs = null;
      // Don't close chromeWs — keep it alive for the next client.
    });
    clientWs.on('error', (err) => {
      console.log(`[cdp-proxy] Client WS error: ${err}`);
      if (state.activeClientWs === clientWs) state.activeClientWs = null;
    });

    // NOW do async work — messages arriving during these awaits are buffered.
    if (!state.cdpUrl) {
      const port = cdpPort && cdpPort > 0 ? cdpPort : await waitForServerCdpPort(state);
      state.cdpUrl = await waitForCDP(port);
      console.log(`[cdp-proxy] CDP available at: ${state.cdpUrl}`);
    }
    await ensureChromeConnection(state, state.cdpUrl, ctx);
  } catch (err) {
    console.error('[cdp-proxy] Connection error:', err);
    clientWs.close();
  }
}

/** Best-effort graceful close of the launched browser, escalating to SIGKILL. */
async function closeLaunchedBrowserGracefully(state: ServerState, cdpPort: number): Promise<void> {
  const browser = state.launchedBrowserProcess;
  if (!browser) return;

  let browserExited = false;
  browser.on('exit', () => {
    browserExited = true;
  });

  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    const json = (await res.json()) as { webSocketDebuggerUrl: string };
    const browserWs = new WebSocket(json.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      browserWs.on('open', () => {
        browserWs.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        resolve();
      });
      browserWs.on('error', reject);
    });
  } catch {
    // CDP not available — the launched browser may still be starting up; fall through to kill.
  }

  const deadline = Date.now() + 3000;
  while (!browserExited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!browserExited) {
    try {
      browser.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  console.log(`${state.launchedBrowserLabel} closed`);
}

interface ShutdownDeps {
  fileLogger: FileLogger;
  wss: WebSocketServer;
  server: HttpServer;
}

/** Build the idempotent graceful-shutdown handler wired to the process signals. */
function createGracefulShutdown(state: ServerState, deps: ShutdownDeps): () => Promise<void> {
  return async () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    console.log('\nShutting down...');
    deps.fileLogger.close();

    state.overlayInjector?.stop();
    state.overlayInjector = null;

    closeWebSocketQuietly(state.chromeWs);
    state.chromeWs = null;
    closeWebSocketQuietly(state.activeClientWs);
    state.activeClientWs = null;
    for (const client of deps.wss.clients) {
      client.close();
    }
    deps.wss.close();

    // Stop accepting new HTTP connections.
    deps.server.close();

    // Read cdpPort from state — populated by `launchChromeTarget`; may be 0
    // if shutdown fires before the browser ever launched.
    await closeLaunchedBrowserGracefully(state, state.cdpPort);
    process.exit(0);
  };
}

/** Pre-connect to Chrome so the proxy is warm before the first client; hosted mode registers leader-restart once CDP is ready. */
async function preconnectCdp(
  state: ServerState,
  ctx: CdpProxyContext,
  app: express.Express,
  servePort: number
): Promise<void> {
  try {
    const cdpPort = state.cdpPort > 0 ? state.cdpPort : await waitForServerCdpPort(state);
    state.cdpUrl = await waitForCDP(cdpPort);
    console.log(`[cdp-proxy] Pre-connected: CDP available at ${state.cdpUrl}`);
    await ensureChromeConnection(state, state.cdpUrl, ctx);
    console.log('[cdp-proxy] Chrome WebSocket ready (pre-warmed)');

    if (RUNTIME_FLAGS.hosted) {
      registerLeaderRestartEndpoint(app, {
        cdp: createHttpCdp(cdpPort),
        localUrlPrefix: `http://localhost:${servePort}/`,
      });
      console.log('[hosted] /api/leader-restart endpoint registered');
    }
  } catch (err) {
    console.log('[cdp-proxy] Pre-connect failed (will retry on first client):', err);
  }
}

async function startOverlayInjector(
  state: ServerState,
  cdpPort: number,
  servePort: number
): Promise<void> {
  try {
    const thinBridge = resolveOverlayThinBridge(process.env, state.bridgeToken, servePort);
    state.overlayInjector = await ElectronOverlayInjector.create({
      cdpPort,
      servePort,
      dev: DEV_MODE,
      projectRoot: PROJECT_ROOT,
      thinBridge,
    });
    await state.overlayInjector.start();
    if (thinBridge) {
      console.log(
        `[electron-float] Overlay injector is watching Electron page targets (thin bridge → ${thinBridge.hostedLeaderOrigin})`
      );
    } else {
      console.log('[electron-float] Overlay injector is watching Electron page targets');
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[electron-float] Failed to start overlay injector:', message);
  }
}

interface CdpServerDeps {
  app: express.Express;
  server: HttpServer;
  ctx: CdpProxyContext;
  fileLogger: FileLogger;
  servePort: number;
  serveOrigin: string;
  cdpPort: number;
}

/**
 * Bind the HTTP server (and the /cdp WS upgrade handler attached to it) so
 * incoming `ws://localhost/cdp` connections are accepted. Resolves when
 * `server.listen` fires its 'listening' callback.
 *
 * Split out of the old `startCdpServer` so `main()` can `await` listening
 * BEFORE `launchBrowser(state)` runs — without this ordering the hosted
 * leader's eager `browser.connect()` (fired the moment Chrome opens
 * sliccy.ai in thin-bridge mode) can race ahead of the bridge and fail
 * its one-shot WebSocket handshake.
 */
function startListening(deps: Omit<CdpServerDeps, 'ctx' | 'app'>): Promise<void> {
  const { server, fileLogger, servePort, serveOrigin, cdpPort } = deps;
  return new Promise((resolve) => {
    server.listen(servePort, '127.0.0.1', () => {
      if (THIN_BRIDGE_MODE) {
        console.log(`Thin /cdp bridge + /api at ${serveOrigin}`);
      } else {
        console.log(`Serving UI at ${serveOrigin}`);
      }
      console.log(`CDP proxy at ws://localhost:${servePort}/cdp`);
      fileLogger.log('info', 'CLI server started', {
        port: servePort,
        cdpPort,
        devMode: DEV_MODE,
        electronMode: ELECTRON_MODE,
      });
      resolve();
    });
  });
}

/**
 * Post-listen warmup: pre-connects to Chrome's CDP (so the proxy is warm
 * before the first client), starts the Electron overlay injector, and
 * attaches the console forwarder. Reads `state.cdpPort` dynamically so
 * the value populated by `launchChromeTarget` is used regardless of when
 * this runs relative to the listen callback.
 */
function runCdpProxyWarmup(state: ServerState, deps: CdpServerDeps): void {
  const { app, ctx, servePort } = deps;
  void preconnectCdp(state, ctx, app, servePort);

  if (ELECTRON_MODE) {
    void startOverlayInjector(state, state.cdpPort, servePort);
  } else if (!THIN_BRIDGE_MODE) {
    // Thin-bridge mode has no local UI page to forward console output from.
    const cdpPort = state.cdpPort;
    setTimeout(() => {
      attachConsoleForwarder(cdpPort, String(servePort)).catch((err) => {
        console.error('[page] Console forwarder error:', err);
      });
    }, 2500);
  }
}

interface SecretBootstrap {
  secretStore: EnvSecretStore;
  secretProxy: SecretProxyManager;
  oauthStore: OauthSecretStore;
}

/**
 * Build the secret stores + masking pipeline shared by the fetch-proxy, the
 * /api/secrets routes, and the S3 sign-and-forward handler. Secret-load
 * failures are logged, not fatal.
 */
async function bootstrapSecrets(): Promise<SecretBootstrap> {
  const sessionDir = RUNTIME_FLAGS.envFile
    ? dirname(RUNTIME_FLAGS.envFile)
    : join(homedir(), '.slicc');
  const sessionId = readOrCreateSessionId(sessionDir);
  const oauthStore = new OauthSecretStore();
  // Env-file secrets (~/.slicc/secrets.env) feed the fetch-proxy mask pipeline
  // alongside OAuth tokens.
  const secretStore = new EnvSecretStore(RUNTIME_FLAGS.envFile ?? undefined);
  const secretProxy = new SecretProxyManager(secretStore, sessionId, oauthStore);
  try {
    await secretProxy.reload();
    if (secretProxy.hasSecrets()) {
      console.log(
        `Loaded ${secretProxy.getMaskedEntries().length} secrets for fetch-proxy injection`
      );
    }
  } catch (err) {
    console.warn('Failed to load secrets:', err instanceof Error ? err.message : err);
  }
  return { secretStore, secretProxy, oauthStore };
}

/**
 * Thin-bridge CORS + PNA middleware. The hosted leader at sliccy.ai is a
 * cross-origin caller, so headers go on every response for allowlisted
 * origins (so /cdp's pre-WS preflight and every /api/* call succeed);
 * OPTIONS from an allowlisted origin short-circuits to 204 with the PNA
 * opt-in. Non-allowlisted origins fall through with no CORS headers, which
 * preserves same-origin (localhost) behavior unchanged.
 *
 * Additionally enforces the per-process bridge token on cross-origin
 * `/api/*` requests from REMOTE allowlisted origins (sliccy.ai) — the
 * origin allowlist alone is insufficient because any script on
 * `https://www.sliccy.ai` could otherwise reach the local node-server's
 * /api surface (secrets, fetch-proxy, etc.). Loopback allowlisted
 * origins (e.g. the locally-served OAuth callback at
 * `http://localhost:5710/auth/callback` POSTing to `/api/oauth-result`)
 * are exempt — they originate from this same server. OPTIONS preflights
 * are exempt because browsers strip custom headers from preflights.
 */
function createThinBridgeCorsMiddleware(
  bridgeToken: string | null
): import('express').RequestHandler {
  return (req, res, next) => {
    // Reflect the requested headers so the agent's `bash curl -H …` (which
    // can carry arbitrary upstream headers through /api/fetch-proxy) is not
    // blocked by a hardcoded allowlist. Cross-origin preflights advertise
    // those headers via `Access-Control-Request-Headers`.
    const origin = req.headers.origin;
    const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS' && cors) {
      for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    // Token gate on /api/* from remote allowlisted origins. `cors` is only
    // truthy when the Origin is in the allowlist; loopback callers
    // (localhost/127.0.0.1) and no-Origin curl-style callers fall through
    // unchanged.
    if (
      cors &&
      req.path.startsWith('/api/') &&
      !isLoopbackBridgeOrigin(origin) &&
      !validateBridgeToken(req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()], bridgeToken)
    ) {
      res.status(403).json({ error: 'bridge-token-required' });
      return;
    }
    next();
  };
}

/**
 * Build the `/cdp` `WebSocketServer`. `handleProtocols` echoes the matched
 * bridge subprotocol back in the 101 response (RFC 6455 §1.9). Returning
 * `false` makes the server omit the header, which makes the browser fail
 * the upgrade when a subprotocol was offered. Legacy modes (token=null)
 * pass the first offered subprotocol through unchanged.
 */
function createCdpWebSocketServer(bridgeToken: string | null): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) => {
      if (bridgeToken !== null) {
        return selectBridgeSubprotocol([...protocols], bridgeToken) ?? false;
      }
      const first = protocols.values().next();
      return first.done ? false : first.value;
    },
  });
}

async function main() {
  // Resolve ports first; `launchBrowser` is deferred until AFTER
  // `server.listen()` so the /cdp bridge is accepting connections before
  // Chrome opens its target URL (the packaged-CLI thin-bridge mode opens
  // the hosted leader at sliccy.ai, whose eager `browser.connect()`
  // otherwise races ahead of the bridge listener and fails its one-shot
  // WebSocket handshake). `state.cdpPort` becomes valid inside
  // `launchChromeTarget` once Chrome announces its CDP port; consumers
  // that need it (`handleCdpClient`, `preconnectCdp`, the graceful-
  // shutdown handler) read it dynamically from `state`.
  const state = createServerState();
  await resolvePorts(state);
  const { servePort: SERVE_PORT, serveOrigin: SERVE_ORIGIN } = state;

  // 3. Set up express app with request logging
  const { secretStore, secretProxy, oauthStore } = await bootstrapSecrets();

  const app = express();
  app.use(requestLogger);
  // Append SLICC's standard RFC 8288 Link header set on every /api/* response.
  app.use(sliccLinksMiddleware());

  if (THIN_BRIDGE_MODE) {
    app.use(createThinBridgeCorsMiddleware(state.bridgeToken));
  }

  // ---------------------------------------------------------------------------
  // Lick system — WebSocket bridge for webhooks/crontasks (all logic in browser)
  // ---------------------------------------------------------------------------
  const lickBridge = createLickBridge();
  const { lickWss, broadcastLickEvent } = lickBridge;

  // OAuth callback — generic redirect target for OAuth providers (implicit + PKCE)
  registerOAuthCallbackRoutes(app);

  // Global JSON body parser. Skipped when the request carries
  // `X-Slicc-Raw-Body: 1`, so SigV4-signed bodies survive into the
  // /api/fetch-proxy handler byte-for-byte (the parser would otherwise
  // re-serialize them via JSON.stringify, breaking the signature).
  app.use(
    express.json({
      limit: '50mb',
      type: (req) =>
        req.headers['x-slicc-raw-body'] !== '1' &&
        (req.headers['content-type'] ?? '').includes('application/json'),
    })
  );

  app.get('/api/runtime-config', (_req, res) => {
    res.json({
      trayWorkerBaseUrl:
        // Explicit override: env var injected at sandbox-create time (hosted
        // mode) or by the dev harness to decouple the tray-worker relay from
        // the UI origin (e.g. wrangler on :8787 + staging relay for OAuth).
        (process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() || null) ??
        RUNTIME_FLAGS.leadWorkerBaseUrl ??
        (process.env['WORKER_BASE_URL']?.trim() || null) ??
        (DEV_MODE
          ? 'https://slicc-tray-hub-staging.minivelos.workers.dev'
          : 'https://www.sliccy.ai'),
      // Read dynamically from state — populated by `launchElectronTarget`
      // when an existing leader is discovered. `launchBrowser` now runs
      // after `server.listen()`, so this endpoint must NOT close over a
      // pre-launch snapshot or it would always return null.
      trayJoinUrl: state.discoveredTrayJoinUrl ?? null,
    });
  });

  // Localhost API descriptor — the discoverable surface advertised by the
  // `service-desc` Link rel. Matches the cloudflare-worker's
  // `/.well-known/api-catalog` in shape but is scoped to the local CLI.
  app.get('/api', (req, res) => {
    const host = req.headers.host ?? `localhost:${SERVE_PORT}`;
    res.json(buildLocalApiDescriptor(host));
  });

  // Public health document — advertised via the `status` rel (RFC 8631) in
  // the standard Link header set so any consumer that walks the rels can
  // probe liveness without hard-coding a path.
  app.get('/api/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      service: 'slicc-node-server',
      timestamp: new Date().toISOString(),
    });
  });

  // Tray status, webhook management + receiver, and cron task routes — all
  // forward to the browser over the lick bridge.
  registerLickApiRoutes(app, lickBridge);

  // Profile-independent handoff injection — external tools post here so a
  // handoff reaches the cone regardless of which browser profile is active.
  registerHandoffRoute(app, { broadcastLickEvent });

  // Secret management API — direct .env file access (no browser needed),
  // plus the S3 / DA sign-and-forward and masked-secret endpoints.
  registerSecretRoutes(app, { secretStore, secretProxy, oauthStore, devMode: DEV_MODE });

  // Cloud status endpoint (hosted-only) — writes join info to /tmp/slicc-join.json
  // Register BEFORE Chromium launches. The webapp's first action after
  // ?runtime=hosted-leader boot is to mint a tray and POST /api/cloud-status.
  // If the route doesn't exist yet, the post 404s and the CLI poll times out.
  if (RUNTIME_FLAGS.hosted) {
    registerCloudStatusEndpoint(app, { joinFilePath: '/tmp/slicc-join.json' });
    registerHostedBootstrapEndpoint(app, { secretStore });
    registerSecretsReloadEndpoint(app, { secretProxy });
  }

  // Sudo approval endpoint — raises a native OS dialog / TTY prompt from this
  // trusted process so the in-browser agent can request, but never fabricate,
  // an approval. Loopback-only; selects a backend by environment at call time.
  registerSudoApproveEndpoint(app);

  // Fetch proxy — forwards cross-origin requests from the browser to bypass CORS,
  // injecting/unmasking secrets and streaming the response with a UTF-8-safe scrub.
  registerFetchProxyRoute(app, { secretProxy });

  // Create the HTTP server BEFORE Vite so we can register our upgrade handler first
  const server = createServer(app);

  // Thin-bridge mode: skip UI serving entirely. node-server becomes a
  // pure /cdp bridge + /api surface; Chrome opens the sliccy.ai-hosted
  // leader which talks to /cdp + /api cross-origin.
  if (!THIN_BRIDGE_MODE) {
    await attachUiServing(app, server, {
      devMode: DEV_MODE,
      hosted: RUNTIME_FLAGS.hosted,
      serveOrigin: SERVE_ORIGIN,
      uiDir: resolve(Dirname, '..', 'ui'),
    });
  }

  // 4. CDP WebSocket proxy at /cdp — noServer mode so Vite's dev middleware
  //    doesn't intercept the upgrade.
  const wss = createCdpWebSocketServer(state.bridgeToken);
  attachCdpUpgradeRouting(server, wss, lickWss, state.bridgeToken);
  const cdpCtx: CdpProxyContext = {
    wss,
    secretProxy,
    cdpDedup: new CliLogDedup(),
    cdpSessionUrls: createCdpSessionUrlTracker(),
  };

  const gracefulShutdown = createGracefulShutdown(state, {
    fileLogger,
    wss,
    server,
  });
  process.on('SIGINT', () => {
    gracefulShutdown();
  });
  process.on('SIGTERM', () => {
    gracefulShutdown();
  });
  process.on('exit', () => {
    // Synchronous last-resort cleanup — kill the launched browser if still running.
    const browser = state.launchedBrowserProcess;
    if (!state.shuttingDown && browser) {
      try {
        browser.kill();
      } catch {
        /* ignore */
      }
    }
  });

  await startCdpStack(state, { app, server, wss, cdpCtx, fileLogger });
}

/**
 * Bottom half of `main()`: bind the /cdp WS handler, start listening on
 * the HTTP server BEFORE launching the browser so the /cdp bridge is
 * accepting the hosted leader's eager connect the instant Chrome opens
 * sliccy.ai, then launch the browser (populates `state.cdpPort`), then
 * run the post-launch warmup (preconnect / overlay / console forwarder).
 *
 * Extracted purely to keep `main()` under the lint-enforced function-size
 * cap; not a meaningful boundary, just a co-locating helper.
 */
async function startCdpStack(
  state: ServerState,
  deps: {
    app: express.Express;
    server: HttpServer;
    wss: WebSocketServer;
    cdpCtx: CdpProxyContext;
    fileLogger: FileLogger;
  }
): Promise<void> {
  const { app, server, wss, cdpCtx, fileLogger } = deps;
  const { servePort: SERVE_PORT, serveOrigin: SERVE_ORIGIN } = state;

  // Read `state.cdpPort` dynamically — populated by `launchChromeTarget`
  // AFTER `server.listen()` so we can't capture it here.
  wss.on('connection', (clientWs) => {
    void handleCdpClient(state, clientWs, cdpCtx, state.cdpPort);
  });

  await startListening({
    server,
    fileLogger,
    servePort: SERVE_PORT,
    serveOrigin: SERVE_ORIGIN,
    cdpPort: state.cdpPort,
  });
  await launchBrowser(state);
  runCdpProxyWarmup(state, {
    app,
    server,
    ctx: cdpCtx,
    fileLogger,
    servePort: SERVE_PORT,
    serveOrigin: SERVE_ORIGIN,
    cdpPort: state.cdpPort,
  });
}

// ---------------------------------------------------------------------------
// Cloud dispatcher helpers
// ---------------------------------------------------------------------------

async function readSecretsEnvKey(name: string): Promise<string | undefined> {
  try {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    const file = process.env['SLICC_SECRETS_FILE'] ?? join(home, '.slicc', 'secrets.env');
    const contents = await fsPromises.readFile(file, 'utf-8');
    for (const line of contents.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim();
    }
  } catch {
    /* file missing → undefined */
  }
  return undefined;
}

function defaultSecretsPath(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  return join(home, '.slicc', 'secrets.env');
}

function readPackageVersion(): string {
  try {
    const pkgPath = join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

async function runCloudSubcommand(parsed: ParsedCloudArgs): Promise<void> {
  const apiKey = process.env['E2B_API_KEY'] ?? (await readSecretsEnvKey('E2B_API_KEY'));
  if (!apiKey) {
    console.error(
      'E2B_API_KEY not set. Add it to ~/.slicc/secrets.env (with E2B_API_KEY_DOMAINS=e2b.dev) ' +
        'or export it.'
    );
    process.exit(2);
  }
  const substrate = createSubstrate(parsed.args.substrate, { apiKey });
  const registryPath = FileRegistry.defaultPath();
  const localSliccVersion = readPackageVersion();

  switch (parsed.subcommand) {
    case 'start': {
      const result = await runStart({
        substrate,
        envFilePath: parsed.args.envFile ?? defaultSecretsPath(),
        registryPath,
        workerBaseUrl: process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() || 'https://www.sliccy.ai',
        sliccVersion: localSliccVersion,
        name: parsed.args.name,
        template: parsed.args.template,
      });
      console.log(`Sandbox ${result.sandboxId} ready.`);
      console.log(`Open: ${result.joinUrl}`);
      console.log('Attach from iOS, desktop SLICC, or any browser tab.');
      break;
    }
    case 'list': {
      const entries = await runList({ substrate, registryPath });
      for (const e of entries) {
        console.log(`${e.substrate}\t${e.sandboxId}\t${e.name ?? '-'}\t${e.state}\t${e.joinUrl}`);
      }
      break;
    }
    case 'pause':
      await runPause({ substrate, registryPath, query: parsed.args.query });
      console.log('Paused.');
      break;
    case 'resume': {
      const result = await runResume({
        substrate,
        envFilePath: parsed.args.envFile ?? defaultSecretsPath(),
        registryPath,
        query: parsed.args.query,
        localSliccVersion,
      });
      if (result.versionMismatch) {
        console.warn(
          `Warning: running sandbox is sliccVersion=${result.versionMismatch.running}, ` +
            `local CLI is ${result.versionMismatch.local}. Proceeding anyway.`
        );
      }
      if (result.trayRebuilt) {
        console.warn('Tray was rebuilt; existing followers must re-attach to the new join URL.');
      }
      console.log(`Resumed. Open: ${result.joinUrl}`);
      break;
    }
    case 'kill':
      await runKill({ substrate, registryPath, query: parsed.args.query });
      console.log('Killed.');
      break;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  const errorData =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack }
      : { value: String(err) };
  fileLogger.log('error', 'Fatal error', errorData);
  fileLogger.close();
  process.exit(1);
});
