/**
 * Substrate API — POST /api/shell/exec + GET /api/shell/session/:id
 *
 * Non-streaming shell command execution and session status probe for external
 * orchestrators (e.g. Claude Code running `npm run substrate`). Forwards
 * requests to the connected browser over the lick bridge. Standalone-only;
 * the extension float has no node-server.
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

export function registerSubstrateApiRoutes(
  app: Express,
  bridge: Pick<LickBridge, 'sendLickRequest'>
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
   *
   * Response 200:
   *   { stdout: string, stderr: string, exitCode: number, pid?: number }
   *
   * Errors:
   *   400  — sessionId or command missing (bridge not called)
   *   503  — No browser connected
   *   504  — Request timeout
   *   500  — Any other bridge error
   */
  app.post('/api/shell/exec', async (req, res) => {
    const sessionId = req.header('X-Slicc-Session');
    const { command, cwd, timeoutMs } = (req.body ?? {}) as {
      command?: unknown;
      cwd?: unknown;
      timeoutMs?: unknown;
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
