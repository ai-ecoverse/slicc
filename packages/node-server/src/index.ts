#!/usr/bin/env node
import { promises as fsPromises } from 'node:fs';
import { createSubstrate } from '@slicc/cloud-core';
import { parseTrayJoinUrl, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { type ChildProcess, spawn } from 'child_process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import type { Server as HttpServer } from 'http';
import { createServer as createNetServer } from 'net';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  describeUpgradeRejection,
  isLoopbackBridgeOrigin,
  preflightMaxAge,
  resolveServerBridgeToken,
  selectBridgeSubprotocol,
  shouldMountThinBridgeCors,
  validateBridgeToken,
  validateBridgeUpgrade,
} from './bridge-security.js';
import { closeLaunchedBrowserGracefully } from './browser-shutdown.js';
import { applyCdpUnmask } from './cdp-proxy/cdp-unmask.js';
import {
  ChromeReconnectController,
  closeClientForUpstreamReset,
  markChromeLegDown,
} from './cdp-proxy/chrome-reconnect.js';
import {
  adoptClientSlot,
  appendBufferedClientFrame,
  type ClientFrameBuffer,
  clientHoldsSlot,
  createClientFrameBuffer,
  currentBufferGeneration,
  type DroppedClientFrames,
  describeDroppedClientFrames,
  releaseClientSlot,
  takeClientFrameBuffer,
} from './cdp-proxy/client-frame-buffer.js';
import { CDP_SUPERSEDED_CLOSE_CODE } from './cdp-proxy/close-codes.js';
import { createCdpSessionUrlTracker } from './cdp-proxy/session-url-tracker.js';
import {
  buildChromeLaunchArgs,
  clearChromeRestoreState,
  clearChromeSessionRestore,
  clearStaleDevToolsActivePort,
  ensureQaProfileScaffold,
  findChromeExecutable,
  legacyChromeCandidates,
  migrateLegacyDefaultChromeProfile,
  planChromeSpawn,
  resolveChromeLaunchProfile,
  seedChromeProfilePreferences,
  terminateExistingProfileChrome,
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
  ComputerDemoState,
  createComputerDemoFrameServer,
  handleComputerDemoUpgrade,
  registerComputerDemoRoutes,
} from './computer-demo.js';
import {
  ElectronAppAlreadyRunningError,
  ElectronOverlayInjector,
  launchElectronApp,
  resolveOverlayThinBridge,
} from './electron-controller.js';
import type { FederatedCdpInspectableTarget } from './electron-federated-cdp.js';
import { getElectronAppPorts } from './electron-runtime.js';
import { ElectronTrayFollower } from './electron-tray-follower.js';
import { shouldParseGlobalJson } from './fetch-proxy-headers.js';
import { FileLogger } from './file-logger.js';
import { registerHostedBootstrapEndpoint } from './hosted-bootstrap.js';
import { registerHostFsRoutes, resolveHostMountRoots } from './hostfs.js';
import { startHostFsWatchers } from './hostfs-watch.js';
import { createBridgeServer } from './http-keepalive.js';
import { runInstallCli } from './install-cli.js';
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

const Dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(Dirname, '..', '..');

const _parsedCloudArgs = parseCloudArgs(process.argv.slice(2));
if (_parsedCloudArgs) {
  await runCloudSubcommand(_parsedCloudArgs);
  process.exit(0);
}

const RUNTIME_FLAGS = parseCliRuntimeFlags(process.argv.slice(2));

if (RUNTIME_FLAGS.version) {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (RUNTIME_FLAGS.installCli) {
  process.exit(await runInstallCli({ installDir: RUNTIME_FLAGS.installDir }));
}

const SERVE_ONLY = RUNTIME_FLAGS.serveOnly;
const ELECTRON_MODE = RUNTIME_FLAGS.electron;
const ELECTRON_APP = RUNTIME_FLAGS.electronApp;
const KILL_EXISTING_ELECTRON_APP = RUNTIME_FLAGS.kill;

const THIN_BRIDGE_MODE = !SERVE_ONLY;

const fileLogger = new FileLogger({
  logDir: RUNTIME_FLAGS.logDir ?? undefined,
  logLevel: RUNTIME_FLAGS.logLevel,
});
if (fileLogger.logFile) {
  console.log(`Log file: ${fileLogger.logFile}`);
}

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

function pipeChildOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[${label}:out] ${data}`);
  });
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[${label}:err] ${data}`);
  });
}

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

