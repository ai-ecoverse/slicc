/**
 * Tests for POST /api/cloud-status endpoint (hosted-only, localhost guard).
 * The endpoint writes join info to a configured JSON file for the --cloud
 * CLI to read after sandbox creation.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerCloudStatusEndpoint, requireLoopback } from '../src/cloud-status.js';

/**
 * Start an HTTP server on port 0, make a request, return the response, and close the server.
 */
async function makeRequest(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const url = `http://127.0.0.1:${addr.port}${path}`;
    const options: RequestInit = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return await fetch(url, options);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('POST /api/cloud-status', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'slicc-cloud-status-'));
    tmpFile = join(tmpDir, 'slicc-join.json');
  });

  it('POST writes JSON payload to the configured path', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });

    const res = await makeRequest(app, 'POST', '/api/cloud-status', {
      joinUrl: 'https://example.com/join/abc',
      trayId: 't123',
      controllerUrl: 'wss://example.com/control',
      webhookUrl: 'https://example.com/webhook/w456',
      runtime: 'hosted',
      sliccVersion: '1.2.3',
    });

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { ok: boolean };
    expect(responseBody).toEqual({ ok: true });

    // Read the file and validate
    const fileContent = await fs.readFile(tmpFile, 'utf-8');
    const payload = JSON.parse(fileContent) as Record<string, unknown>;

    expect(payload.joinUrl).toBe('https://example.com/join/abc');
    expect(payload.trayId).toBe('t123');
    expect(payload.controllerUrl).toBe('wss://example.com/control');
    expect(payload.webhookUrl).toBe('https://example.com/webhook/w456');
    expect(payload.runtime).toBe('hosted');
    expect(payload.sliccVersion).toBe('1.2.3');
    expect(typeof payload.updatedAt).toBe('string');
    expect(new Date(payload.updatedAt as string).toISOString()).toBe(payload.updatedAt);
  });

  it('POST without joinUrl returns 400', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });

    const res = await makeRequest(app, 'POST', '/api/cloud-status', {
      trayId: 't',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid cloud-status payload');
  });

  it('requireLoopback rejects non-loopback remoteAddress with 403', () => {
    let statusCode = 0;
    let body: unknown = null;
    const req = { socket: { remoteAddress: '10.0.0.5' } } as unknown as ExpressRequest;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as ExpressResponse;
    let nextCalled = false;
    const next = (() => {
      nextCalled = true;
    }) as NextFunction;

    requireLoopback(req, res, next);

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'localhost only' });
  });

  it('requireLoopback accepts each known loopback shape', () => {
    const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

    for (const addr of loopbackAddresses) {
      let nextCalled = false;
      const req = { socket: { remoteAddress: addr } } as unknown as ExpressRequest;
      const res = {
        status() {
          throw new Error('status should not be called for loopback');
        },
        json() {
          throw new Error('json should not be called for loopback');
        },
      } as unknown as ExpressResponse;
      const next = (() => {
        nextCalled = true;
      }) as NextFunction;

      requireLoopback(req, res, next);

      expect(nextCalled).toBe(true);
    }
  });
});
