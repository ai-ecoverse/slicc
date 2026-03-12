import { createServer } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ElectronAppAlreadyRunningError,
  ElectronOverlayInjector,
  launchElectronApp,
} from './electron-controller.js';
import { parseCliRuntimeFlags } from './runtime-flags.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME_FLAGS = parseCliRuntimeFlags(process.argv.slice(2));
const DEV_MODE = RUNTIME_FLAGS.dev;
const SERVE_ONLY = RUNTIME_FLAGS.serveOnly;
const ELECTRON_MODE = RUNTIME_FLAGS.electron;
const ELECTRON_APP = RUNTIME_FLAGS.electronApp;
const KILL_EXISTING_ELECTRON_APP = RUNTIME_FLAGS.kill;

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
// Chrome finder — checks common install paths per platform
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  const envPath = process.env['CHROME_PATH'];
  if (envPath && existsSync(envPath)) return envPath;

  const candidates: Record<string, string[]> = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    win32: [
      `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
  };

  const platform = process.platform;
  const paths = candidates[platform] ?? [];

  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CDP helper — wait for the DevTools WebSocket endpoint to become available
// ---------------------------------------------------------------------------

async function waitForCDP(
  port: number,
  retries = 30,
  delayMs = 500,
): Promise<string> {
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
  properties: Array<{ name: string; type: string; value: string; subtype?: string }>,
): string {
  return properties.map((p) => {
    let val: string;
    if (p.type === 'object') val = p.subtype === 'array' ? '[...]' : '{...}';
    else if (p.type === 'string') val = `"${p.value}"`;
    else val = p.value;
    return `${p.name}: ${val}`;
  }).join(', ');
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
    case 'error': return ANSI_RED;
    case 'warning': return ANSI_YELLOW;
    default: return ANSI_CYAN;
  }
}

async function findPageTarget(
  cdpPort: number,
  pageUrl: string,
): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = (await res.json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const match = targets.find(
      (t) => t.type === 'page' && t.url.includes(`localhost:${pageUrl}`) && t.webSocketDebuggerUrl,
    );
    return match ? { webSocketDebuggerUrl: match.webSocketDebuggerUrl! } : null;
  } catch {
    return null;
  }
}

async function attachConsoleForwarder(
  cdpPort: number,
  pageUrl: string,
): Promise<void> {
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
          console.log(`${color}[page:${type}]${ANSI_RESET} ${argsStr}`);
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
                `${ANSI_RED}    at ${fn} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})${ANSI_RESET}`,
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
      setTimeout(() => { connect(); }, 1000);
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

const CDP_PORT = RUNTIME_FLAGS.cdpPort;
const SERVE_PORT = parseInt(process.env['PORT'] ?? '3000', 10);

async function main() {
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

  // 1. Launch Chrome unless an external CDP provider is already running.
  if (ELECTRON_MODE && !SERVE_ONLY) {
    if (!ELECTRON_APP) {
      console.error('Electron mode requires an app path. Pass --electron <path> or --electron-app=<path>.');
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

      child.on('exit', (code) => {
        if (shuttingDown) return;
        console.log(`${displayName} exited with code ${code}`);
        process.exit(0);
      });

      await waitForCDP(CDP_PORT, 40, 500);
      console.log(`Connected to ${displayName} on CDP port ${CDP_PORT}`);
    } catch (error: unknown) {
      if (error instanceof ElectronAppAlreadyRunningError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  } else if (!SERVE_ONLY) {
    const chromePath = findChrome();
    if (!chromePath) {
      console.error(
        'Could not find Chrome/Chromium. Please install Chrome or set CHROME_PATH.',
      );
      process.exit(1);
    }
    console.log(`Found Chrome: ${chromePath}`);

    const chromeArgs = [
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(process.env['TMPDIR'] ?? '/tmp', 'browser-coding-agent-chrome')}`,
      `http://localhost:${SERVE_PORT}`,
    ];

    launchedBrowserProcess = spawn(chromePath, chromeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    launchedBrowserLabel = 'Chrome';

    pipeChildOutput(launchedBrowserProcess, 'chrome');

    launchedBrowserProcess.on('exit', (code) => {
      if (shuttingDown) return;
      console.log(`Chrome exited with code ${code}`);
      process.exit(0);
    });
  }

  // 3. Set up express app with request logging
  const app = express();
  app.use(requestLogger);

  // ---------------------------------------------------------------------------
  // Lick system — WebSocket bridge for webhooks/crontasks (all logic in browser)
  // ---------------------------------------------------------------------------
  
  // WebSocket for bidirectional communication with browser
  const lickWss = new WebSocketServer({ noServer: true });
  const lickClients = new Set<WebSocket>();
  const pendingRequests = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  let requestIdCounter = 0;

  lickWss.on('connection', (ws) => {
    lickClients.add(ws);
    console.log('[licks] Browser client connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; requestId?: string; [key: string]: unknown };
        
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
      const msg = JSON.stringify({ type, requestId, ...data as object });

      // Find a connected client
      const client = Array.from(lickClients).find(c => c.readyState === WebSocket.OPEN);
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

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/runtime-config', (_req, res) => {
    res.json({
      trayWorkerBaseUrl: process.env['WORKER_BASE_URL'] ?? null,
    });
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
      const data = await sendLickRequest('delete_webhook', { id: req.params.id }) as { ok?: boolean; error?: string };
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
      res.status(msg.includes('Invalid') || msg.includes('required') ? 400 : 503).json({ error: msg });
    }
  });

  app.delete('/api/crontasks/:id', async (req, res) => {
    try {
      const data = await sendLickRequest('delete_crontask', { id: req.params.id }) as { ok?: boolean; error?: string };
      if (data.error) {
        res.status(404).json({ error: data.error });
      } else {
        res.json(data);
      }
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Browser not connected' });
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
      const skipHeaders = new Set(['host', 'connection', 'x-target-url', 'content-length', 'transfer-encoding']);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!skipHeaders.has(key) && typeof value === 'string') {
          headers[key] = value;
        }
      }
      if (Object.keys(headers).length > 0) fetchInit.headers = headers;
      if (rawBody.length > 0 && !['GET', 'HEAD'].includes(req.method)) {
        fetchInit.body = rawBody;
      }

      const upstream = await fetch(targetUrl, fetchInit);

      // Forward status, prevent browser caching of proxy responses
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'no-store, no-cache');

      // Forward response headers
      upstream.headers.forEach((v, k) => {
        const lower = k.toLowerCase();
        if (lower !== 'transfer-encoding' && lower !== 'content-encoding') {
          res.setHeader(k, v);
        }
      });

      // Send body as raw binary - explicitly set content-length and use end() 
      // instead of send() to avoid any Express middleware transformations
      const body = await upstream.arrayBuffer();
      const buffer = Buffer.from(body);
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
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          port: 24679, // Use a separate port for HMR WebSocket to avoid conflicting with /cdp
        },
      },
      root: process.cwd(),
    });
    app.use(vite.middlewares);
    console.log('Vite dev server middleware attached (HMR active on port 24679)');
  } else {
    // Production mode: serve built static files
    const uiDir = resolve(__dirname, '..', 'ui');
    app.use(express.static(uiDir));

    // SPA fallback — serve index.html for all non-file routes
    app.get('*', (_req, res) => {
      res.sendFile(join(uiDir, 'index.html'));
    });
  }

  // 4. CDP WebSocket proxy at /cdp
  //    Use noServer mode so Vite's dev middleware doesn't intercept the upgrade.
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

  // Ensure everything is cleaned up when CLI exits
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');

    overlayInjector?.stop();
    overlayInjector = null;

    // Close the shared Chrome WebSocket and all client connections
    if (chromeWs) {
      try { chromeWs.close(); } catch { /* ignore */ }
      chromeWs = null;
    }
    if (activeClientWs) {
      try { activeClientWs.close(); } catch { /* ignore */ }
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
      launchedBrowserProcess.on('exit', () => { browserExited = true; });

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
        } catch { /* ignore */ }
      }

      console.log(`${launchedBrowserLabel} closed`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { gracefulShutdown(); });
  process.on('SIGTERM', () => { gracefulShutdown(); });
  process.on('exit', () => {
    // Synchronous last-resort cleanup — kill the launched browser if it is still running.
    if (!shuttingDown && launchedBrowserProcess) {
      try { launchedBrowserProcess.kill(); } catch { /* ignore */ }
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
        try { chromeWs.close(); } catch { /* ignore */ }
      }

      messageBuffer = [];
      chromeWs = new WebSocket(url);

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

      chromeWs.on('message', (data) => {
        const preview = String(data).slice(0, 200);
        console.log(`[cdp-proxy] Chrome→Client: ${preview}`);
        if (activeClientWs && activeClientWs.readyState === WebSocket.OPEN) {
          activeClientWs.send(String(data));
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
          console.log(`[cdp-proxy] Client→Chrome: ${preview}`);
          chromeWs.send(String(data));
        } else if (messageBuffer !== null) {
          messageBuffer.push(data);
          console.log(`[cdp-proxy] Client→Chrome (buffered): ${preview}`);
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

  server.listen(SERVE_PORT, () => {
    console.log(`Serving UI at http://localhost:${SERVE_PORT}`);
    console.log(`CDP proxy at ws://localhost:${SERVE_PORT}/cdp`);

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
            projectRoot: resolve(__dirname, '..', '..'),
          });
          await overlayInjector.start();
          console.log('[electron-float] Overlay injector is watching Electron page targets');
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[electron-float] Failed to start overlay injector:', message);
        }
      })();
    }

    if (!ELECTRON_MODE && launchedBrowserProcess) {
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
  process.exit(1);
});
