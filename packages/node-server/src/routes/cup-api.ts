/**
 * Cup API — shell exec, session probe, and VFS routes.
 *
 * Routes:
 *   POST /api/shell/exec          — non-streaming or NDJSON-streaming shell exec
 *   GET  /api/shell/session/:id   — session status probe
 *   GET  /api/vfs/read            — read a VFS file (?path=&encoding=)
 *   POST /api/vfs/write           — write a VFS file ({path, content, encoding?})
 *   GET  /api/vfs/stat            — stat a VFS path (?path=)
 *   POST /api/vfs/list            — list a VFS directory ({path})
 *   GET  /api/targets             — list all browser targets (PageInfo[])
 *   POST /api/lick/emit           — inject a lick event ({type, data})
 *
 * All routes forward to the connected browser via the lick bridge.
 * Standalone-only; the extension float has no node-server.
 *
 * Parity: N/A — extension has no node-server / cup is standalone-only (spec §11)
 */
// tva
import type { Express, Response } from 'express';
import type { LickBridge } from './lick-bridge.js';

/** Default exec timeout: 10 minutes. Callers may override via body.timeoutMs. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 600 000 ms

/**
 * Shared bridge-error → HTTP status mapper for exec routes.
 * Unknown errors map to 500 (server-side fault).
 */
function respondBridgeError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'Request timeout') {
    res.status(504).json({ error: msg });
  } else if (msg === 'No browser connected') {
    res.status(503).json({ error: msg });
  } else {
    res.status(500).json({ error: msg });
  }
}

/**
 * VFS / lick bridge-error → HTTP status mapper.
 * Maps unknown errors to 400 (path errors and bad lick payloads are client errors,
 * not server faults).
 */
function respondClientBridgeError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT')) {
    res.status(404).json({ error: msg });
  } else if (msg === 'No browser connected') {
    res.status(503).json({ error: msg });
  } else if (msg === 'Request timeout') {
    res.status(504).json({ error: msg });
  } else {
    res.status(400).json({ error: msg });
  }
}

/**
 * Route path prefixes the cup steering API owns. The Host-header guard
 * (DNS-rebinding defense) is scoped to exactly these so it never interferes
 * with the rest of the node-server `/api` surface.
 */
const CUP_ROUTE_PREFIXES = ['/api/shell', '/api/vfs', '/api/targets', '/api/lick'];

/**
 * True iff a request `Host` header names a loopback host (`localhost`,
 * `127.0.0.1`, or `[::1]`), with or without a `:port`. This is the
 * DNS-rebinding defense: a malicious page that rebinds its hostname to
 * `127.0.0.1` can reach the loopback-bound server with a *same-origin*
 * request (no preflight, no Origin restriction), so the only thing that
 * distinguishes it from a genuine local caller is the `Host` header it
 * sends — a rebound request carries `Host: attacker.example` rather than
 * `Host: localhost`. A missing Host (malformed under HTTP/1.1) is rejected.
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  let hostname: string;
  if (host.startsWith('[')) {
    // Bracketed IPv6: `[::1]` or `[::1]:5710`.
    const close = host.indexOf(']');
    hostname = close === -1 ? host : host.slice(1, close);
  } else {
    // `host` or `host:port`. A bare IPv6 literal (e.g. `::1`) has multiple
    // colons and never carries a port unbracketed, so only strip a port when
    // there is exactly one colon.
    const parts = host.split(':');
    hostname = parts.length === 2 ? parts[0]! : host;
  }
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/** VFS encodings the bridge understands. */
const VALID_VFS_ENCODINGS = new Set(['utf-8', 'base64']);

/**
 * True if `encoding` is present but not one of the supported VFS encodings.
 * `undefined` (omitted — the browser defaults to utf-8) is valid; anything
 * else (junk string, repeated query param array, object) is rejected at the
 * edge with a clean 400 rather than forwarded to the browser to fail opaquely.
 */
function isInvalidVfsEncoding(encoding: unknown): boolean {
  if (encoding === undefined) return false;
  return typeof encoding !== 'string' || !VALID_VFS_ENCODINGS.has(encoding);
}

/**
 * Handles the streaming branch of POST /api/shell/exec (stream:true).
 *
 * Uses lazy header flush: only commits 200 + NDJSON headers on the first
 * frame, so a pre-stream reject (e.g. 'No browser connected') still maps
 * to a real 503/504/500 status code via respondBridgeError.
 *
 * Client-disconnect guard: if the client disconnects mid-stream we stop
 * writing to the dead socket. The browser-side exec keeps running and is
 * reclaimable via `ps`/`kill` + the session tail buffer (phase-1 behavior,
 * consistent with sendLickRequest).
 */