async function tryListenOnPortDualStack(port: number): Promise<number> {
  const assignedPort = await tryListenOnPort(port, '127.0.0.1');
  try {
    await tryListenOnPort(assignedPort, '::1');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw Object.assign(new Error(`Port ${assignedPort} in use on IPv6`), { code: 'EADDRINUSE' });
    }
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

const PREFERRED_SERVE_PORT = parseInt(process.env['PORT'] ?? '5710', 10);
const PREFERRED_CDP_PORT = RUNTIME_FLAGS.cdpPort;

interface ServerState {
  servePort: number;
  cdpPort: number;

  requestedCdpPort: number;
  serveOrigin: string;
  launchedBrowserProcess: ChildProcess | null;
  launchedBrowserLabel: string;
  overlayInjector: ElectronOverlayInjector | null;

  electronFollower: ElectronTrayFollower | null;
  shuttingDown: boolean;
  discoveredTrayJoinUrl: string | null;

  hostMountRoots: { path: string; root: string }[];

  bridgeToken: string | null;

  cdpUrl: string | null;
  chromeWs: WebSocket | null;

  chromeConnectionId: number;
  activeClientWs: WebSocket | null;

  activeClientId: number | null;

  clientConnectionSeq: number;
  messageBuffer: ClientFrameBuffer | null;

  chromeReconnect: ChromeReconnectController | null;
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
    electronFollower: null,
    shuttingDown: false,
    discoveredTrayJoinUrl: RUNTIME_FLAGS.joinUrl ?? null,
    hostMountRoots: [],
    bridgeToken: resolveServerBridgeToken(process.env, { thinBridgeMode: THIN_BRIDGE_MODE }),
    cdpUrl: null,
    chromeWs: null,
    chromeConnectionId: 0,
    activeClientWs: null,
    activeClientId: null,
    clientConnectionSeq: 0,
    messageBuffer: null,
    chromeReconnect: null,
  };
}

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
  if (SERVE_ONLY) {
    console.log(`Starting in serve-only mode (reusing external CDP on port ${state.cdpPort})`);
  }
  if (ELECTRON_MODE) console.log('Starting in Electron mode');
}

async function launchBrowser(state: ServerState): Promise<void> {
  if (ELECTRON_MODE && !SERVE_ONLY) {
    await launchElectronTarget(state);
  } else if (!SERVE_ONLY) {
    await launchChromeTarget(state);
  }
}

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
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.log(
          `Leader on port ${PREFERRED_SERVE_PORT} has no active tray (state: ${status.state ?? 'unknown'})`
        );
        break;
      }
    } catch {
      break;
    }
  }
  return null;
}

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

function resolveThinLeaderOrigin(): string {
  const explicit = RUNTIME_FLAGS.leadWorkerBaseUrl ?? process.env['WORKER_BASE_URL'] ?? null;
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  return SLICC_HOSTED_ORIGIN;
}

function buildBrowserLaunchUrl(state: ServerState): string {
  const serveOriginForLaunch = state.bridgeToken ? resolveThinLeaderOrigin() : state.serveOrigin;

  let url = resolveCliBrowserLaunchUrl({
    serveOrigin: serveOriginForLaunch,
    lead: RUNTIME_FLAGS.lead,
    leadWorkerBaseUrl: RUNTIME_FLAGS.leadWorkerBaseUrl,
    envWorkerBaseUrl: process.env['WORKER_BASE_URL'] ?? null,
    join: RUNTIME_FLAGS.join,
    joinUrl: RUNTIME_FLAGS.joinUrl,
    bridgeWsUrl: state.bridgeToken ? `ws://localhost:${state.servePort}/cdp` : null,
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
  } else {
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
    executablePreference: !chromeProfile.id ? 'installed' : 'chrome-for-testing',
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
    mockKeychain: process.env.SLICC_CHROME_MOCK_KEYCHAIN === '1',
  });

  await clearStaleDevToolsActivePort(chromeProfile.userDataDir);

  await terminateExistingProfileChrome(chromeProfile.userDataDir);

  await clearChromeSessionRestore(chromeProfile.userDataDir);

  await clearChromeRestoreState(chromeProfile.userDataDir);

  await seedChromeProfilePreferences(chromeProfile.userDataDir);

  const spawnPlan = planChromeSpawn({ executablePath: chromePath, chromeArgs });

  state.launchedBrowserProcess = spawn(spawnPlan.command, spawnPlan.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
  });
  state.launchedBrowserLabel = chromeProfile.displayName;

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

function cdpFrameToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);

  return Buffer.from(String(data));
}

function closeWebSocketQuietly(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    ws.close();
  } catch {}
}

function rejectUpgradeUnauthorized(socket: import('node:stream').Duplex, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 401 Unauthorized\r\n` +
        `Content-Type: text/plain\r\n` +
        `Connection: close\r\n` +
        `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
        `\r\n${reason}`
    );
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

function attachCdpUpgradeRouting(
  server: HttpServer,
  wss: WebSocketServer,
  lickWss: WebSocketServer,
  bridgeToken: string | null,
  computerDemoWss: WebSocketServer | null = null
): void {
  const upgradeRejectDedup = new CliLogDedup('[cdp-proxy]');
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
          const detail = describeUpgradeRejection(
            gate.reason,
            request.headers['sec-websocket-protocol']
          );
          const line = `[cdp-proxy] /cdp upgrade rejected: ${detail}`;
          if (upgradeRejectDedup.shouldLog(line)) console.warn(line);

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
    } else if (computerDemoWss) {
      handleComputerDemoUpgrade(pathname, request, socket, head, computerDemoWss);
    }
  });
}

function flushClientFrame(target: WebSocket, raw: unknown, ctx: CdpProxyContext): void {
  const original = String(raw);
  const { output } = applyCdpUnmask(original, {
    tracker: ctx.cdpSessionUrls,
    pipeline: ctx.secretProxy.rawPipeline,
  });
  target.send(output);
}

function logDroppedClientFrames(ctx: CdpProxyContext, dropped: DroppedClientFrames | null): void {
  if (dropped) logCdpProxy(ctx, describeDroppedClientFrames(dropped));
}

function flushBufferedClientFrames(
  state: ServerState,
  target: WebSocket,
  targetConnectionId: number,
  ctx: CdpProxyContext
): void {
  const { frames, dropped } = takeClientFrameBuffer(state, targetConnectionId);
  logDroppedClientFrames(ctx, dropped);
  for (const msg of frames) {
    flushClientFrame(target, msg, ctx);
  }
}

function forwardChromeFrame(state: ServerState, buf: Buffer, ctx: CdpProxyContext): void {
  const byteLen = buf.length;

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

  ctx.cdpSessionUrls.observeChromeToClient(str);
  if (state.activeClientWs && state.activeClientWs.readyState === WebSocket.OPEN) {
    state.activeClientWs.send(str);
  }
}

function logCdpProxy(ctx: CdpProxyContext, line: string): void {
  if (ctx.cdpDedup.shouldLog(line)) console.log(line);
}

function resetActiveCdpClient(state: ServerState, ctx: CdpProxyContext, reason: string): void {
  if (
    !closeClientForUpstreamReset(state.activeClientWs, reason, (line) => logCdpProxy(ctx, line))
  ) {
    return;
  }

  state.activeClientWs = null;
  logDroppedClientFrames(ctx, releaseClientSlot(state, 'upstream-reset'));
}

function ensureChromeReconnectController(
  state: ServerState,
  ctx: CdpProxyContext
): ChromeReconnectController {
  state.chromeReconnect ??= new ChromeReconnectController({
    discoverChromeWsUrl: async () => {
      const port = state.cdpPort > 0 ? state.cdpPort : await waitForServerCdpPort(state);

      const url = await waitForCDP(port, 3, 500);
      state.cdpUrl = url;
      return url;
    },
    connectChrome: (url) => ensureChromeConnection(state, url, ctx),
    isChromeLegHealthy: () => state.chromeWs?.readyState === WebSocket.OPEN,
    resetClient: (reason) => resetActiveCdpClient(state, ctx, reason),
    activeClientId: () => state.activeClientId,
    isShuttingDown: () => state.shuttingDown,
    log: (line) => logCdpProxy(ctx, line),
  });
  return state.chromeReconnect;
}

