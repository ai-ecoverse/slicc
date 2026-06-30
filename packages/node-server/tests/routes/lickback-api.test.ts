/**
 * Route coverage for the lick-back API — claim / heartbeat / SSE drain / reply.
 *
 *   - DNS-rebinding Host guard: non-loopback Host → 403 (mirrors cup-api).
 *   - claim: first wins (200 {owner, leaseMs}); a different session → 409 {owner};
 *     missing X-Slicc-Session → 400 (registry untouched).
 *   - heartbeat: owner renews → 200; non-owner → 409.
 *   - GET drain (SSE): non-owner → 409; owner streams buffered + live events as
 *     `data: <json>\n\n` frames; disconnect unsubscribes.
 *   - reply: owner → bridge.broadcastLickEvent({type:'lickback-reply', …}) + 200;
 *     non-owner → 409 (bridge NOT called); missing replyTo → 400.
 */
import { createServer, request as httpRequest } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LickBridge } from '../../src/routes/lick-bridge.js';
import { registerLickbackApiRoutes } from '../../src/routes/lickback-api.js';
import {
  createLickbackRegistry,
  type LickbackRegistry,
} from '../../src/routes/lickback-registry.js';

const LEASE = 45_000;

function stubBridge(): Pick<LickBridge, 'broadcastLickEvent'> {
  return { broadcastLickEvent: vi.fn() };
}

interface TestServer {
  port: number;
  registry: LickbackRegistry;
  bridge: Pick<LickBridge, 'broadcastLickEvent'>;
  close(): Promise<void>;
}

function startServer(opts?: {
  registry?: LickbackRegistry;
  bridge?: Pick<LickBridge, 'broadcastLickEvent'>;
}): Promise<TestServer> {
  const registry = opts?.registry ?? createLickbackRegistry({ leaseMs: LEASE });
  const bridge = opts?.bridge ?? stubBridge();
  const app = express();
  app.use(express.json());
  registerLickbackApiRoutes(app, bridge, registry);

  return new Promise((resolve) => {
    const server = createServer(app);
    server.keepAliveTimeout = 0;
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        registry,
        bridge,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function httpJson(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; host?: string; session?: string } = {}
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    if (opts.session) headers['X-Slicc-Session'] = opts.session;
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: unknown = data;
        try {
          body = data ? JSON.parse(data) : '';
        } catch {
          /* keep raw */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * Open an SSE GET and collect `data:` frames. Resolves the `frames` promise once
 * `expectedFrames` have arrived (or after `idleMs` of silence). `close()` aborts.
 */
function httpSse(
  port: number,
  path: string,
  opts: { session?: string; host?: string; expectedFrames: number; idleMs?: number }
): { status: Promise<number>; frames: Promise<unknown[]>; close(): void } {
  const frames: unknown[] = [];
  let resolveStatus!: (n: number) => void;
  let resolveFrames!: (f: unknown[]) => void;
  const statusP = new Promise<number>((r) => (resolveStatus = r));
  const framesP = new Promise<unknown[]>((r) => (resolveFrames = r));
  let buffer = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const headers: Record<string, string> = {
    Host: opts.host ?? `127.0.0.1:${port}`,
    Accept: 'text/event-stream',
  };
  if (opts.session) headers['X-Slicc-Session'] = opts.session;

  const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
    resolveStatus(res.statusCode ?? 0);
    if ((res.statusCode ?? 0) !== 200) {
      res.resume();
      resolveFrames(frames);
      return;
    }
    const bump = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => resolveFrames(frames), opts.idleMs ?? 120);
    };
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (line) {
          try {
            frames.push(JSON.parse(line.slice('data:'.length).trim()));
          } catch {
            frames.push(line.slice('data:'.length).trim());
          }
          if (frames.length >= opts.expectedFrames) {
            if (idleTimer) clearTimeout(idleTimer);
            resolveFrames(frames);
            return;
          }
        }
      }
      bump();
    });
    res.on('end', () => resolveFrames(frames));
    bump();
  });
  req.on('error', () => {
    resolveStatus(0);
    resolveFrames(frames);
  });
  req.end();

  return {
    status: statusP,
    frames: framesP,
    close: () => req.destroy(),
  };
}

/**
 * Open an SSE GET and accumulate the RAW stream text (not just `data:` frames),
 * so a test can assert on `: ping` keepalive comments and `event: lickback-control`
 * field lines. `ended` resolves when the SERVER ends the response.
 */
