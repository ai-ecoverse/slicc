import { promises as fs } from 'node:fs';
import { isLoopbackHostname } from '@slicc/shared-ts';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

/** e2b sandboxes poll this path. A host with several leaders sets `SLICC_JOIN_FILE`. */
export const DEFAULT_JOIN_FILE_PATH = '/tmp/slicc-join.json';

/**
 * Join file for `POST /api/cloud-status`. `SLICC_JOIN_FILE` wins so each
 * leader on one host writes its own file; unset keeps the sandbox default.
 */
export function resolveJoinFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SLICC_JOIN_FILE?.trim();
  return configured || DEFAULT_JOIN_FILE_PATH;
}

/**
 * Sibling of the join file for a leader that could not mint a tray (#4112).
 * start-leader polls it so a failed boot reports the cause, not a timeout.
 * A separate file keeps the join file's `joinUrl` contract untouched.
 */
export function joinErrorFilePath(joinFilePath: string): string {
  return `${joinFilePath}.error.json`;
}

/** Longest error string persisted; the webapp's messages are far shorter. */
const MAX_ERROR_LENGTH = 2000;

export interface CloudStatusEndpointOptions {
  joinFilePath: string;
}

/** Join info accepted by POST /api/cloud-status and persisted to the join file. */
export interface CloudStatusPayload {
  joinUrl: string;
  trayId?: string;
  controllerUrl?: string;
  webhookUrl?: string;
  runtime?: string;
  sliccVersion?: string;
}

/** The optional string fields validated when present but never required. */
const OPTIONAL_STRING_FIELDS = [
  'trayId',
  'controllerUrl',
  'webhookUrl',
  'runtime',
  'sliccVersion',
] as const satisfies ReadonlyArray<keyof CloudStatusPayload>;

function isCloudStatusPayload(x: unknown): x is CloudStatusPayload {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Partial<Record<keyof CloudStatusPayload, unknown>>;
  if (typeof p.joinUrl !== 'string' || p.joinUrl.length === 0) return false;
  // Optional fields: validate type if present, but don't require.
  for (const key of OPTIONAL_STRING_FIELDS) {
    if (key in p && typeof p[key] !== 'string') return false;
  }
  return true;
}

/**
 * Reject non-loopback requests. The sandbox is a private execution boundary,
 * but defense in depth: someone might wire a port-forward and we want this
 * endpoint to be unreachable from the outside.
 *
 * Socket addresses may be IPv4-mapped IPv6 (`::ffff:127.0.0.1`); strip that
 * prefix then use the shared loopback hostname check.
 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? '';
  const normalized = addr.toLowerCase().startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  if (!isLoopbackHostname(normalized)) {
    res.status(403).json({ error: 'localhost only' });
    return;
  }
  next();
}

export function registerCloudStatusEndpoint(
  app: Express,
  options: CloudStatusEndpointOptions
): void {
  app.post('/api/cloud-status', requireLoopback, express.json(), async (req, res) => {
    if (!isCloudStatusPayload(req.body)) {
      res.status(400).json({ error: 'invalid cloud-status payload' });
      return;
    }
    const body = req.body;
    const payload = {
      joinUrl: body.joinUrl,
      trayId: body.trayId ?? null,
      controllerUrl: body.controllerUrl ?? null,
      webhookUrl: body.webhookUrl ?? null,
      runtime: body.runtime ?? null,
      sliccVersion: body.sliccVersion ?? null,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(options.joinFilePath, JSON.stringify(payload, null, 2));
    await fs.rm(joinErrorFilePath(options.joinFilePath), { force: true });
    res.json({ ok: true });
  });

  app.post('/api/cloud-status/error', requireLoopback, express.json(), async (req, res) => {
    const body = req.body as { error?: unknown; sliccVersion?: unknown } | undefined;
    if (typeof body?.error !== 'string' || body.error.length === 0) {
      res.status(400).json({ error: 'invalid cloud-status error payload' });
      return;
    }
    const error = body.error.slice(0, MAX_ERROR_LENGTH);
    // stdout is the leader log; the line names the cause even without the file.
    console.error(`[cloud-status] leader failed to mint a tray: ${error}`);
    const payload = {
      error,
      sliccVersion: typeof body.sliccVersion === 'string' ? body.sliccVersion : null,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(joinErrorFilePath(options.joinFilePath), JSON.stringify(payload, null, 2));
    res.json({ ok: true });
  });
}
