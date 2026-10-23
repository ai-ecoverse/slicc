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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_JOIN_FILE_PATH,
  joinErrorFilePath,
  registerCloudStatusEndpoint,
  requireLoopback,
  resolveJoinFilePath,
} from '../src/cloud-status.js';

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
    // Destroy keep-alive sockets before closing. `close()` alone leaves them
    // pooled in the fetch client while the OS is free to recycle this
    // ephemeral port onto the NEXT test's server — the client then reuses a
    // socket pointing at the wrong server and reads a crossed response
    // (observed: `HTTPParserError: Expected HTTP/` and a stray 404).
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('resolveJoinFilePath', () => {
  it('keeps the sandbox default when SLICC_JOIN_FILE is unset or blank', () => {
    expect(resolveJoinFilePath({})).toBe(DEFAULT_JOIN_FILE_PATH);
    expect(resolveJoinFilePath({ SLICC_JOIN_FILE: '   ' })).toBe('/tmp/slicc-join.json');
  });

  it('uses a trimmed SLICC_JOIN_FILE so each leader can write its own file', () => {
    expect(resolveJoinFilePath({ SLICC_JOIN_FILE: '  /leaders/lane1/join.json  ' })).toBe(
      '/leaders/lane1/join.json'
    );
  });

  it('reads SLICC_JOIN_FILE from process.env when no env bag is passed', () => {
    const previous = process.env.SLICC_JOIN_FILE;
    process.env.SLICC_JOIN_FILE = '/leaders/from-env/join.json';
    try {
      expect(resolveJoinFilePath()).toBe('/leaders/from-env/join.json');
    } finally {
      if (previous === undefined) delete process.env.SLICC_JOIN_FILE;
      else process.env.SLICC_JOIN_FILE = previous;
    }
  });
});

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

  it('POST /error records a failed mint beside the join file and logs the cause', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await makeRequest(app, 'POST', '/api/cloud-status/error', {
        error: 'POST /tray failed after 11 attempts in 86s: HTTP 503',
        sliccVersion: '6.256.1',
      });
      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledWith(
        '[cloud-status] leader failed to mint a tray: POST /tray failed after 11 attempts in 86s: HTTP 503'
      );
    } finally {
      errorSpy.mockRestore();
    }
    const payload = JSON.parse(await fs.readFile(joinErrorFilePath(tmpFile), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      error: 'POST /tray failed after 11 attempts in 86s: HTTP 503',
      sliccVersion: '6.256.1',
    });
    expect(new Date(payload.updatedAt as string).toISOString()).toBe(payload.updatedAt);
    // The join file itself is untouched: its consumers keep their joinUrl contract.
    await expect(fs.readFile(tmpFile, 'utf-8')).rejects.toThrow();
  });

  it('POST /error without an error string returns 400', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });
    const res = await makeRequest(app, 'POST', '/api/cloud-status/error', { error: 42 });
    expect(res.status).toBe(400);
    await expect(fs.readFile(joinErrorFilePath(tmpFile), 'utf-8')).rejects.toThrow();
  });

  it('POST /error answers 500 when the file cannot be written, after logging the cause', async () => {
    const app = express();
    // The parent directory does not exist, so the write fails.
    registerCloudStatusEndpoint(app, { joinFilePath: join(tmpDir, 'missing', 'join.json') });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await makeRequest(app, 'POST', '/api/cloud-status/error', {
        error: 'HTTP 503\nsecond line',
      });
      expect(res.status).toBe(500);
      // One line, so start-leader's log fallback reads the whole cause.
      expect(errorSpy).toHaveBeenCalledWith(
        '[cloud-status] leader failed to mint a tray: HTTP 503 second line'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a later successful POST clears a recorded failure', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });
    await fs.writeFile(joinErrorFilePath(tmpFile), '{"error":"old"}');
    const res = await makeRequest(app, 'POST', '/api/cloud-status', {
      joinUrl: 'https://example.com/join/abc',
    });
    expect(res.status).toBe(200);
    await expect(fs.readFile(joinErrorFilePath(tmpFile), 'utf-8')).rejects.toThrow();
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
    const loopbackAddresses = ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', 'localhost'];

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