function httpSseRaw(
  port: number,
  path: string,
  opts: { session?: string; host?: string }
): {
  status: Promise<number>;
  ended: Promise<void>;
  raw: () => string;
  isEnded: () => boolean;
  close(): void;
} {
  let raw = '';
  let ended = false;
  let resolveStatus!: (n: number) => void;
  let resolveEnded!: () => void;
  const statusP = new Promise<number>((r) => (resolveStatus = r));
  const endedP = new Promise<void>((r) => (resolveEnded = r));
  const headers: Record<string, string> = {
    Host: opts.host ?? `127.0.0.1:${port}`,
    Accept: 'text/event-stream',
  };
  if (opts.session) headers['X-Slicc-Session'] = opts.session;
  const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
    resolveStatus(res.statusCode ?? 0);
    res.setEncoding('utf-8');
    res.on('data', (c: string) => {
      raw += c;
    });
    res.on('end', () => {
      ended = true;
      resolveEnded();
    });
  });
  req.on('error', () => {
    resolveStatus(0);
    resolveEnded();
  });
  req.end();
  return {
    status: statusP,
    ended: endedP,
    raw: () => raw,
    isEnded: () => ended,
    close: () => req.destroy(),
  };
}

const servers: TestServer[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}
async function server(opts?: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const s = await startServer(opts);
  servers.push(s);
  return s;
}

describe('lickback-api — DNS-rebinding Host guard', () => {
  it('rejects a spoofed (non-loopback) Host with 403 and does not claim', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', {
      host: 'attacker.example.com',
      session: 'sess-A',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(403);
    expect(s.registry.isOwner('chat', 'sess-A')).toBe(false);
  });

  it('allows a loopback Host', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', {
      host: `127.0.0.1:${s.port}`,
      session: 'sess-A',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(200);
  });
});

describe('lickback-api — POST /api/lickback/claim', () => {
  it('first caller wins → 200 {owner, leaseMs}', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', {
      session: 'sess-A',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ owner: 'sess-A', leaseMs: LEASE });
  });

  it('a different session → 409 {owner}', async () => {
    const s = await server();
    await httpJson(s.port, 'POST', '/api/lickback/claim', { session: 'sess-A', body: {} });
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', {
      session: 'sess-B',
      body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ owner: 'sess-A' });
  });

  it('missing X-Slicc-Session → 400 and the registry is untouched', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', {
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(400);
    expect(s.registry.isOwner('chat', '')).toBe(false);
  });

  it('defaults the channel to "chat" when omitted', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/claim', { session: 'sess-A' });
    expect(res.status).toBe(200);
    expect(s.registry.isOwner('chat', 'sess-A')).toBe(true);
  });
});

describe('lickback-api — POST /api/lickback/heartbeat', () => {
  it('owner heartbeat → 200', async () => {
    const s = await server();
    await httpJson(s.port, 'POST', '/api/lickback/claim', { session: 'sess-A', body: {} });
    const res = await httpJson(s.port, 'POST', '/api/lickback/heartbeat', {
      session: 'sess-A',
      body: {},
    });
    expect(res.status).toBe(200);
  });

  it('non-owner heartbeat → 409', async () => {
    const s = await server();
    await httpJson(s.port, 'POST', '/api/lickback/claim', { session: 'sess-A', body: {} });
    const res = await httpJson(s.port, 'POST', '/api/lickback/heartbeat', {
      session: 'sess-B',
      body: {},
    });
    expect(res.status).toBe(409);
  });
});

describe('lickback-api — GET /api/lickback (SSE drain)', () => {
  it('rejects a non-owner with 409', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const sse = httpSse(s.port, '/api/lickback?channel=chat', {
      session: 'sess-B',
      expectedFrames: 0,
    });
    expect(await sse.status).toBe(409);
    sse.close();
  });

  it('streams buffered-then-live events to the owner as data frames', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    s.registry.enqueue('chat', { kind: 'chat', text: 'buffered' });

    const sse = httpSse(s.port, '/api/lickback?channel=chat', {
      session: 'sess-A',
      expectedFrames: 2,
    });
    expect(await sse.status).toBe(200);
    // Give the drain a tick to attach, then push a live event.
    await new Promise((r) => setTimeout(r, 30));
    s.registry.enqueue('chat', { kind: 'chat', text: 'live' });

    const frames = await sse.frames;
    expect(frames).toEqual([
      { kind: 'chat', text: 'buffered' },
      { kind: 'chat', text: 'live' },
    ]);
    sse.close();
  });

  it('unsubscribes on client disconnect (a later enqueue re-buffers)', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const sse = httpSse(s.port, '/api/lickback?channel=chat', {
      session: 'sess-A',
      expectedFrames: 1,
    });
    expect(await sse.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    sse.close();
    // Allow the server to observe the socket close.
    await new Promise((r) => setTimeout(r, 50));

    // After disconnect the drain is gone, so this buffers instead of throwing.
    s.registry.enqueue('chat', { kind: 'chat', text: 'after-close' });
    const received: unknown[] = [];
    const sub = s.registry.subscribe('chat', 'sess-A', (e) => received.push(e));
    expect(sub.ok).toBe(true);
    expect(received).toEqual([{ kind: 'chat', text: 'after-close' }]);
  });
});

