/**
 * Route coverage for POST /api/shell/exec — non-streaming and streaming shell exec
 * over the lick bridge. Tests cover:
 *   - Gate behaviour (REAL createThinBridgeCorsMiddleware, not a hand-rolled copy)
 *   - Loopback round-trip: stub resolves, 200 + body; assert stub call args
 *   - X-Slicc-Session header forwarded through to bridge data.sessionId
 *   - Missing command → 400 (bridge NOT called)
 *   - Bridge timeout → 504
 *   - No browser connected → 503
 *   - stream:true round-trip → NDJSON, 200, Content-Type application/x-ndjson
 *   - stream:true pre-stream reject → 503 (lazy-flush; no frames emitted)
 *   - stream:true mid-stream timeout → frame line + error line, connection ends
 *   - stream:true 400 on missing command (validation before branch)
 */
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TOKEN_HEADER } from '../../src/bridge-security.js';
import { createThinBridgeCorsMiddleware } from '../../src/routes/api-gate.js';
import { registerCupApiRoutes } from '../../src/routes/cup-api.js';
import type { LickBridge } from '../../src/routes/lick-bridge.js';

// An allowlisted non-loopback origin (will trigger the gate)
const REMOTE_ORIGIN = 'https://www.sliccy.ai';
const BRIDGE_TOKEN = 'test-bridge-token-1234';

function stubBridge(
  overrides: Partial<Pick<LickBridge, 'sendLickRequest' | 'sendLickStream'>> = {}
): Pick<LickBridge, 'sendLickRequest' | 'sendLickStream'> {
  return {
    sendLickRequest: vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0, pid: 1 }),
    sendLickStream: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(
  bridge: Pick<LickBridge, 'sendLickRequest' | 'sendLickStream'>,
  { withGate = false, token = BRIDGE_TOKEN }: { withGate?: boolean; token?: string | null } = {}
): Promise<TestServer> {
  const app = express();
  if (withGate) {
    app.use(createThinBridgeCorsMiddleware(token));
  }
  app.use(express.json());
  registerCupApiRoutes(app, bridge);

  return new Promise((resolve) => {
    const server = createServer(app);
    server.keepAliveTimeout = 0;
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            // closeAllConnections() destroys all open TCP sockets so server.close()
            // completes immediately regardless of keep-alive / in-flight connections.
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// Default `npm run cup` is thin-bridge: a real per-process token IS minted,
// so the gate is mounted WITH that token. These lock the PRODUCTION wiring — a
// cross-origin (hosted-leader) request is allowed only with the matching token,
// and loopback / no-Origin steering callers pass ungated.
describe('registerCupApiRoutes — gate behaviour', () => {
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

// ---------------------------------------------------------------------------
// No-token edge (`--cup --serve-only`): THIN_BRIDGE_MODE is false so no
// token is minted, but the `|| RUNTIME_FLAGS.cup` arm still mounts the gate
// fail-closed. The DEFAULT `npm run cup` path is thin-bridge and DOES mint a
// token — that production wiring is covered by the first describe block above
// (cross-origin-with-token → 200). Here we lock the null-token edge: a remote
// allowlisted origin can't validate against null (403), while loopback / no-Origin
// steering callers stay ungated.
// ---------------------------------------------------------------------------

describe('registerCupApiRoutes — gate behaviour (no-token --serve-only edge, fail-closed)', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('rejects a remote allowlisted origin (sliccy.ai) — no token can validate against null (403)', async () => {
    const stub = stubBridge();
    server = await startServer(stub, { withGate: true, token: null });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: REMOTE_ORIGIN,
        // even WITH a token header, null expected ⇒ validateBridgeToken returns false
        [BRIDGE_TOKEN_HEADER]: 'anything',
        'X-Slicc-Session': 'sess-x',
      },
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'bridge-token-required' });
  });

  it('allows the loopback steering caller (no Origin) ungated (200)', async () => {
    const stub = stubBridge();
    server = await startServer(stub, { withGate: true, token: null });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/shell/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Slicc-Session': 'sess-y' },
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DNS-rebinding defense. The loopback bind + Origin-exempt gate is NOT enough:
// a rebound hostname (attacker.com → 127.0.0.1) makes a same-origin request
// with no preflight and no Origin restriction, so the shell command would RUN
// even though the attacker can't read the response. A Host-header allowlist is
// the canonical defense for local servers. The key assertion is that the bridge
// is NEVER called for a spoofed Host — i.e. no shell command executes.
// ---------------------------------------------------------------------------

describe('registerCupApiRoutes — DNS-rebinding Host guard', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function postWithHost(
    port: number,
    path: string,
    hostHeader: string
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Slicc-Session': 'sess-dns',
            Host: hostHeader,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify({ command: 'echo hi' }));
    });
  }

  it('rejects a spoofed (non-loopback) Host with 403 and runs NO command', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await postWithHost(server.port, '/api/shell/exec', 'attacker.example.com');
    expect(res.status).toBe(403);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('allows a loopback Host (127.0.0.1:port)', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await postWithHost(server.port, '/api/shell/exec', `127.0.0.1:${server.port}`);
    expect(res.status).toBe(200);
    expect(sendLickRequest).toHaveBeenCalledOnce();
  });

  it('allows a localhost Host', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ stdout: 'hi\n', stderr: '', exitCode: 0 });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await postWithHost(server.port, '/api/shell/exec', `localhost:${server.port}`);
    expect(res.status).toBe(200);
  });
});

