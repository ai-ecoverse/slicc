#!/usr/bin/env node
import { createServer } from 'http';
import { createServer as createNetServer } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ElectronAppAlreadyRunningError,
  ElectronOverlayInjector,
  launchElectronApp,
} from './electron-controller.js';
import { getElectronAppPorts } from './electron-runtime.js';
import {
  buildChromeLaunchArgs,
  ensureQaProfileScaffold,
  findChromeExecutable,
  resolveChromeLaunchProfile,
  waitForCdpPortFromStderr,
} from './chrome-launch.js';
import { resolveCliBrowserLaunchUrl } from './launch-url.js';
import { parseCliRuntimeFlags } from './runtime-flags.js';
import { FileLogger } from './file-logger.js';
import { CliLogDedup } from './cli-log-dedup.js';
import { EnvSecretStore } from './secrets/env-secret-store.js';
import { SecretProxyManager } from './secrets/proxy-manager.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

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
      } catch (err) {
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
        return resolveChromeLaunchProfile({
          projectRoot: PROJECT_ROOT,
          tmpDir: process.env['TMPDIR'] ?? '/tmp',
          profile: RUNTIME_FLAGS.profile,
          servePort: SERVE_PORT,
        });
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      throw new Error('unreachable');
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
    });

    launchedBrowserProcess = spawn(chromePath, chromeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
    });
    launchedBrowserLabel = chromeProfile.displayName;

    // Parse the actual CDP port from Chrome's stderr before piping output.
    // Chrome prints "DevTools listening on ws://HOST:PORT/..." to stderr.
    const actualCdpPort = await waitForCdpPortFromStderr(launchedBrowserProcess);
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
  const secretProxy = new SecretProxyManager();
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

  // ---------------------------------------------------------------------------
  // Lick system — WebSocket bridge for webhooks/crontasks (all logic in browser)
  // ---------------------------------------------------------------------------

  // WebSocket for bidirectional communication with browser
  const lickWss = new WebSocketServer({ noServer: true });
  const lickClients = new Set<WebSocket>();
  const pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  let requestIdCounter = 0;

  lickWss.on('connection', (ws) => {
    lickClients.add(ws);
    console.log('[licks] Browser client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          requestId?: string;
          [key: string]: unknown;
        };

        // Handle responses to pending requests
        if (msg.type === 'response' && msg.requestId) {
          const pending = pendingRequests.get(msg.requestId);
          if (pending) {
            pendingRequests.delete(msg.requestId);
            if (msg.error) {
              pending.reject(new Error(msg.error as string));
            } else {
              pending.resolve(msg.data);
            }
          }
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      lickClients.delete(ws);
      console.log('[licks] Browser client disconnected');
    });
  });

  /** Send a request to the browser and wait for response */
  function sendLickRequest(type: string, data: unknown, timeout = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++requestIdCounter}`;
      const msg = JSON.stringify({ type, requestId, ...(data as object) });

      // Find a connected client
      const client = Array.from(lickClients).find((c) => c.readyState === WebSocket.OPEN);
      if (!client) {
        reject(new Error('No browser connected'));
        return;
      }

      // Set up timeout
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);

      pendingRequests.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      client.send(msg);
    });
  }

  /** Broadcast an event to all connected browsers (no response expected) */
  function broadcastLickEvent(event: unknown): void {
    const msg = JSON.stringify(event);
    for (const client of lickClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth callback — generic redirect target for OAuth providers (implicit + PKCE)
  // ---------------------------------------------------------------------------
  // Pending OAuth result for server-side relay (Electron overlay can't use window.opener)
  let pendingOAuthResult: { redirectUrl: string; error?: string } | null = null;

  app.get('/auth/callback', (_req: Request, res: Response) => {
    // The callback page tries window.opener.postMessage first (works in CLI popup mode).
    // If window.opener is null (Electron overlay — opens system browser), it falls back
    // to POSTing the result to /api/oauth-result for the UI to poll.
    res.send(`<!DOCTYPE html><html><body><script>
      var q = new URLSearchParams(location.search);
      var h = new URLSearchParams(location.hash.replace(/^#/, ''));
      var payload = {
        type: 'oauth-callback',
        redirectUrl: location.href,
        code: q.get('code'),
        state: q.get('state') || h.get('state'),
        error: q.get('error') || h.get('error'),
        access_token: h.get('access_token'),
        expires_in: h.get('expires_in'),
        token_type: h.get('token_type')
      };
      if (window.opener) {
        window.opener.postMessage(payload, '*');
      } else {
        fetch('/api/oauth-result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).catch(function(err) { console.error('[oauth-callback] Failed to relay result to server:', err); });
      }
      window.close();
    </script><p>Completing login... you can close this window.</p></body></html>`);
  });

  app.post('/api/oauth-result', express.json(), (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const redirectUrl = typeof body.redirectUrl === 'string' ? body.redirectUrl : '';
    if (!redirectUrl) {
      console.warn('[oauth-result] Received callback with empty redirectUrl');
    }
    pendingOAuthResult = {
      redirectUrl,
      error: typeof body.error === 'string' ? body.error : undefined,
    };
    res.json({ ok: true });
  });

  app.get('/api/oauth-result', (_req: Request, res: Response) => {
    if (pendingOAuthResult) {
      const result = pendingOAuthResult;
      pendingOAuthResult = null;
      res.json(result);
    } else {
      res.status(204).end();
    }
  });

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/runtime-config', (_req, res) => {
    res.json({
      trayWorkerBaseUrl:
        RUNTIME_FLAGS.leadWorkerBaseUrl ??
        (process.env['WORKER_BASE_URL']?.trim() || null) ??
        (DEV_MODE
          ? 'https://slicc-tray-hub-staging.minivelos.workers.dev'
          : 'https://www.sliccy.ai'),
      trayJoinUrl: discoveredTrayJoinUrl ?? null,
    });
  });

  // Tray status API — forwards to browser to get leader tray join info
  app.get('/api/tray-status', async (_req, res) => {
    try {
      const data = await sendLickRequest('tray_status', {});
      res.json(data);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
    }
  });

  // Webhook management API — forwards to browser
  app.get('/api/webhooks', async (_req, res) => {
    try {
      const data = await sendLickRequest('list_webhooks', {});
      res.json(data);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
    }
  });

  app.post('/api/webhooks', async (req, res) => {
    try {
      const data = await sendLickRequest('create_webhook', req.body);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg.includes('Invalid') ? 400 : 503).json({ error: msg });
    }
  });

  app.delete('/api/webhooks/:id', async (req, res) => {
    try {
      const data = (await sendLickRequest('delete_webhook', { id: req.params.id })) as {
        ok?: boolean;
        error?: string;
      };
      if (data.error) {
        res.status(404).json({ error: data.error });
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
    }
  });

  // Webhook receiver — handle CORS preflight
  app.options('/webhooks/:id', (_req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.sendStatus(204);
  });

  // Webhook receiver — forwards POST to browser for processing
  app.post('/webhooks/:id', async (req, res) => {
    res.set({ 'Access-Control-Allow-Origin': '*' });
    const { id } = req.params;

    // Collect body
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }

    // Forward to browser for processing
    broadcastLickEvent({
      type: 'webhook_event',
      webhookId: id,
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body,
    });

    res.json({ ok: true, received: true });
  });

  // Cron task management API — forwards to browser
  app.get('/api/crontasks', async (_req, res) => {
    try {
      const data = await sendLickRequest('list_crontasks', {});
      res.json(data);
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
    }
  });

  app.post('/api/crontasks', async (req, res) => {
    try {
      const data = await sendLickRequest('create_crontask', req.body);
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res
        .status(msg.includes('Invalid') || msg.includes('required') ? 400 : 503)
        .json({ error: msg });
    }
  });

  app.delete('/api/crontasks/:id', async (req, res) => {
    try {
      const data = (await sendLickRequest('delete_crontask', { id: req.params.id })) as {
        ok?: boolean;
        error?: string;
      };
      if (data.error) {
        res.status(404).json({ error: data.error });
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
    }
  });

  // Profile-independent handoff injection.
  //
  // The CDP navigation-watcher only sees tabs inside the Chrome instance
  // SLICC launched (isolated profile keyed by port); similarly the
  // extension's webRequest observer only fires inside the profile where it
  // is installed. External tools (e.g. the slicc-handoff helper) post here
  // so a handoff reaches the cone regardless of which browser profile the
  // user is currently driving.
  app.post('/api/handoff', (req, res) => {
    const payload = req.body as {
      sliccHeader?: unknown;
      url?: unknown;
      title?: unknown;
    };
    if (typeof payload?.sliccHeader !== 'string' || payload.sliccHeader.length === 0) {
      res.status(400).json({ error: 'sliccHeader is required (non-empty string)' });
      return;
    }
    broadcastLickEvent({
      type: 'navigate_event',
      sliccHeader: payload.sliccHeader,
      url:
        typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : 'about:handoff',
      title: typeof payload.title === 'string' ? payload.title : undefined,
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // Secret management API — direct .env file access (no browser needed)
  const secretStore = new EnvSecretStore(RUNTIME_FLAGS.envFile ?? undefined);

  app.get('/api/secrets', (_req, res) => {
    try {
      const entries = secretStore.list();
      res.json(entries);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to list secrets' });
    }
  });

  // Masked secrets endpoint — returns name + maskedValue pairs for shell env population.
  // The browser fetches this at shell init to populate env vars with masked values.
  // Real values are never exposed; only deterministic session-scoped masks.
  app.get('/api/secrets/masked', (_req, res) => {
    try {
      const entries = secretProxy.getMaskedEntries();
      res.json(entries);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to get masked secrets' });
    }
  });

  // Fetch proxy — forwards cross-origin requests from the browser to bypass CORS.
  // Used by just-bash's curl which calls the browser's fetch() API.
  // Note: express.json() may have already parsed the body, so we check req.body first.
  app.all('/api/fetch-proxy', async (req, res) => {
    // Get the body - either from express.json() parsed body or collect raw chunks
    let rawBody: Buffer;
    if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      // Body was already parsed by express.json() - re-serialize it
      rawBody = Buffer.from(JSON.stringify(req.body), 'utf-8');
    } else {
      // Collect raw body manually (for non-JSON content types)
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      rawBody = Buffer.concat(chunks);
    }
    const targetUrl = req.headers['x-target-url'] as string;
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing X-Target-URL header' });
      return;
    }
    try {
      const fetchInit: RequestInit = {
        method: req.method,
        redirect: 'follow', // Follow redirects for git protocol compatibility
      };
      // Forward relevant headers (excluding hop-by-hop and proxy headers)
      const skipHeaders = new Set([
        'host',
        'connection',
        'x-target-url',
        'content-length',
        'transfer-encoding',
        'x-proxy-cookie',
        'x-proxy-origin',
        'x-proxy-referer',
      ]);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key) && typeof value === 'string') {
          headers[key] = value;
        }
      }
      // Forbidden-header transport: browser cannot send Cookie via fetch(),
      // so the client encodes it as X-Proxy-Cookie. Restore it here.
      const proxyCookie = req.headers['x-proxy-cookie'];
      if (proxyCookie) {
        headers['cookie'] = Array.isArray(proxyCookie) ? proxyCookie[0] : proxyCookie;
      }

      // Helper: check if an origin/referer value is a localhost URL
      function isLocalhostOrigin(origin: string | undefined): boolean {
        if (!origin) return false;
        try {
          const url = new URL(origin);
          return (
            url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '::1' ||
            url.hostname === '[::1]'
          );
        } catch {
          return false;
        }
      }

      // Forbidden-header transport: restore X-Proxy-Origin → Origin
      const proxyOrigin = req.headers['x-proxy-origin'];
      if (proxyOrigin) {
        headers['origin'] = Array.isArray(proxyOrigin) ? proxyOrigin[0] : proxyOrigin;
      } else if (isLocalhostOrigin(headers['origin'] as string)) {
        // Only strip browser's auto-added localhost origin, preserve legitimate origins
        delete headers['origin'];
      }

      // Forbidden-header transport: restore X-Proxy-Referer → Referer
      const proxyReferer = req.headers['x-proxy-referer'];
      if (proxyReferer) {
        headers['referer'] = Array.isArray(proxyReferer) ? proxyReferer[0] : proxyReferer;
      } else if (isLocalhostOrigin(headers['referer'] as string)) {
        // Only strip browser's auto-added localhost referer, preserve legitimate referers
        delete headers['referer'];
      }

      // Restore any X-Proxy-Proxy-* transport headers as Proxy-* headers
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.startsWith('x-proxy-proxy-') && typeof value === 'string') {
          const restored = key.replace(/^x-proxy-/, '');
          headers[restored] = value;
          delete headers[key];
        }
      }
      // Always request uncompressed responses from upstream — the proxy doesn't
      // decompress, and the browser→proxy link is localhost (no benefit to compression).
      // Without this, Cloudflare may Brotli-compress the response, the proxy strips
      // Content-Encoding (line below), and the browser receives compressed garbage.
      headers['accept-encoding'] = 'identity';

      // --- Secret injection: unmask headers ---
      let targetHostname: string;
      try {
        targetHostname = new URL(targetUrl).hostname;
      } catch {
        targetHostname = '';
      }

      if (secretProxy.hasSecrets()) {
        // Unmask request headers (replace masked values with real, validate domain)
        const headerResult = secretProxy.unmaskHeaders(headers, targetHostname);
        if (headerResult.forbidden) {
          res.status(403).json({
            error: `Secret "${headerResult.forbidden.secretName}" is not allowed for domain "${headerResult.forbidden.hostname}"`,
          });
          return;
        }
      }

      if (Object.keys(headers).length > 0) fetchInit.headers = headers;
      if (rawBody.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
        // --- Secret injection: unmask request body ---
        // Body uses unmaskBody: domain mismatches leave the masked value as-is
        // (safe/meaningless) rather than rejecting. This avoids false 403s when
        // LLM conversation context contains masked secrets sent to non-matching
        // domains like Bedrock.
        if (secretProxy.hasSecrets()) {
          const bodyStr = rawBody.toString('utf-8');
          const bodyResult = secretProxy.unmaskBody(bodyStr, targetHostname);
          rawBody = Buffer.from(bodyResult.text, 'utf-8');
        }
        // Buffer extends Uint8Array which is a valid fetch body at runtime.
        fetchInit.body = rawBody as unknown as RequestInit['body'];
      }

      const upstream = await fetch(targetUrl, fetchInit);

      // Forward status, prevent browser caching of proxy responses
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'no-store, no-cache');

      // Forward response headers (strip www-authenticate to prevent
      // the browser from showing a native Basic Auth dialog — isomorphic-git
      // handles 401s through its own onAuth callback)
      // Forbidden-header transport: browser fetch() strips Set-Cookie from
      // responses. Collect all Set-Cookie values and encode as JSON in a
      // transport header the browser can read.
      const setCookieValues = upstream.headers.getSetCookie();
      upstream.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (
          lower !== 'transfer-encoding' &&
          lower !== 'content-encoding' &&
          lower !== 'www-authenticate' &&
          lower !== 'set-cookie' &&
          !lower.startsWith('x-proxy-')
        ) {
          // Scrub real secret values from response headers
          res.setHeader(k, secretProxy.scrubResponse(v));
        }
      });
      if (setCookieValues.length > 0) {
        res.setHeader(
          'X-Proxy-Set-Cookie',
          secretProxy.scrubResponse(JSON.stringify(setCookieValues))
        );
      }

      // Send body — scrub real secret values from response body (text-only)
      const body = await upstream.arrayBuffer();
      let buffer = Buffer.from(body);
      if (secretProxy.hasSecrets()) {
        const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
        const isText =
          ct.startsWith('text/') || ct.startsWith('application/json') || ct.includes('charset=');
        if (isText) {
          const scrubbed = secretProxy.scrubResponse(buffer.toString('utf-8'));
          buffer = Buffer.from(scrubbed, 'utf-8');
        }
      }
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `Proxy fetch failed: ${message}` });
    }
  });

  // Create the HTTP server BEFORE Vite so we can register our upgrade handler first
  const server = createServer(app);

  if (DEV_MODE) {
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
    const uiDir = resolve(__dirname, '..', 'ui');
    app.use(express.static(uiDir));

    // SPA fallback — serve index.html for all non-file routes
    app.get('/{*path}', (_req, res) => {
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

  function ensureChromeConnection(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (chromeWs && chromeWs.readyState === WebSocket.OPEN) {
        // Already connected — flush any buffered messages and go direct
        if (messageBuffer) {
          for (const msg of messageBuffer) {
            chromeWs.send(String(msg));
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
            chromeWs!.send(String(msg));
          }
          messageBuffer = null;
        }
        resolve();
      });

      // Drop frames larger than this upstream limit instead of forwarding
      // them. With `maxPayload: 0` the ws library no longer closes the
      // socket when Chrome's CDP feedback loop (see the constructor
      // comment above) blows past the default 100 MiB cap, but we still
      // have to stop the runaway before `String(data)` hits V8's ~512 MiB
      // maxStringLength and crashes the whole node-server process with
      // `ERR_STRING_TOO_LONG`. 16 MiB is generous for any legitimate CDP
      // event we care about (screenshots, DOM snapshots, large responses)
      // while cheaply cutting the runaway Network.webSocketFrame* chain.
      const CDP_PROXY_MAX_FRAME_BYTES = 16 * 1024 * 1024;

      chromeWs.on('message', (data) => {
        // Buffer | ArrayBuffer | Buffer[] — compute a conservative byte length
        // without stringifying (the runaway payload we're defending against
        // can easily exceed V8's string length limit).
        let byteLen: number;
        if (Buffer.isBuffer(data)) byteLen = data.length;
        else if (data instanceof ArrayBuffer) byteLen = data.byteLength;
        else if (Array.isArray(data)) byteLen = data.reduce((n, b) => n + b.length, 0);
        else byteLen = 0;

        if (byteLen > CDP_PROXY_MAX_FRAME_BYTES) {
          const msg = `[cdp-proxy] Dropping oversized Chrome→Client frame (${byteLen} bytes > ${CDP_PROXY_MAX_FRAME_BYTES})`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
          return;
        }

        const str = String(data);
        const preview = str.slice(0, 200);
        const msg = `[cdp-proxy] Chrome→Client: ${preview}`;
        if (cdpDedup.shouldLog(msg)) console.debug(msg);
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
        const preview = String(data).slice(0, 200);
        if (chromeWs && chromeWs.readyState === WebSocket.OPEN && messageBuffer === null) {
          const msg = `[cdp-proxy] Client→Chrome: ${preview}`;
          if (cdpDedup.shouldLog(msg)) console.debug(msg);
          chromeWs.send(String(data));
        } else if (messageBuffer !== null) {
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
