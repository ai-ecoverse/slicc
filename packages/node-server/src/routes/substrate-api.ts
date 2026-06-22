/**
 * Substrate API — POST /api/shell/exec + GET /api/shell/session/:id
 *
 * Non-streaming and chunked-NDJSON streaming shell command execution and
 * session status probe for external orchestrators (e.g. Claude Code running
 * `npm run substrate`). Forwards requests to the connected browser over the
 * lick bridge. Standalone-only; the extension float has no node-server.
 *
 * Parity: N/A — extension has no node-server / substrate is standalone-only (spec §11)
 */
// tva
import type { Express, Response } from 'express';
import type { LickBridge } from './lick-bridge.js';

/** Default exec timeout: 10 minutes. Callers may override via body.timeoutMs. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 600 000 ms

/**
 * Shared bridge-error → HTTP status mapper. Used by every route that forwards
 * to the lick bridge so the mapping is defined in exactly one place.
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
  cwd: unknown,
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
      { sessionId, command, cwd },
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

export function registerSubstrateApiRoutes(
  app: Express,
  bridge: Pick<LickBridge, 'sendLickRequest' | 'sendLickStream'>
): void {
  /**
   * POST /api/shell/exec
   *
   * Headers:
   *   X-Slicc-Session  — required; identifies the SLICC session.
   *
   * Body (JSON):
   *   command   string   required  Shell command to execute.
   *   cwd       string   optional  Working directory for the command.
   *   timeoutMs number   optional  Per-call timeout in ms (default 10 min).
   *   stream    boolean  optional  If true, responds with chunked NDJSON.
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
    const { command, cwd, timeoutMs, stream } = (req.body ?? {}) as {
      command?: unknown;
      cwd?: unknown;
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
      await streamExecResponse(res, bridge, sessionId, command, cwd, timeout);
      return;
    }

    try {
      const data = await bridge.sendLickRequest('shell-exec', { sessionId, command, cwd }, timeout);
      res.json(data);
    } catch (err) {
      respondBridgeError(res, err);
    }
  });

  /**
   * GET /api/shell/session/:id
   *
   * Quick probe (default 5s timeout) to check whether a substrate shell
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
}