async function streamExecResponse(
  res: Response,
  bridge: Pick<LickBridge, 'sendLickStream'>,
  sessionId: string,
  command: string,
  timeout: number
): Promise<void> {
  let started = false;
  let clientGone = false;

  // 'close' on the *response* fires when the underlying socket closes before
  // the response is finished — i.e. the client actually disconnected mid-stream.
  // Do NOT use req.on('close') here: with Connection:close that fires as soon
  // as the client finishes sending the request body, well before we respond.
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  const begin = (): void => {
    if (!started) {
      started = true;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      // Close the TCP connection after res.end() so HTTP/1.1 fetch clients
      // don't wait indefinitely for more chunked data.
      res.setHeader('Connection', 'close');
      res.status(200);
    }
  };

  try {
    await bridge.sendLickStream(
      'shell-exec',
      { sessionId, command },
      (frame) => {
        if (clientGone) return;
        begin();
        res.write(`${JSON.stringify(frame)}\n`);
      },
      timeout
    );
    if (!clientGone) {
      begin(); // empty-stream edge: still commit headers
      res.end();
    }
  } catch (err) {
    if (clientGone) return;
    if (!started) {
      // Headers not sent yet — emit a proper status code
      respondBridgeError(res, err);
    } else {
      // Mid-stream failure (e.g. timeout) — write error line then end
      const msg = err instanceof Error ? err.message : String(err);
      res.write(`${JSON.stringify({ t: 'error', message: msg })}\n`);
      res.end();
    }
  }
}

