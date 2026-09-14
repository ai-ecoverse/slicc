import { promises as fs } from 'node:fs';
import { isLoopbackHostname } from '@slicc/shared-ts';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

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
    res.json({ ok: true });
  });
}
