import { createServer } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEV_MODE = process.argv.includes('--dev');

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

const CDP_PORT = 9222;
const SERVE_PORT = parseInt(process.env['PORT'] ?? '3000', 10);

async function main() {
  if (DEV_MODE) {
    console.log('Starting in dev mode (Vite HMR enabled)');
  }

  // 1. Find Chrome
  const chromePath = findChrome();
  if (!chromePath) {
    console.error(
      'Could not find Chrome/Chromium. Please install Chrome or set CHROME_PATH.',
    );
    process.exit(1);
  }
  console.log(`Found Chrome: ${chromePath}`);

  // 2. Launch Chrome with remote debugging — forward stdout/stderr
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${join(process.env['TMPDIR'] ?? '/tmp', 'browser-coding-agent-chrome')}`,
    `http://localhost:${SERVE_PORT}`,
  ];

  const chrome: ChildProcess = spawn(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Forward Chrome's stdout/stderr so we can see console output and errors
  chrome.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[chrome:out] ${data}`);
  });
  chrome.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[chrome:err] ${data}`);
  });

  chrome.on('exit', (code) => {
    console.log(`Chrome exited with code ${code}`);
    process.exit(0);
  });

  // 3. Set up express app with request logging
  const app = express();
  app.use(requestLogger);

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
    }
    // For non-/cdp paths, do nothing — let Vite handle HMR upgrades
  });

  // Ensure everything is cleaned up when CLI exits
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');

    // Close all WebSocket proxy connections
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();

    // Stop accepting new HTTP connections
    server.close();

    // Try to close Chrome gracefully via CDP Browser.close
    let chromeExited = false;
    chrome.on('exit', () => { chromeExited = true; });

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
      // CDP not available — Chrome may still be starting up; fall through to kill
    }

    // Wait up to 3 seconds for Chrome to exit, then force-kill
    const deadline = Date.now() + 3000;
    while (!chromeExited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!chromeExited) {
      try {
        chrome.kill('SIGKILL');
      } catch { /* ignore */ }
    }

    console.log('Chrome closed');
    process.exit(0);
  };

  process.on('SIGINT', () => { gracefulShutdown(); });
  process.on('SIGTERM', () => { gracefulShutdown(); });
  process.on('exit', () => {
    // Synchronous last-resort cleanup — kill Chrome if still running
    if (!shuttingDown) {
      try { chrome.kill(); } catch { /* ignore */ }
    }
  });

  // Wait for CDP to be ready before accepting proxy connections
  let cdpUrl: string | null = null;

  wss.on('connection', async (clientWs) => {
    try {
      if (!cdpUrl) {
        cdpUrl = await waitForCDP(CDP_PORT);
        console.log(`[cdp-proxy] CDP available at: ${cdpUrl}`);
      }

      console.log(`[cdp-proxy] Client connected. cdpUrl=${cdpUrl}, existing chromeWs=none (creating new)`);

      // Connect to Chrome's CDP WebSocket
      const chromeWs = new WebSocket(cdpUrl);

      console.log(`[cdp-proxy] Opening chromeWs to ${cdpUrl}, readyState=${chromeWs.readyState}`);

      // Buffer messages from the client while chromeWs is still connecting.
      // Once connected, messageBuffer is set to null to switch to direct relay.
      let messageBuffer: unknown[] | null = [];

      chromeWs.on('open', () => {
        const bufferedCount = messageBuffer ? messageBuffer.length : 0;
        console.log(`[cdp-proxy] chromeWs open. readyState=${chromeWs.readyState}, flushing ${bufferedCount} buffered messages`);
        // Flush all buffered messages
        if (messageBuffer) {
          for (const msg of messageBuffer) {
            chromeWs.send(msg as Parameters<typeof chromeWs.send>[0]);
          }
          messageBuffer = null;
        }
      });

      // Relay messages in both directions
      clientWs.on('message', (data) => {
        const preview = String(data).slice(0, 200);
        if (messageBuffer !== null) {
          messageBuffer.push(data);
          console.log(`[cdp-proxy] Client→Chrome (buffered, bufLen=${messageBuffer.length}): ${preview}`);
        } else {
          console.log(`[cdp-proxy] Client→Chrome (direct, chromeWs.readyState=${chromeWs.readyState}): ${preview}`);
          chromeWs.send(data);
        }
      });

      chromeWs.on('message', (data) => {
        const preview = String(data).slice(0, 200);
        console.log(`[cdp-proxy] Chrome→Client (clientWs.readyState=${clientWs.readyState}): ${preview}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      });

      // Handle disconnections
      clientWs.on('close', () => {
        console.log(`[cdp-proxy] Client WS closed. chromeWs.readyState=${chromeWs.readyState}`);
        chromeWs.close();
      });

      chromeWs.on('close', (code, reason) => {
        console.log(`[cdp-proxy] Chrome WS closed. code=${code}, reason=${String(reason)}, clientWs.readyState=${clientWs.readyState}`);
        clientWs.close();
      });

      clientWs.on('error', (err) => {
        console.log(`[cdp-proxy] Client WS error: ${err}`);
        chromeWs.close();
      });
      chromeWs.on('error', (err) => {
        console.log(`[cdp-proxy] Chrome WS error: ${err}, readyState=${chromeWs.readyState}`);
        clientWs.close();
      });
    } catch (err) {
      console.error('[cdp-proxy] Connection error:', err);
      clientWs.close();
    }
  });

  server.listen(SERVE_PORT, () => {
    console.log(`Serving UI at http://localhost:${SERVE_PORT}`);
    console.log(`CDP proxy at ws://localhost:${SERVE_PORT}/cdp`);

    // Attach console forwarder after a delay to let Chrome load the page
    setTimeout(() => {
      attachConsoleForwarder(CDP_PORT, String(SERVE_PORT)).catch((err) => {
        console.error('[page] Console forwarder error:', err);
      });
    }, 2500);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