export function registerCupApiRoutes(
  app: Express,
  bridge: Pick<LickBridge, 'sendLickRequest' | 'sendLickStream'>
): void {
  // DNS-rebinding guard: the cup routes run arbitrary shell on the host,
  // so reject any request to them whose `Host` header isn't loopback. The
  // 127.0.0.1 bind alone doesn't stop a rebound hostname from issuing a
  // same-origin (preflight-free) request; the Host allowlist does. Scoped to
  // the cup paths so the rest of the `/api` surface is untouched.
  app.use((req, res, next) => {
    const guarded = CUP_ROUTE_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`));
    if (guarded && !isLoopbackHostHeader(req.headers.host)) {
      res.status(403).json({ error: 'cup API is loopback-only (non-loopback Host rejected)' });
      return;
    }
    next();
  });

  /**
   * POST /api/shell/exec
   *
   * Headers:
   *   X-Slicc-Session  — required; identifies the SLICC session.
   *
   * Body (JSON):
   *   command   string   required  Shell command to execute.
   *   timeoutMs number   optional  Per-call timeout in ms (default 10 min).
   *   stream    boolean  optional  If true, responds with chunked NDJSON.
   *
   * Working directory: the session's cwd persists across calls (spec §6).
   * To run in a specific directory use `cd /path && <command>`.
   *
   * Response 200 (non-stream):
   *   { stdout: string, stderr: string, exitCode: number, pid?: number }
   *
   * Response 200 (stream, Content-Type: application/x-ndjson):
   *   {"t":"stdout","d":"..."}\n
   *   {"t":"exit","code":0,"pid":123}\n
   *
   * Errors:
   *   400  — sessionId or command missing (bridge not called)
   *   503  — No browser connected
   *   504  — Request timeout
   *   500  — Any other bridge error
   *
   * Process control: `ps` and `kill <pid>` are ordinary shell-exec commands.
   * No special route is needed — they execute through the normal exec path.
   */
  app.post('/api/shell/exec', async (req, res) => {
    const sessionId = req.header('X-Slicc-Session');
    const { command, timeoutMs, stream } = (req.body ?? {}) as {
      command?: unknown;
      timeoutMs?: unknown;
      stream?: unknown;
    };

    if (!sessionId) {
      res.status(400).json({ error: 'X-Slicc-Session header is required' });
      return;
    }
    if (typeof command !== 'string' || command.trim() === '') {
      res.status(400).json({ error: '"command" body field is required' });
      return;
    }

    const timeout =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_EXEC_TIMEOUT_MS;

    if (stream === true) {
      await streamExecResponse(res, bridge, sessionId, command, timeout);
      return;
    }

    try {
      const data = await bridge.sendLickRequest('shell-exec', { sessionId, command }, timeout);
      res.json(data);
    } catch (err) {
      respondBridgeError(res, err);
    }
  });

  /**
   * GET /api/shell/session/:id
   *
   * Quick probe (default 5s timeout) to check whether a cup shell
   * session is alive and retrieve its current status.
   *
   * Response 200:
   *   { alive: boolean, cwd: string, runningPids: number[], bufferedTail: string }
   *
   * Errors:
   *   503  — No browser connected
   *   504  — Request timeout
   *   500  — Any other bridge error
   */
  app.get('/api/shell/session/:id', async (req, res) => {
    try {
      const data = await bridge.sendLickRequest('shell-session-status', {
        sessionId: req.params.id,
      });
      res.json(data);
    } catch (err) {
      respondBridgeError(res, err);
    }
  });

  /**
   * GET /api/vfs/read?path=&encoding=
   *
   * Query params:
   *   path      string  required  Absolute VFS path.
   *   encoding  string  optional  'utf-8' (default) or 'base64' for binary files.
   *
   * Response 200:
   *   { content: string, encoding: 'utf-8' | 'base64' }
   *
   * Errors: 400 path missing, 404 ENOENT, 503 no browser, 504 timeout, 400 other VFS error.
   */
  app.get('/api/vfs/read', async (req, res) => {
    const path = req.query.path;
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: '"path" query parameter is required' });
      return;
    }
    if (isInvalidVfsEncoding(req.query.encoding)) {
      res.status(400).json({ error: '"encoding" must be "utf-8" or "base64"' });
      return;
    }
    try {
      const data = await bridge.sendLickRequest('vfs-read', {
        path,
        encoding: req.query.encoding,
      });
      res.json(data);
    } catch (err) {
      respondClientBridgeError(res, err);
    }
  });

  /**
   * POST /api/vfs/write
   *
   * Body (JSON):
   *   path      string  required  Absolute VFS path.
   *   content   string  required  File content (plain string or base64).
   *   encoding  string  optional  'utf-8' (default) or 'base64'.
   *
   * Response 200:
   *   { ok: true }
   *
   * Errors: 400 path/content missing, 404 ENOENT, 503 no browser, 504 timeout, 400 other.
   */
  app.post('/api/vfs/write', async (req, res) => {
    const { path, content, encoding } = (req.body ?? {}) as {
      path?: unknown;
      content?: unknown;
      encoding?: unknown;
    };
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: '"path" body field is required' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: '"content" body field is required' });
      return;
    }
    if (isInvalidVfsEncoding(encoding)) {
      res.status(400).json({ error: '"encoding" must be "utf-8" or "base64"' });
      return;
    }
    try {
      const data = await bridge.sendLickRequest('vfs-write', { path, content, encoding });
      res.json(data);
    } catch (err) {
      respondClientBridgeError(res, err);
    }
  });

  /**
   * GET /api/vfs/stat?path=
   *
   * Response 200:
   *   { type: 'file' | 'directory', size: number, mtime: number }
   *
   * Errors: 400 path missing, 404 ENOENT, 503 no browser, 504 timeout, 400 other.
   */
  app.get('/api/vfs/stat', async (req, res) => {
    const path = req.query.path;
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: '"path" query parameter is required' });
      return;
    }
    try {
      const data = await bridge.sendLickRequest('vfs-stat', { path });
      res.json(data);
    } catch (err) {
      respondClientBridgeError(res, err);
    }
  });

  /**
   * POST /api/vfs/list
   *
   * Body (JSON):
   *   path  string  required  Absolute VFS directory path.
   *
   * Response 200:
   *   Array<{ name: string, type: 'file' | 'directory' | 'symlink' }>
   *
   * Errors: 400 path missing, 404 ENOENT, 503 no browser, 504 timeout, 400 other.
   */
  app.post('/api/vfs/list', async (req, res) => {
    const path = req.body?.path as unknown;
    if (!path || typeof path !== 'string') {
      res.status(400).json({ error: '"path" body field is required' });
      return;
    }
    try {
      const data = await bridge.sendLickRequest('vfs-list', { path });
      res.json(data);
    } catch (err) {
      respondClientBridgeError(res, err);
    }
  });

  /**
   * GET /api/targets
   *
   * Returns the list of all browser targets (local + federated fleet) as PageInfo[].
   *
   * Response 200: PageInfo[]
   * Errors: 503 no browser, 504 timeout, 500 other.
   */
  app.get('/api/targets', async (_req, res) => {
    try {
      res.json(await bridge.sendLickRequest('targets', {}));
    } catch (e) {
      respondBridgeError(res, e);
    }
  });

  /**
   * POST /api/lick/emit
   *
   * Injects a lick event into the webapp's LickManager.
   *
   * Body (JSON):
   *   type  string  required  Lick type ('navigate' or 'webhook').
   *   data  object  optional  Type-specific payload.
   *
   * Response 200: { ok: true }
   * Errors: 400 type missing / bad payload, 503 no browser, 504 timeout.
   *
   * Parity: N/A — standalone-only (spec §11)
   */
  app.post('/api/lick/emit', async (req, res) => {
    const { type, data } = (req.body ?? {}) as { type?: unknown; data?: unknown };
    if (typeof type !== 'string' || type === '') {
      res.status(400).json({ error: '"type" is required' });
      return;
    }
    try {
      // Forward the lick's type as `lickType` (NOT `type`): the bridge
      // serializes `{ type: 'lick-emit', requestId, ...payload }`, so a payload
      // `type` would clobber the request type and the webapp would dispatch on
      // the lick type ('navigate') → "Unknown request type". See
      // shell-bridge-handler.handleLickEmit.
      res.json(await bridge.sendLickRequest('lick-emit', { lickType: type, data }));
    } catch (e) {
      respondClientBridgeError(res, e);
    }
  });
}
