import { promises as fs } from 'node:fs';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

export interface CloudStatusEndpointOptions {
  joinFilePath: string;
}

function isCloudStatusPayload(x: unknown): x is {
  joinUrl: string;
  trayId?: string;
  controllerUrl?: string;
  webhookUrl?: string;
  runtime?: string;
  sliccVersion?: string;
} {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  if (typeof p.joinUrl !== 'string' || p.joinUrl.length === 0) return false;
  // Optional fields: validate type if present, but don't require.
  for (const key of ['trayId', 'controllerUrl', 'webhookUrl', 'runtime', 'sliccVersion']) {
    if (key in p && typeof p[key] !== 'string') return false;
  }
  return true;
}

/**
 * Reject non-loopback requests. The sandbox is a private execution boundary,
 * but defense in depth: someone might wire a port-forward and we want this
 * endpoint to be unreachable from the outside.
 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? '';
  const isLoopback =
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
  if (!isLoopback) {
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