function handleChromeLegDown(
  state: ServerState,
  ctx: CdpProxyContext,
  chromeWs: WebSocket,
  reason: string
): void {
  if (!markChromeLegDown(state, chromeWs)) return;
  ensureChromeReconnectController(state, ctx).schedule(reason);
}

function ensureChromeConnection(
  state: ServerState,
  url: string,
  ctx: CdpProxyContext
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (state.chromeWs && state.chromeWs.readyState === WebSocket.OPEN) {
      flushBufferedClientFrames(state, state.chromeWs, state.chromeConnectionId, ctx);
      resolve();
      return;
    }
    closeWebSocketQuietly(state.chromeWs);

    state.chromeWs = null;

    state.messageBuffer ??= createClientFrameBuffer(currentBufferGeneration(state));

    const chromeWs = new WebSocket(url, { maxPayload: 0 });
    const connectionId = ++state.chromeConnectionId;
    state.chromeWs = chromeWs;
    let opened = false;

    chromeWs.on('open', () => {
      opened = true;
      console.log('[cdp-proxy] chromeWs open');
      flushBufferedClientFrames(state, chromeWs, connectionId, ctx);
      resolve();
    });
    chromeWs.on('message', (data) => {
      forwardChromeFrame(state, cdpFrameToBuffer(data), ctx);
    });
    chromeWs.on('close', (code, reason) => {
      console.log(`[cdp-proxy] Chrome WS closed. code=${code}, reason=${String(reason)}`);
      handleChromeLegDown(state, ctx, chromeWs, `close code=${code}`);

      if (!opened) reject(new Error(`Chrome WS closed before open (code=${code})`));
    });
    chromeWs.on('error', (err) => {
      console.log(`[cdp-proxy] Chrome WS error: ${err}`);
      handleChromeLegDown(state, ctx, chromeWs, `error: ${String(err)}`);
      reject(err);
    });
  });
}

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
    if (appendBufferedClientFrame(state.messageBuffer.frames, data)) {
      logCdpProxy(ctx, '[cdp-proxy] Client frame buffer full — dropped oldest buffered frame');
    }
    const msg = `[cdp-proxy] Client→Chrome (buffered): ${preview}`;
    if (ctx.cdpDedup.shouldLog(msg)) console.debug(msg);
  } else {
    console.log(`[cdp-proxy] Client→Chrome (DROPPED — no connection): ${preview}`);
  }
}

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
    if (state.activeClientWs && state.activeClientWs.readyState === WebSocket.OPEN) {
      console.log('[cdp-proxy] Closing previous client connection (superseded by new client)');
      state.activeClientWs.close(CDP_SUPERSEDED_CLOSE_CODE, 'superseded-by-new-cdp-client');
    }
    state.activeClientWs = clientWs;
    console.log('[cdp-proxy] New client connected');

    const clientId = ++state.clientConnectionSeq;
    logDroppedClientFrames(ctx, adoptClientSlot(state, clientId));

    clientWs.on('message', (data) => {
      if (!clientHoldsSlot(state, clientId)) {
        logCdpProxy(
          ctx,
          '[cdp-proxy] Client→Chrome (DROPPED — client no longer holds the /cdp slot)'
        );
        return;
      }
      forwardClientFrame(state, data, ctx);
    });
    clientWs.on('close', () => {
      console.log('[cdp-proxy] Client disconnected');

      if (state.activeClientWs !== clientWs) return;
      state.activeClientWs = null;
      logDroppedClientFrames(ctx, releaseClientSlot(state, 'client-disconnected'));
    });
    clientWs.on('error', (err) => {
      console.log(`[cdp-proxy] Client WS error: ${err}`);
      if (state.activeClientWs !== clientWs) return;
      state.activeClientWs = null;
      logDroppedClientFrames(ctx, releaseClientSlot(state, 'client-disconnected'));
    });

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

interface ShutdownDeps {
  fileLogger: FileLogger;
  wss: WebSocketServer;
  server: HttpServer;
}