describe('lickback-api — POST /api/lickback/reply', () => {
  it('owner reply forwards a lickback-reply over the bridge and 200s', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const res = await httpJson(s.port, 'POST', '/api/lickback/reply', {
      session: 'sess-A',
      body: { channel: 'chat', replyTo: 'msg-1', delta: 'hello', done: false },
    });
    expect(res.status).toBe(200);
    expect(s.bridge.broadcastLickEvent).toHaveBeenCalledWith({
      type: 'lickback-reply',
      channel: 'chat',
      replyTo: 'msg-1',
      delta: 'hello',
      done: false,
    });
  });

  it('non-owner reply → 409 and the bridge is NOT called', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const res = await httpJson(s.port, 'POST', '/api/lickback/reply', {
      session: 'sess-B',
      body: { channel: 'chat', replyTo: 'msg-1', text: 'nope' },
    });
    expect(res.status).toBe(409);
    expect(s.bridge.broadcastLickEvent).not.toHaveBeenCalled();
  });

  it('missing replyTo → 400 (bridge NOT called)', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const res = await httpJson(s.port, 'POST', '/api/lickback/reply', {
      session: 'sess-A',
      body: { channel: 'chat', text: 'orphan' },
    });
    expect(res.status).toBe(400);
    expect(s.bridge.broadcastLickEvent).not.toHaveBeenCalled();
  });
});

describe('lickback-api — POST /api/lickback/stop (operator stand-down)', () => {
  it('a DIFFERENT (non-owner) session may stop the owner → 200 {stopped:true}', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    // The steering brain that issues stop has a different session than the chat
    // owner — stop is loopback-trusted, NOT owner-gated.
    const res = await httpJson(s.port, 'POST', '/api/lickback/stop', {
      session: 'sess-B',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stopped: true });
    expect(s.registry.isOwner('chat', 'sess-A')).toBe(false);
  });

  it('unowned channel → 200 {stopped:false}', async () => {
    const s = await server();
    const res = await httpJson(s.port, 'POST', '/api/lickback/stop', {
      session: 'sess-A',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stopped: false });
  });

  it('missing X-Slicc-Session → 400 and the registry is untouched', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const res = await httpJson(s.port, 'POST', '/api/lickback/stop', {
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(400);
    // Not stopped — the owner survives.
    expect(s.registry.isOwner('chat', 'sess-A')).toBe(true);
  });

  it('non-loopback Host → 403 (DNS-rebinding guard), owner survives', async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const res = await httpJson(s.port, 'POST', '/api/lickback/stop', {
      host: 'attacker.example.com',
      session: 'sess-B',
      body: { channel: 'chat' },
    });
    expect(res.status).toBe(403);
    expect(s.registry.isOwner('chat', 'sess-A')).toBe(true);
  });

  it("ends the owner's open SSE with an `event: lickback-control` frame", async () => {
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const sse = httpSseRaw(s.port, '/api/lickback?channel=chat', { session: 'sess-A' });
    expect(await sse.status).toBe(200);
    // Let the drain attach.
    await new Promise((r) => setTimeout(r, 30));

    const res = await httpJson(s.port, 'POST', '/api/lickback/stop', {
      session: 'sess-A',
      body: { channel: 'chat' },
    });
    expect(res.body).toEqual({ stopped: true });

    // The server must END that exact open response (the only way to unblock a
    // long-poll consumer) and carry an intent-bearing control frame.
    await sse.ended;
    expect(sse.raw()).toContain('event: lickback-control');
    sse.close();
  });
});

describe('lickback-api — GET /api/lickback keepalive', () => {
  it('emits a `: ping` comment within LICKBACK_PING_MS without ending the stream', async () => {
    setEnv('LICKBACK_PING_MS', '40');
    const s = await server();
    s.registry.claim('chat', 'sess-A');
    const sse = httpSseRaw(s.port, '/api/lickback?channel=chat', { session: 'sess-A' });
    expect(await sse.status).toBe(200);
    // Wait for a few ping intervals.
    await new Promise((r) => setTimeout(r, 140));
    expect(sse.raw()).toContain(': ping');
    expect(sse.isEnded()).toBe(false); // a comment must NOT end the stream
    sse.close();
  });
});
