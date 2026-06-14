#!/usr/bin/env node
import { promises as fsPromises } from 'node:fs';
import { createSubstrate } from '@slicc/cloud-core';
import { type ChildProcess, spawn } from 'child_process';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { createServer as createNetServer } from 'net';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
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

async function main() {
  // Resolve available ports before anything else — serve port must be known
  // before Chrome launches (the launch URL contains it).
  let SERVE_PORT: number;
  let CDP_PORT: number;
  let REQUESTED_CDP_PORT: number;
  let usingDynamicElectronPorts = false;

  if (ELECTRON_MODE && ELECTRON_APP && !RUNTIME_FLAGS.explicitCdpPort) {
    // Dynamic port allocation for Electron apps (hash-based with fallback)
    const ports = await getElectronAppPorts(ELECTRON_APP);
    CDP_PORT = ports.cdpPort;
    SERVE_PORT = ports.servePort;
    REQUESTED_CDP_PORT = CDP_PORT;
    usingDynamicElectronPorts = true;
  } else {
    SERVE_PORT = await findAvailablePort(PREFERRED_SERVE_PORT);
    // For Chrome CDP, we pass port 0 to let Chrome pick any available port,
    // then parse the actual port from its stderr. This avoids race conditions
    // where Node's port probe succeeds but Chrome still can't bind the port.
    // Electron mode keeps the preferred port (external CDP, not launched by us).
    REQUESTED_CDP_PORT = ELECTRON_MODE ? PREFERRED_CDP_PORT : 0;
    CDP_PORT = ELECTRON_MODE ? PREFERRED_CDP_PORT : 0;
  }

  const SERVE_ORIGIN = `http://localhost:${SERVE_PORT}`;

  if (usingDynamicElectronPorts) {
    console.log(`Dynamic port allocation for Electron app: CDP=${CDP_PORT}, serve=${SERVE_PORT}`);
  } else if (SERVE_PORT !== PREFERRED_SERVE_PORT) {
    console.log(`Port ${PREFERRED_SERVE_PORT} in use, serving on port ${SERVE_PORT}`);
  }

  if (DEV_MODE) {
    console.log('Starting in dev mode (Vite HMR enabled)');
  }
  if (SERVE_ONLY) {
    console.log(`Starting in serve-only mode (reusing external CDP on port ${CDP_PORT})`);
  }
  if (ELECTRON_MODE) {
    console.log('Starting in Electron mode');
  }

  let launchedBrowserProcess: ChildProcess | null = null;
  let launchedBrowserLabel = 'Browser';
  let overlayInjector: ElectronOverlayInjector | null = null;
  let shuttingDown = false;
  // Tray join URL discovered from an existing leader on the preferred port.
  // Populated in Electron mode when auto-discovering the leader's tray.
  let discoveredTrayJoinUrl: string | null = RUNTIME_FLAGS.joinUrl ?? null;

  // 1. Launch Chrome unless an external CDP provider is already running.
  if (ELECTRON_MODE && !SERVE_ONLY) {
    if (!ELECTRON_APP) {
      console.error(
        'Electron mode requires an app path. Pass --electron <path> or --electron-app=<path>.'
      );
      process.exit(1);
    }

    try {
      const { child, displayName } = await launchElectronApp({
        appPath: ELECTRON_APP,
        cdpPort: CDP_PORT,
        kill: KILL_EXISTING_ELECTRON_APP,
      });

      launchedBrowserProcess = child;
      launchedBrowserLabel = displayName;
      pipeChildOutput(child, 'electron-app');

      // Track when app exits - quick exits before CDP connects indicate a problem
      let cdpConnected = false;
      let exitCode: number | null = null;
      let exitResolve: (() => void) | null = null;
      const exitPromise = new Promise<void>((resolve) => {
        exitResolve = resolve;
      });

      child.on('exit', (code) => {
        exitCode = code;
        exitResolve?.();
        if (shuttingDown) return;
        if (cdpConnected) {
          // Normal exit after we connected
          console.log(`${displayName} exited with code ${code}`);
          process.exit(0);
        }
        // If CDP not yet connected, don't exit - let waitForCDP handle it
      });

      console.log(`Waiting for ${displayName} CDP on port ${CDP_PORT}...`);
      try {
        // Race between CDP connection and app exit
        await Promise.race([
          waitForCDP(CDP_PORT, 40, 500).then(() => {
            cdpConnected = true;
          }),
          exitPromise.then(() => {
            if (!cdpConnected) {
              throw new Error('app-exited');
            }
          }),
        ]);
      } catch (_err) {
        // Check if app exited quickly (likely due to disabled remote debugging fuse)
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
        throw new Error(`Could not connect to ${displayName} CDP on port ${CDP_PORT}`);
      }
      console.log(`Connected to ${displayName} on CDP port ${CDP_PORT}`);

      // Auto-discover leader's tray join URL when another instance runs on the preferred port.
      // The leader may still be creating its tray session, so retry a few times.
      if (!discoveredTrayJoinUrl && SERVE_PORT !== PREFERRED_SERVE_PORT) {
        const leaderOrigin = `http://localhost:${PREFERRED_SERVE_PORT}`;
        for (let attempt = 0; attempt < 5 && !discoveredTrayJoinUrl; attempt++) {
          try {
            const resp = await fetch(`${leaderOrigin}/api/tray-status`, {
              signal: AbortSignal.timeout(3000),
            });
            if (resp.ok) {
              const status = (await resp.json()) as { state?: string; joinUrl?: string | null };
              if (status.joinUrl) {
                discoveredTrayJoinUrl = status.joinUrl;
                console.log(`Discovered leader tray join URL: ${status.joinUrl}`);
              } else if (status.state === 'connecting') {
                // Leader is still setting up — wait and retry
                await new Promise((r) => setTimeout(r, 2000));
              } else {
                console.log(
                  `Leader on port ${PREFERRED_SERVE_PORT} has no active tray (state: ${status.state ?? 'unknown'})`
                );
                break;
              }
            } else {
              break;
            }
          } catch {
            // Leader not reachable or no tray status endpoint — continue without tray
            break;
          }
        }
      }
    } catch (error: unknown) {
      if (error instanceof ElectronAppAlreadyRunningError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  } else if (!SERVE_ONLY) {
    let browserLaunchUrl = resolveCliBrowserLaunchUrl({
      serveOrigin: SERVE_ORIGIN,
      lead: RUNTIME_FLAGS.lead,
      leadWorkerBaseUrl: RUNTIME_FLAGS.leadWorkerBaseUrl,
      envWorkerBaseUrl: process.env['WORKER_BASE_URL'] ?? null,
      join: RUNTIME_FLAGS.join,
      joinUrl: RUNTIME_FLAGS.joinUrl,
    });
    // Append runtime parameter for hosted mode
    if (RUNTIME_FLAGS.hosted) {
      const sep = browserLaunchUrl.includes('?') ? '&' : '?';
      browserLaunchUrl += `${sep}runtime=hosted-leader`;
    }
    // Append optional prompt parameter
    if (RUNTIME_FLAGS.prompt) {
      const sep = browserLaunchUrl.includes('?') ? '&' : '?';
      browserLaunchUrl += `${sep}prompt=${encodeURIComponent(RUNTIME_FLAGS.prompt)}`;
    }
    if (RUNTIME_FLAGS.join) {
      console.log(`Join launch URL: ${browserLaunchUrl}`);
    } else if (RUNTIME_FLAGS.lead) {
      console.log(`Lead launch URL: ${browserLaunchUrl}`);
    }

    const chromeProfile = (() => {
      try {
        const resolved = resolveChromeLaunchProfile({
          projectRoot: PROJECT_ROOT,
          profile: RUNTIME_FLAGS.profile,
          servePort: SERVE_PORT,
        });
        // Override user data dir in hosted mode to use persistent profile
        if (RUNTIME_FLAGS.hosted) {
          resolved.userDataDir = process.env['CHROME_USER_DATA_DIR'] ?? '/data/profile';
        }
        return resolved;
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    })();

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
      cdpPort: REQUESTED_CDP_PORT,
      launchUrl: browserLaunchUrl,
      profile: chromeProfile,
      hosted: RUNTIME_FLAGS.hosted,
    });

    // Profile directories are reused across runs (both the dev
    // `/tmp/browser-coding-agent-chrome` profile and the persistent
    // `.qa/chrome/<profile>` QA profiles). Chrome never proactively
    // clears `DevToolsActivePort` on shutdown, so a stale file from a
    // previous crash/SIGKILL would let our active-port-file poller win
    // the race instantly with the wrong port. Clear it before spawn.
    await clearStaleDevToolsActivePort(chromeProfile.userDataDir);

    // On macOS, route through `/usr/bin/open` so LaunchServices owns the
    // new Chrome process. Without this hop the terminal that started
    // `node` stays in Chrome's TCC responsibility chain, which silently
    // breaks `getUserMedia()` (camera/mic in Google Meet, Zoom, etc.)
    // whenever the terminal hasn't already been granted camera/microphone
    // access. With LaunchServices in the loop, Chrome becomes its own
    // TCC responsible process and the user's
    // `/Applications/Google Chrome.app` privacy grant applies as expected.
    const spawnPlan = planChromeSpawn({ executablePath: chromePath, chromeArgs });

    launchedBrowserProcess = spawn(spawnPlan.command, spawnPlan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
    });
    launchedBrowserLabel = chromeProfile.displayName;

    // Use the stderr-vs-DevToolsActivePort race so we work in both
    // direct-exec mode (Linux/Windows, or bare-binary fallbacks where
    // stderr carries Chrome's banner) and LaunchServices mode (macOS,
    // where stderr belongs to `open` and only the active-port file
    // surfaces the real CDP port).
    const actualCdpPort = await waitForCdpPort(launchedBrowserProcess, {
      userDataDir: chromeProfile.userDataDir,
    });
    CDP_PORT = actualCdpPort;
    console.log(`Chrome CDP listening on port ${CDP_PORT}`);

    pipeChildOutput(launchedBrowserProcess, 'chrome');

    launchedBrowserProcess.on('exit', (code) => {
      if (shuttingDown) return;
      console.log(`Chrome exited with code ${code}`);
      process.exit(0);
    });
  }

  // 3. Set up express app with request logging
  const sessionDir = RUNTIME_FLAGS.envFile
    ? dirname(RUNTIME_FLAGS.envFile)
    : join(homedir(), '.slicc');
  const sessionId = readOrCreateSessionId(sessionDir);
  const oauthStore = new OauthSecretStore();
  // Env-file secrets (~/.slicc/secrets.env) feed the fetch-proxy mask
  // pipeline alongside OAuth tokens. The same instance is reused below
  // for the /api/secrets routes and the S3 sign-and-forward handler.
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

  const app = express();
  app.use(requestLogger);
  // Append SLICC's standard RFC 8288 Link header set on every /api/* response.
  app.use(sliccLinksMiddleware());

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
        // Hosted mode source: env var injected at sandbox-create time.
        (RUNTIME_FLAGS.hosted ? process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() : null) ??
        RUNTIME_FLAGS.leadWorkerBaseUrl ??
        (process.env['WORKER_BASE_URL']?.trim() || null) ??
        (DEV_MODE
          ? 'https://slicc-tray-hub-staging.minivelos.workers.dev'
          : 'https://www.sliccy.ai'),
      trayJoinUrl: discoveredTrayJoinUrl ?? null,
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

  if (DEV_MODE && !RUNTIME_FLAGS.hosted) {
    // Dev mode: use Vite's dev server as middleware for HMR
    const { createServer: createViteServer } = await import('vite');
    const webappIndexHtml = resolve(process.cwd(), 'packages/webapp/index.html');
    const vite = await createViteServer({
      configFile: resolve(process.cwd(), 'packages/webapp/vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: {
          server, // Share the HTTP server — our upgrade handler routes /cdp and /licks-ws separately
          path: '/__vite_hmr', // Dedicated path avoids conflicts with /cdp upgrade handler
        },
      },
      appType: 'custom', // We handle index.html serving ourselves via the handler below
      root: process.cwd(),
    });
    app.use(vite.middlewares);
    app.use(async (req, res, next) => {
      if (
        req.method !== 'GET' ||
        !req.headers.accept?.includes('text/html') ||
        req.path.includes('.')
      ) {
        next();
        return;
      }

      try {
        const template = readFileSync(webappIndexHtml, 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).setHeader('Content-Type', 'text/html');
        res.end(html);
      } catch (err: unknown) {
        if (err instanceof Error) {
          vite.ssrFixStacktrace(err);
        }
        next(err);
      }
    });
    console.log(`Vite dev server middleware attached (HMR on ${SERVE_ORIGIN}/__vite_hmr)`);
  } else {
    // Production mode: serve built static files
    const uiDir = resolve(Dirname, '..', 'ui');
    app.use(
      express.static(uiDir, {
        setHeaders: (res, path) => {
          // Default Cache-Control for anything not classified below:
          // HTML, manifest, sprinkle-sandbox.html, publicDir fonts/logos,
          // favicon, etc. None of these are content-hashed and they
          // reference hashed asset URLs that change on rebuild. If the
          // browser serves a stale `index.html` out of its heuristic
          // cache, the referenced `/assets/*` chunks 404 after an update
          // — the user sees
          //   "Failed to fetch dynamically imported module: …/assets/<old-hash>.js"
          // on every cone bootstrap until they hard-refresh.
          // `no-cache` forces a conditional revalidation on every load
          // (cheap — `serve-static`'s default ETag yields a 304 when
          // unchanged) so the tab picks up a freshly-built `index.html`
          // after `npm run build`.
          //
          // The single `setHeader` at the end is intentional: each
          // branch overrides the default by assigning to `cacheControl`.
          // To add a fourth bucket, add an `else if` ABOVE the final
          // assignment — never a separate `setHeader` after, or the
          // catch-all silently wins.
          let cacheControl = 'no-cache';
          if (path.endsWith('llm-proxy-sw.js') || path.endsWith('preview-sw.js')) {
            // Service workers need `Service-Worker-Allowed: /` for the
            // root-scoped registration `llm-proxy-sw.js` does (the
            // `preview-sw.js` SW registers at scope `/preview/`, which
            // is narrower than `/` so the broader allowance is harmless).
            //
            // `no-store`, not `no-cache`: the browser only re-checks
            // the SW script on navigation/registration, so the safest
            // signal is "always pull the latest bytes." A stale SW
            // pinned in cache would intercept fetch / dispatch
            // `preview/*` with outdated logic (e.g. an outdated
            // forbidden-header encoding scheme that no longer matches
            // the server-side restoration in `index.ts`, or a stale
            // `preview-sw` VFS handler) — that's a worse failure mode
            // than the `no-cache` revalidation cost.
            res.setHeader('Service-Worker-Allowed', '/');
            cacheControl = 'no-store';
          } else if (path.includes(`${sep}assets${sep}`)) {
            // Vite emits content-hashed filenames into `/assets/` —
            // the hash changes when content changes, so the file at a
            // given URL is byte-for-byte immutable. Cache forever to
            // avoid revalidation round-trips. The `path` parameter is
            // a filesystem path (uses `sep` on Windows, `/` elsewhere),
            // hence the platform-aware match.
            cacheControl = 'public, max-age=31536000, immutable';
          }
          res.setHeader('Cache-Control', cacheControl);
        },
      })
    );

    // SPA fallback — serve index.html for all non-file routes. Same
    // `no-cache` reasoning as above: the served `index.html` carries
    // references to the current asset hashes, and stale-cached HTML
    // is the canonical post-update breakage.
    app.get('/{*path}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(uiDir, 'index.html'));
    });
  }

  // 4. CDP WebSocket proxy at /cdp
  //    Use noServer mode so Vite's dev middleware doesn't intercept the
  //    upgrade. Keep the default per-message payload cap on this socket —
  //    the oversized-message feedback loop we have to defend against
  //    (see the chromeWs constructor below for the full writeup) is
  //    purely Chrome-to-proxy, never client-to-proxy, so raising the
  //    cap here would only widen the DoS surface for anything on
  //    localhost that can reach ws://127.0.0.1:PORT/cdp.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url!, `http://${request.headers.host}`);
    if (pathname === '/cdp') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else if (pathname === '/licks-ws') {
      lickWss.handleUpgrade(request, socket, head, (ws) => {
        lickWss.emit('connection', ws, request);
      });
    }
    // For other paths, do nothing — let Vite handle HMR upgrades
  });

  // ---------------------------------------------------------------------------
  // Shared CDP proxy state — Chrome's browser-level debugger URL only accepts
  // ONE concurrent WebSocket connection. We keep a single chromeWs and swap
  // out the active client when a new one connects.
  // ---------------------------------------------------------------------------
  let cdpUrl: string | null = null;
  let chromeWs: WebSocket | null = null;
  let activeClientWs: WebSocket | null = null;
  let messageBuffer: unknown[] | null = null;
  const cdpDedup = new CliLogDedup();
  // Tracks per-session current URL by sniffing Chrome→Client events; feeds
  // the Client→Chrome unmask gate so per-frame unmasking is scoped to
  // the target tab's actual hostname (fail-closed when unknown).
  const cdpSessionUrls = createCdpSessionUrlTracker();

  // Ensure everything is cleaned up when CLI exits
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    fileLogger.close();

    overlayInjector?.stop();
    overlayInjector = null;

    // Close the shared Chrome WebSocket and all client connections
    if (chromeWs) {
      try {
        chromeWs.close();
      } catch {
        /* ignore */
      }
      chromeWs = null;
    }
    if (activeClientWs) {
      try {
        activeClientWs.close();
      } catch {
        /* ignore */
      }
      activeClientWs = null;
    }
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();

    // Stop accepting new HTTP connections
    server.close();

    if (launchedBrowserProcess) {
      let browserExited = false;
      launchedBrowserProcess.on('exit', () => {
        browserExited = true;
      });

      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
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
          launchedBrowserProcess.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }

      console.log(`${launchedBrowserLabel} closed`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    gracefulShutdown();
  });
  process.on('SIGTERM', () => {
    gracefulShutdown();
  });
  process.on('exit', () => {
    // Synchronous last-resort cleanup — kill the launched browser if it is still running.
    if (!shuttingDown && launchedBrowserProcess) {
      try {
        launchedBrowserProcess.kill();
      } catch {
        /* ignore */
      }
    }
  });

  // Apply the Client→Chrome unmask gate to a buffered frame on flush.
  // Defined here so both buffer-drain sites (ensureChromeConnection
  // already-open path + chromeWs 'open' handler) share one
  // implementation; falls back to the original bytes on any error.
  const flushClientFrame = (target: WebSocket, raw: unknown): void => {
    const original = String(raw);
    const { output } = applyCdpUnmask(original, {
      tracker: cdpSessionUrls,
      pipeline: secretProxy.rawPipeline,
    });
    target.send(output);
  };

  function ensureChromeConnection(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (chromeWs && chromeWs.readyState === WebSocket.OPEN) {
        // Already connected — flush any buffered messages and go direct
        if (messageBuffer) {
          for (const msg of messageBuffer) {
            flushClientFrame(chromeWs, msg);
          }
          messageBuffer = null;
        }
        resolve();
        return;
      }
      // Clean up old connection
      if (chromeWs) {
        try {
          chromeWs.close();
        } catch {
          /* ignore */
        }
      }

      messageBuffer = [];
      // Disable the ws library's per-message size cap (default 100 MiB).
      // The slicc UI runs INSIDE the Chrome instance it's debugging, so
      // Chrome's Network domain reports every CDP frame — including the
      // event frames themselves — back to us as `Network.webSocketFrame*`
      // messages that each embed the prior frame's payload. That produces
      // an exponential feedback loop which, left unchecked, trips the
      // default 100 MiB cap and closes the Chrome WebSocket (code 1006).
      // Without the cap the loop is still bounded by Chrome's own frame
      // limits, but the proxy no longer dies and later CDP calls like
      // `Target.getTargets` keep working instead of being DROPPED.
      chromeWs = new WebSocket(url, { maxPayload: 0 });

      chromeWs.on('open', () => {
        console.log('[cdp-proxy] chromeWs open');
        // Flush buffered messages
        if (messageBuffer) {
          for (const msg of messageBuffer) {
            flushClientFrame(chromeWs!, msg);
          }
          messageBuffer = null;
        }
        resolve();
      });

      // The slicc UI runs inside the Chrome instance it's debugging, so
      // Chrome's Network domain reports every CDP frame back through the
      // same socket as `Network.webSocketFrameReceived` /
      // `Network.webSocketFrameSent` events whose `payloadData` embeds
      // the prior frame's bytes — a self-amplifying feedback loop that,
      // left alone, drives per-frame sizes past V8's ~512 MiB string
      // limit and crashes node-server with `ERR_STRING_TOO_LONG`. It
      // also starves the browser's own debugger UI (the classic
      // "debugger paused in another window" freeze) because the CDP
      // event stream fills up with self-referential noise instead of
      // the events DevTools actually needs.
      //
      // Peek at the raw bytes and skip the runaway event types once
      // they exceed a small sniffing threshold. Legitimate CDP payloads
      // we care about (screenshots, DOM snapshots, large tool results)
      // are never `Network.webSocketFrame*` messages, so filtering by
      // method is far safer than a blanket size cap that would also
      // drop genuine large events.
      const CDP_PROXY_INSPECT_BYTES = 256 * 1024;
      const CDP_PROXY_HARD_FRAME_CAP = 64 * 1024 * 1024;
      const loopEventPrefixes = [
        '{"method":"Network.webSocketFrameReceived"',
        '{"method":"Network.webSocketFrameSent"',
      ];

      /**
       * Normalise the `ws` library's polymorphic message payload into a
       * single Buffer we can safely peek at and forward. Without this,
       * a later `String(data)` would coerce an `ArrayBuffer` to
       * `"[object ArrayBuffer]"` and a `Buffer[]` to comma-joined
       * stringified fragments, corrupting the CDP frame.
       */
      const toBuffer = (data: unknown): Buffer => {
        if (Buffer.isBuffer(data)) return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data);
        if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
        // Rare fallback — string frames in text mode. Keep bytes faithful.
        return Buffer.from(String(data));
      };

      chromeWs.on('message', (data) => {
        const buf = toBuffer(data);
        const byteLen = buf.length;

        // Peek at the first 256 KiB only — enough to identify the event
        // type cheaply without stringifying the whole runaway buffer.
        const head = buf.subarray(0, CDP_PROXY_INSPECT_BYTES).toString();

        if (loopEventPrefixes.some((p) => head.startsWith(p))) {
          const msg = `[cdp-proxy] Dropping Chrome feedback-loop event (${byteLen} bytes, ${head.slice(1, 60)}…)`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
          return;
        }

        // Hard safety net — still refuse anything that would blow past
        // V8's string length limit (buf.toString throws ERR_STRING_TOO_LONG
        // for any frame larger than ~512 MiB).
        if (byteLen > CDP_PROXY_HARD_FRAME_CAP) {
          const msg = `[cdp-proxy] Dropping oversized Chrome→Client frame (${byteLen} bytes)`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
          return;
        }

        const str = buf.toString();
        const preview = str.slice(0, 200);
        const msg = `[cdp-proxy] Chrome→Client: ${preview}`;
        if (cdpDedup.shouldLog(msg)) console.debug(msg);
        // Sniff Target.attachedToTarget / targetInfoChanged / Page.frameNavigated
        // so the Client→Chrome unmask gate can resolve per-session hostnames.
        cdpSessionUrls.observeChromeToClient(str);
        if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
          activeClientWs.send(str);
        }
      });

      chromeWs.on('close', (code, reason) => {
        console.log(`[cdp-proxy] Chrome WS closed. code=${code}, reason=${String(reason)}`);
        chromeWs = null;
      });

      chromeWs.on('error', (err) => {
        console.log(`[cdp-proxy] Chrome WS error: ${err}`);
        chromeWs = null;
        reject(err);
      });
    });
  }

  wss.on('connection', async (clientWs) => {
    try {
      // Close previous client connection — only one client active at a time
      if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
        console.log('[cdp-proxy] Closing previous client connection');
        activeClientWs.close();
      }
      activeClientWs = clientWs;

      console.log('[cdp-proxy] New client connected');

      // Initialize buffer BEFORE any await so messages arriving during
      // waitForCDP or ensureChromeConnection are captured, not dropped.
      if (messageBuffer === null) {
        messageBuffer = [];
      }

      // Register ALL handlers BEFORE any async work so no messages are lost
      clientWs.on('message', (data) => {
        const original = String(data);
        const preview = original.slice(0, 200);
        if (chromeWs && chromeWs.readyState === WebSocket.OPEN && messageBuffer === null) {
          const msg = `[cdp-proxy] Client→Chrome: ${preview}`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
          const { output } = applyCdpUnmask(original, {
            tracker: cdpSessionUrls,
            pipeline: secretProxy.rawPipeline,
          });
          chromeWs.send(output);
        } else if (messageBuffer !== null) {
          // Buffer the ORIGINAL bytes; unmask runs on flush so the
          // hostname tracker reflects the state at send time.
          messageBuffer.push(data);
          const msg = `[cdp-proxy] Client→Chrome (buffered): ${preview}`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
        } else {
          // Chrome not connected and no buffer — this shouldn't happen but log it
          console.log(`[cdp-proxy] Client→Chrome (DROPPED — no connection): ${preview}`);
        }
      });

      clientWs.on('close', () => {
        console.log('[cdp-proxy] Client disconnected');
        if (activeClientWs === clientWs) {
          activeClientWs = null;
        }
        // Don't close chromeWs — keep it alive for the next client
      });

      clientWs.on('error', (err) => {
        console.log(`[cdp-proxy] Client WS error: ${err}`);
        if (activeClientWs === clientWs) {
          activeClientWs = null;
        }
      });

      // NOW do async work — messages arriving during these awaits are buffered
      if (!cdpUrl) {
        cdpUrl = await waitForCDP(CDP_PORT);
        console.log(`[cdp-proxy] CDP available at: ${cdpUrl}`);
      }

      await ensureChromeConnection(cdpUrl);
    } catch (err) {
      console.error('[cdp-proxy] Connection error:', err);
      clientWs.close();
    }
  });

  server.listen(SERVE_PORT, '127.0.0.1', () => {
    console.log(`Serving UI at ${SERVE_ORIGIN}`);
    console.log(`CDP proxy at ws://localhost:${SERVE_PORT}/cdp`);
    fileLogger.log('info', 'CLI server started', {
      port: SERVE_PORT,
      cdpPort: CDP_PORT,
      devMode: DEV_MODE,
      electronMode: ELECTRON_MODE,
    });

    // Pre-connect to Chrome's CDP so the proxy is warm when the first client connects.
    // Without this, the first browser automation command has to wait for CDP discovery + WS handshake.
    (async () => {
      try {
        cdpUrl = await waitForCDP(CDP_PORT);
        console.log(`[cdp-proxy] Pre-connected: CDP available at ${cdpUrl}`);
        await ensureChromeConnection(cdpUrl);
        console.log('[cdp-proxy] Chrome WebSocket ready (pre-warmed)');

        // Register leader-restart endpoint now that CDP is ready (hosted mode only)
        if (RUNTIME_FLAGS.hosted) {
          registerLeaderRestartEndpoint(app, {
            cdp: createHttpCdp(CDP_PORT),
            localUrlPrefix: `http://localhost:${SERVE_PORT}/`,
          });
          console.log('[hosted] /api/leader-restart endpoint registered');
        }
      } catch (err) {
        console.log('[cdp-proxy] Pre-connect failed (will retry on first client):', err);
      }
    })();

    if (ELECTRON_MODE) {
      void (async () => {
        try {
          overlayInjector = await ElectronOverlayInjector.create({
            cdpPort: CDP_PORT,
            servePort: SERVE_PORT,
            dev: DEV_MODE,
            projectRoot: PROJECT_ROOT,
          });
          await overlayInjector.start();
          console.log('[electron-float] Overlay injector is watching Electron page targets');
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[electron-float] Failed to start overlay injector:', message);
        }
      })();
    }

    if (!ELECTRON_MODE) {
      setTimeout(() => {
        attachConsoleForwarder(CDP_PORT, String(SERVE_PORT)).catch((err) => {
          console.error('[page] Console forwarder error:', err);
        });
      }, 2500);
    }
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