function createGracefulShutdown(state: ServerState, deps: ShutdownDeps): () => Promise<void> {
  return async () => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    console.log('\nShutting down...');
    deps.fileLogger.close();

    state.overlayInjector?.stop();
    state.overlayInjector = null;

    state.electronFollower?.stop();
    state.electronFollower = null;

    state.chromeReconnect?.cancel();
    state.chromeReconnect = null;

    closeWebSocketQuietly(state.chromeWs);
    state.chromeWs = null;
    closeWebSocketQuietly(state.activeClientWs);
    state.activeClientWs = null;
    state.activeClientId = null;
    state.messageBuffer = null;
    for (const client of deps.wss.clients) {
      client.close();
    }
    deps.wss.close();

    deps.server.close();

    await closeLaunchedBrowserGracefully(state, state.cdpPort);
    process.exit(0);
  };
}

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
        pageUrlPrefix: resolveThinLeaderOrigin() + '/',
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
    if (!thinBridge) {
      throw new Error(
        'Cannot start Electron overlay injector: no bridge token resolved. ' +
          'The thin-bridge overlay requires a per-process bridge token (set SLICC_BRIDGE_TOKEN).'
      );
    }
    state.overlayInjector = await ElectronOverlayInjector.create({
      cdpPort,
      servePort,
      projectRoot: PROJECT_ROOT,
      thinBridge,

      trayJoinUrl: parseTrayJoinUrl(state.discoveredTrayJoinUrl)?.joinUrl ?? null,

      onEgressBlocked: () => {
        void startElectronFollower(state, cdpPort);
      },
    });
    await state.overlayInjector.start();
    console.log(
      `[electron-float] Overlay injector is watching Electron page targets (thin bridge → ${thinBridge.hostedLeaderOrigin})`
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[electron-float] Failed to start overlay injector:', message);
  }
}