describe('registerCupApiRoutes — route behaviour', () => {
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
      body: JSON.stringify({ command: 'echo hi' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0, pid: 42 });

    // Assert bridge received the right type, data, and a long timeout (>= 60s)
    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data, timeout] = sendLickRequest.mock.calls[0];
    expect(type).toBe('shell-exec');
    expect(data).toMatchObject({ sessionId: 'sess-abc', command: 'echo hi' });
    expect(data).not.toHaveProperty('cwd');
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

describe('registerCupApiRoutes — GET /api/shell/session/:id', () => {
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

// ---------------------------------------------------------------------------
// Helper: POST via raw node:http request — avoids the keep-alive / fetch hang
// on chunked responses that occurs with Node's built-in fetch.
// node:http is imported as `httpRequest` (named import) to sidestep the
// vitest alias that maps bare `'http'` to the browser shim.
// ---------------------------------------------------------------------------
import type { IncomingMessage } from 'node:http';

function httpPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          Connection: 'close',
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: (res.headers as Record<string, string>) ?? {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
    // Safety net: reject after 4s so the test can report a useful error
    // rather than hitting vitest's 5s wall with no message.
    const safety = setTimeout(() => reject(new Error('httpPost: no response after 4000ms')), 4000);
    req.on('close', () => clearTimeout(safety));
  });
}

describe('registerCupApiRoutes — POST /api/shell/exec stream:true', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('stream round-trip: 2 NDJSON lines, 200, Content-Type application/x-ndjson', async () => {
    const sendLickStream = vi
      .fn()
      .mockImplementation(
        async (_type: string, _data: unknown, onFrame: (f: unknown) => void): Promise<void> => {
          onFrame({ t: 'stdout', d: 'hi\n' });
          onFrame({ t: 'exit', code: 0, pid: 5 });
        }
      );
    server = await startServer(stubBridge({ sendLickStream }));

    const res = await httpPost(
      server.port,
      '/api/shell/exec',
      { 'X-Slicc-Session': 'stream-sess' },
      JSON.stringify({ command: 'echo hi', stream: true })
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const lines = res.body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ t: 'stdout', d: 'hi\n' });
    expect(JSON.parse(lines[1])).toEqual({ t: 'exit', code: 0, pid: 5 });
  });

  it('pre-stream reject → 503 (lazy-flush: no frames emitted before reject)', async () => {
    const sendLickStream = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickStream }));

    const res = await httpPost(
      server.port,
      '/api/shell/exec',
      { 'X-Slicc-Session': 'stream-sess-nbc' },
      JSON.stringify({ command: 'ls', stream: true })
    );

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'No browser connected' });
  });

  it('mid-stream timeout: frame line + error line, connection ends', async () => {
    const sendLickStream = vi
      .fn()
      .mockImplementation(
        async (_type: string, _data: unknown, onFrame: (f: unknown) => void): Promise<void> => {
          onFrame({ t: 'stdout', d: 'partial\n' });
          throw new Error('Request timeout');
        }
      );
    server = await startServer(stubBridge({ sendLickStream }));

    const res = await httpPost(
      server.port,
      '/api/shell/exec',
      { 'X-Slicc-Session': 'stream-sess-timeout' },
      JSON.stringify({ command: 'long-cmd', stream: true })
    );

    // Status is 200 because headers were already sent (first frame was written)
    expect(res.status).toBe(200);
    const lines = res.body.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ t: 'stdout', d: 'partial\n' });
    const errLine = JSON.parse(lines[1]);
    expect(errLine.t).toBe('error');
    expect(errLine.message).toBe('Request timeout');
  });

  it('stream:true still 400 on missing command (validation before stream branch)', async () => {
    const sendLickStream = vi.fn();
    server = await startServer(stubBridge({ sendLickStream }));

    const res = await httpPost(
      server.port,
      '/api/shell/exec',
      { 'X-Slicc-Session': 'sess-400' },
      JSON.stringify({ stream: true })
    );

    expect(res.status).toBe(400);
    expect(sendLickStream).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helper: GET via raw node:http — avoids fetch keep-alive issues with query strings.
// ---------------------------------------------------------------------------

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path,
        headers: { Connection: 'close', ...headers },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
    const safety = setTimeout(() => reject(new Error('httpGet: no response after 4000ms')), 4000);
    req.on('close', () => clearTimeout(safety));
  });
}

