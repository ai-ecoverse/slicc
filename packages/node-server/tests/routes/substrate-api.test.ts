/**
 * Route coverage for POST /api/shell/exec — non-streaming shell exec over the
 * lick bridge. Tests cover:
 *   - Gate behaviour (REAL createThinBridgeCorsMiddleware, not a hand-rolled copy)
 *   - Loopback round-trip: stub resolves, 200 + body; assert stub call args
 *   - X-Slicc-Session header forwarded through to bridge data.sessionId
 *   - Missing command → 400 (bridge NOT called)
 *   - Bridge timeout → 504
 *   - No browser connected → 503
 */
import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TOKEN_HEADER } from '../../src/bridge-security.js';
import { createThinBridgeCorsMiddleware } from '../../src/routes/api-gate.js';
import type { LickBridge } from '../../src/routes/lick-bridge.js';
import { registerSubstrateApiRoutes } from '../../src/routes/substrate-api.js';

// An allowlisted non-loopback origin (will trigger the gate)
const REMOTE_ORIGIN = 'https://www.sliccy.ai';
const BRIDGE_TOKEN = 'test-bridge-token-1234';

function stubBridge(
  overrides: Partial<Pick<LickBridge, 'sendLickRequest'>> = {}
): Pick<LickBridge, 'sendLickRequest'> {
  return {
    sendLickRequest: vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0, pid: 1 }),
    ...overrides,
  };
}

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(
  bridge: Pick<LickBridge, 'sendLickRequest'>,
  { withGate = false, token = BRIDGE_TOKEN }: { withGate?: boolean; token?: string } = {}
): Promise<TestServer> {
  const app = express();
  if (withGate) {
    app.use(createThinBridgeCorsMiddleware(token));
  }
  app.use(express.json());
  registerSubstrateApiRoutes(app, bridge);

  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('registerSubstrateApiRoutes — gate behaviour', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('rejects an allowlisted non-loopback origin with no bridge token (403)', async () => {
    server = await startServer(stubBridge(), { withGate: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: REMOTE_ORIGIN,
        // no X-Bridge-Token
      },
      body: JSON.stringify({ command: 'echo hi', sessionId: 'sess-1' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'bridge-token-required' });
  });

  it('allows an allowlisted non-loopback origin with a valid bridge token (200)', async () => {
    const stub = stubBridge();
    server = await startServer(stub, { withGate: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: REMOTE_ORIGIN,
        [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN,
        'X-Slicc-Session': 'sess-2',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stdout: 'hi\n', exitCode: 0 });
  });

  it('allows loopback / no-Origin without a token (200)', async () => {
    const stub = stubBridge();
    server = await startServer(stub, { withGate: true });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-3',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('registerSubstrateApiRoutes — route behaviour', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('returns 200 with exec output and calls bridge with correct args', async () => {
    const sendLickRequest = vi
      .fn()
      .mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0, pid: 42 });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-abc',
      },
      body: JSON.stringify({ command: 'echo hi', cwd: '/workspace' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0, pid: 42 });

    // Assert bridge received the right type, data, and a long timeout (>= 60s)
    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data, timeout] = sendLickRequest.mock.calls[0];
    expect(type).toBe('shell-exec');
    expect(data).toMatchObject({ sessionId: 'sess-abc', command: 'echo hi', cwd: '/workspace' });
    expect(typeof timeout).toBe('number');
    expect(timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('passes X-Slicc-Session to bridge data.sessionId', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    server = await startServer(stubBridge({ sendLickRequest }));
    await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'my-session-id',
      },
      body: JSON.stringify({ command: 'ls' }),
    });
    const [, data] = sendLickRequest.mock.calls[0];
    expect((data as { sessionId: string }).sessionId).toBe('my-session-id');
  });

  it('returns 400 and does not call bridge when command is missing', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-x',
      },
      body: JSON.stringify({ cwd: '/tmp' }),
    });
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('returns 400 and does not call bridge when sessionId is missing', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('maps a bridge timeout to 504', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('Request timeout'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-y',
      },
      body: JSON.stringify({ command: 'sleep 9999' }),
    });
    expect(res.status).toBe(504);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('maps "No browser connected" to 503', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-z',
      },
      body: JSON.stringify({ command: 'ls' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No browser connected' });
  });

  it('maps an unknown bridge error to 500', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('handler crashed'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-w',
      },
      body: JSON.stringify({ command: 'ls' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'handler crashed' });
  });

  it('respects a caller-supplied timeoutMs', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    server = await startServer(stubBridge({ sendLickRequest }));
    await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Session': 'sess-t',
      },
      body: JSON.stringify({ command: 'ls', timeoutMs: 30_000 }),
    });
    const [, , timeout] = sendLickRequest.mock.calls[0];
    expect(timeout).toBe(30_000);
  });
});

describe('registerSubstrateApiRoutes — GET /api/shell/session/:id', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('returns 200 with status object and calls bridge with correct args', async () => {
    const statusData = {
      alive: true,
      cwd: '/workspace',
      runningPids: [],
      bufferedTail: '',
    };
    const sendLickRequest = vi.fn().mockResolvedValue(statusData);
    server = await startServer(stubBridge({ sendLickRequest }));

    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/session/my-sess-id`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(statusData);

    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('shell-session-status');
    expect(data).toEqual({ sessionId: 'my-sess-id' });
  });

  it('maps "No browser connected" to 503', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));

    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/session/sess-probe`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No browser connected' });
  });
});