async function startElectronFollower(state: ServerState, cdpPort: number): Promise<void> {
  if (state.electronFollower || state.shuttingDown) return;
  const joinUrl = state.discoveredTrayJoinUrl;
  if (!joinUrl) {
    console.log(
      '[electron-follower] app blocks renderer egress but no tray join URL (--join) is set — cannot expose its CDP to a leader'
    );
    return;
  }
  try {
    const versionUrl = `http://127.0.0.1:${cdpPort}/json/version`;
    const listUrl = `http://127.0.0.1:${cdpPort}/json/list`;

    const version = (await (
      await fetch(versionUrl, { signal: AbortSignal.timeout(5000) })
    ).json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) throw new Error('no browser webSocketDebuggerUrl from CDP');
    const follower = new ElectronTrayFollower({
      joinUrl,
      browserWsUrl: version.webSocketDebuggerUrl,
      listTargets: async () =>
        (await (
          await fetch(listUrl, { signal: AbortSignal.timeout(5000) })
        ).json()) as FederatedCdpInspectableTarget[],
      logger: (m) => {
        console.log(m);
      },
    });
    state.electronFollower = follower;
    await follower.start();
    console.log('[electron-follower] headless CDP-over-CDP follower started');
  } catch (error: unknown) {
    state.electronFollower = null;
    const message = error instanceof Error ? error.message : String(error);
    console.error('[electron-follower] Failed to start follower:', message);
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

function startListening(deps: Omit<CdpServerDeps, 'ctx' | 'app'>): Promise<void> {
  const { server, fileLogger, servePort, serveOrigin, cdpPort } = deps;
  return new Promise((resolve) => {
    server.listen(servePort, '127.0.0.1', () => {
      console.log(`Thin /cdp bridge + /api at ${serveOrigin}`);
      console.log(`CDP proxy at ws://localhost:${servePort}/cdp`);
      fileLogger.log('info', 'CLI server started', {
        port: servePort,
        cdpPort,
        electronMode: ELECTRON_MODE,
      });
      resolve();
    });
  });
}

function runCdpProxyWarmup(state: ServerState, deps: CdpServerDeps): void {
  const { app, ctx, servePort } = deps;
  void preconnectCdp(state, ctx, app, servePort);

  if (ELECTRON_MODE) {
    void startOverlayInjector(state, state.cdpPort, servePort);
  }
}

interface SecretBootstrap {
  secretStore: EnvSecretStore;
  secretProxy: SecretProxyManager;
  oauthStore: OauthSecretStore;
}

async function bootstrapSecrets(): Promise<SecretBootstrap> {
  const sessionDir = RUNTIME_FLAGS.envFile
    ? dirname(RUNTIME_FLAGS.envFile)
    : join(homedir(), '.slicc');
  const sessionId = readOrCreateSessionId(sessionDir);
  const oauthStore = new OauthSecretStore();

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

function createThinBridgeCorsMiddleware(
  bridgeToken: string | null
): import('express').RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS' && cors) {
      for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
      res.setHeader('Access-Control-Max-Age', preflightMaxAge(req.path));
      res.status(204).end();
      return;
    }

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
  const state = createServerState();
  await resolvePorts(state);
  const { servePort: SERVE_PORT } = state;

  const { secretStore, secretProxy, oauthStore } = await bootstrapSecrets();

  const app = express();
  app.use(requestLogger);

  app.use(sliccLinksMiddleware());

  if (shouldMountThinBridgeCors(THIN_BRIDGE_MODE, state.bridgeToken)) {
    app.use(createThinBridgeCorsMiddleware(state.bridgeToken));
  }

  const lickBridge = createLickBridge();
  const { lickWss, broadcastLickEvent } = lickBridge;

  registerOAuthCallbackRoutes(app);

  app.use(express.json({ limit: '50mb', type: shouldParseGlobalJson }));

  app.get('/api/runtime-config', (_req, res) => {
    res.json({
      trayWorkerBaseUrl:
        (process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() || null) ??
        RUNTIME_FLAGS.leadWorkerBaseUrl ??
        (process.env['WORKER_BASE_URL']?.trim() || null) ??
        SLICC_HOSTED_ORIGIN,

      trayJoinUrl: state.discoveredTrayJoinUrl ?? null,

      autoMounts: state.hostMountRoots.map(({ path, root }) => ({ path, hostPath: root })),
    });
  });

  app.get('/api', (req, res) => {
    const host = req.headers.host ?? `localhost:${SERVE_PORT}`;
    res.json(buildLocalApiDescriptor(host));
  });

  app.get('/api/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      service: 'slicc-node-server',
      timestamp: new Date().toISOString(),
    });
  });

  registerLickApiRoutes(app, lickBridge);

  registerHandoffRoute(app, { broadcastLickEvent });

  registerSecretRoutes(app, { secretStore, secretProxy, oauthStore, devMode: false });

  if (RUNTIME_FLAGS.hosted) {
    registerCloudStatusEndpoint(app, { joinFilePath: '/tmp/slicc-join.json' });
    registerHostedBootstrapEndpoint(app, { secretStore });
    registerSecretsReloadEndpoint(app, { secretProxy, secretStore, oauthStore });
  }

  state.hostMountRoots = await resolveHostMountRoots(RUNTIME_FLAGS.mounts);
  registerHostFsRoutes(app, state.hostMountRoots);
  const hostFsWatch = startHostFsWatchers(state.hostMountRoots, (event) => {
    broadcastLickEvent(event);
  });

  registerSudoApproveEndpoint(app);

  const computerDemo = RUNTIME_FLAGS.computerDemo ? new ComputerDemoState() : null;
  if (computerDemo) registerComputerDemoRoutes(app, computerDemo);

  registerFetchProxyRoute(app, { secretProxy });

  const server = createBridgeServer(app);

  const wss = createCdpWebSocketServer(state.bridgeToken);
  const computerDemoWss = computerDemo ? createComputerDemoFrameServer(computerDemo) : null;
  attachCdpUpgradeRouting(server, wss, lickWss, state.bridgeToken, computerDemoWss);
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
  const shutdown = async (): Promise<void> => {
    hostFsWatch.stop();
    await gracefulShutdown();
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('exit', () => {
    const browser = state.launchedBrowserProcess;
    if (!state.shuttingDown && browser) {
      try {
        browser.kill();
      } catch {}
    }
  });

  await startCdpStack(state, { app, server, wss, cdpCtx, fileLogger });
}

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

async function readSecretsEnvKey(name: string): Promise<string | undefined> {
  try {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    const file = process.env['SLICC_SECRETS_FILE'] ?? join(home, '.slicc', 'secrets.env');
    const contents = await fsPromises.readFile(file, 'utf-8');
    for (const line of contents.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim();
    }
  } catch {}
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
        workerBaseUrl: process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() || SLICC_HOSTED_ORIGIN,
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