// ---------------------------------------------------------------------------
// VFS routes — GET /api/vfs/read, POST /api/vfs/write, GET /api/vfs/stat, POST /api/vfs/list
// ---------------------------------------------------------------------------

describe('registerCupApiRoutes — VFS routes', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  // ---- GET /api/vfs/read ----

  it('vfs-read: 200 with content returned from bridge', async () => {
    const sendLickRequest = vi
      .fn()
      .mockResolvedValue({ content: 'hello world', encoding: 'utf-8' });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fworkspace%2Fa.txt');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { content: string; encoding: string };
    expect(body).toEqual({ content: 'hello world', encoding: 'utf-8' });
    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('vfs-read');
    expect((data as Record<string, unknown>).path).toBe('/workspace/a.txt');
  });

  it('vfs-read: 400 when path is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read');
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-read: 404 when bridge throws ENOENT', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx');
    expect(res.status).toBe(404);
  });

  it('vfs-read: 503 when no browser connected', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx');
    expect(res.status).toBe(503);
  });

  it('vfs-read: 504 on timeout', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('Request timeout'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx');
    expect(res.status).toBe(504);
  });

  it('vfs-read: 400 when encoding is invalid (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx&encoding=rot13');
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-read: forwards a valid base64 encoding to the bridge', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ content: 'AAA=', encoding: 'base64' });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx&encoding=base64');
    expect(res.status).toBe(200);
    const [, data] = sendLickRequest.mock.calls[0];
    expect((data as Record<string, unknown>).encoding).toBe('base64');
  });

  // ---- POST /api/vfs/write ----

  it('vfs-write: 200 with {ok:true} on success', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ ok: true });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/write',
      {},
      JSON.stringify({ path: '/workspace/out.txt', content: 'data' })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('vfs-write');
    expect((data as Record<string, unknown>).path).toBe('/workspace/out.txt');
    expect((data as Record<string, unknown>).content).toBe('data');
  });

  it('vfs-write: 400 when path is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(server.port, '/api/vfs/write', {}, JSON.stringify({ content: 'x' }));
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-write: 400 when content is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/write',
      {},
      JSON.stringify({ path: '/workspace/out.txt' })
    );
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-write: 400 when encoding is invalid (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/write',
      {},
      JSON.stringify({ path: '/x', content: 'y', encoding: 'rot13' })
    );
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-write: 404 when bridge throws ENOENT', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('ENOENT: no such dir'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/write',
      {},
      JSON.stringify({ path: '/missing/out.txt', content: 'x' })
    );
    expect(res.status).toBe(404);
  });

  it('vfs-write: 503 when no browser connected', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/write',
      {},
      JSON.stringify({ path: '/x', content: 'y' })
    );
    expect(res.status).toBe(503);
  });

  // ---- GET /api/vfs/stat ----

  it('vfs-stat: 200 with stat shape from bridge', async () => {
    const sendLickRequest = vi.fn().mockResolvedValue({ type: 'file', size: 42, mtime: 1234567 });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/stat?path=%2Fworkspace%2Fa.txt');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: 'file', size: 42, mtime: 1234567 });
    const [type] = sendLickRequest.mock.calls[0];
    expect(type).toBe('vfs-stat');
  });

  it('vfs-stat: 400 when path is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/stat');
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-stat: 404 when bridge throws ENOENT', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('ENOENT: not found'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/stat?path=%2Fx');
    expect(res.status).toBe(404);
  });

  // ---- POST /api/vfs/list ----

  it('vfs-list: 200 with directory listing from bridge', async () => {
    const entries = [
      { name: 'a.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
    ];
    const sendLickRequest = vi.fn().mockResolvedValue(entries);
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/list',
      {},
      JSON.stringify({ path: '/workspace' })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(entries);
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('vfs-list');
    expect((data as Record<string, unknown>).path).toBe('/workspace');
  });

  it('vfs-list: 400 when path is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(server.port, '/api/vfs/list', {}, JSON.stringify({}));
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('vfs-list: 404 when bridge throws ENOENT', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('ENOENT: not a dir'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/list',
      {},
      JSON.stringify({ path: '/missing' })
    );
    expect(res.status).toBe(404);
  });

  it('vfs-list: 503 when no browser connected', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/vfs/list',
      {},
      JSON.stringify({ path: '/workspace' })
    );
    expect(res.status).toBe(503);
  });

  it('vfs-read: unknown VFS error maps to 400 (not 500)', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('EINVAL: bad path'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/vfs/read?path=%2Fx');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/targets
// ---------------------------------------------------------------------------

describe('registerCupApiRoutes — GET /api/targets', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('returns 200 with PageInfo[] and calls bridge with ("targets", {})', async () => {
    const targets = [
      { targetId: 't1', url: 'https://example.com', title: 'Example' },
      { targetId: 't2', url: 'about:blank', title: '' },
    ];
    const sendLickRequest = vi.fn().mockResolvedValue(targets);
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/targets');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(targets);
    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('targets');
    expect(data).toEqual({});
  });

  it('forwards the federated + runtime-annotated payload from the bridge verbatim', async () => {
    // The route is a thin pass-through; the webapp bridge does the local +
    // federated aggregation and runtime annotation. This guards that the route
    // does not strip or reshape the `runtime` field (local: null, follower: id).
    const targets = [
      { targetId: 'local-1', url: 'https://app.local', title: 'App', runtime: null },
      {
        targetId: 'follower-abc:remote-tab',
        url: 'https://follower.example',
        title: 'Follower',
        runtime: 'follower-abc',
      },
    ];
    const sendLickRequest = vi.fn().mockResolvedValue(targets);
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/targets');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(targets);
  });

  it('returns 503 when no browser connected', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/targets');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'No browser connected' });
  });

  it('returns 500 for an unknown bridge error', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('unexpected crash'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpGet(server.port, '/api/targets');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// POST /api/lick/emit
// ---------------------------------------------------------------------------

describe('registerCupApiRoutes — POST /api/lick/emit', () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('returns 200 {ok:true} and forwards ("lick-emit", {lickType, data}) — no type collision', async () => {
    const lickData = { verb: 'handoff', target: 'cone', url: 'https://sliccy.ai' };
    const sendLickRequest = vi.fn().mockResolvedValue({ ok: true });
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/lick/emit',
      {},
      JSON.stringify({ type: 'navigate', data: lickData })
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(sendLickRequest).toHaveBeenCalledOnce();
    const [type, data] = sendLickRequest.mock.calls[0];
    expect(type).toBe('lick-emit');
    expect(data).toEqual({ lickType: 'navigate', data: lickData });
  });

  it('returns 400 when type is missing (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(server.port, '/api/lick/emit', {}, JSON.stringify({ data: {} }));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('type') });
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('returns 400 when type is empty string (bridge NOT called)', async () => {
    const sendLickRequest = vi.fn();
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/lick/emit',
      {},
      JSON.stringify({ type: '', data: {} })
    );
    expect(res.status).toBe(400);
    expect(sendLickRequest).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) when bridge rejects with a generic error (bad payload)', async () => {
    const sendLickRequest = vi
      .fn()
      .mockRejectedValue(new Error("lick-emit navigate requires verb ('handoff'|'upskill')"));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/lick/emit',
      {},
      JSON.stringify({ type: 'navigate', data: { url: 'https://x.com' } })
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when no browser connected', async () => {
    const sendLickRequest = vi.fn().mockRejectedValue(new Error('No browser connected'));
    server = await startServer(stubBridge({ sendLickRequest }));
    const res = await httpPost(
      server.port,
      '/api/lick/emit',
      {},
      JSON.stringify({ type: 'navigate', data: {} })
    );
    expect(res.status).toBe(503);
  });
});
