import { promises as fs } from 'node:fs';
import { isLoopbackHostname } from '@slicc/shared-ts';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

export const DEFAULT_JOIN_FILE_PATH = '/tmp/slicc-join.json';

export function resolveJoinFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SLICC_JOIN_FILE?.trim();
  return configured || DEFAULT_JOIN_FILE_PATH;
}

export function joinErrorFilePath(joinFilePath: string): string {
  return `${joinFilePath}.error.json`;
}

export const MINT_FAILURE_LOG_PREFIX = '[cloud-status] leader failed to mint a tray: ';

const MAX_ERROR_LENGTH = 2000;

export interface CloudStatusEndpointOptions {
  joinFilePath: string;
}

export interface CloudStatusPayload {
  joinUrl: string;
  trayId?: string;
  controllerUrl?: string;
  webhookUrl?: string;
  runtime?: string;
  sliccVersion?: string;
}

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

  for (const key of OPTIONAL_STRING_FIELDS) {
    if (key in p && typeof p[key] !== 'string') return false;
  }
  return true;
}

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

    console.error(`${MINT_FAILURE_LOG_PREFIX}${error.replace(/\s+/g, ' ')}`);
    const payload = {
      error,
      sliccVersion: typeof body.sliccVersion === 'string' ? body.sliccVersion : null,
      updatedAt: new Date().toISOString(),
    };
    try {
      await fs.writeFile(joinErrorFilePath(options.joinFilePath), JSON.stringify(payload, null, 2));
    } catch (writeError) {
      console.error('[cloud-status] could not write the join error file', String(writeError));
      res.status(500).json({ error: 'could not record the leader failure' });
      return;
    }
    res.json({ ok: true });
  });
}
