import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createHttpCdp, findSliccPageTarget, restartLeader } from '../src/leader-restart.js';

describe('findSliccPageTarget', () => {
  it('returns the page target whose URL starts with the local URL', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'chrome://newtab/', attached: true },
      {
        id: 'b',
        type: 'page',
        url: 'http://localhost:5710/?runtime=hosted-leader',
        attached: true,
      },
      { id: 'c', type: 'background_page', url: 'http://localhost:5710/', attached: true },
    ];
    const t = findSliccPageTarget(targets, 'http://localhost:5710/');
    expect(t?.id).toBe('b');
  });

  it('matches the hosted origin URL used in thin-bridge mode', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'chrome://newtab/', attached: true },
      {
        id: 'b',
        type: 'page',
        url: 'https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp&bridgeToken=abc&runtime=hosted-leader',
        attached: true,
      },
    ];
    const t = findSliccPageTarget(targets, 'https://www.sliccy.ai/');
    expect(t?.id).toBe('b');
  });

  it('returns null when no page target matches', () => {
    expect(findSliccPageTarget([], 'http://localhost:5710/')).toBeNull();
    expect(
      findSliccPageTarget(
        [{ id: 'a', type: 'page', url: 'chrome://newtab/', attached: true }],
        'http://localhost:5710/'
      )
    ).toBeNull();
  });

  it('prefers attached page targets when multiple match', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'http://localhost:5710/x', attached: false },
      { id: 'b', type: 'page', url: 'http://localhost:5710/y', attached: true },
    ];
    expect(findSliccPageTarget(targets, 'http://localhost:5710/')?.id).toBe('b');
  });
});

describe('restartLeader', () => {
  it('calls CDP Page.reload against the SLICC page', async () => {
    const reloads: string[] = [];
    const fakeCdp = {
      send: vi.fn(async (method: string, _params: unknown, sessionId?: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'tgt',
                type: 'page',
                url: 'http://localhost:5710/?runtime=hosted-leader',
                attached: true,
              },
            ],
          };
        }
        if (method === 'Target.attachToTarget') return { sessionId: 'sess' };
        if (method === 'Page.reload') {
          reloads.push(sessionId ?? 'none');
          return {};
        }
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result.ok).toBe(true);
    expect(reloads).toEqual(['sess']);
  });

  it('returns 503 NO_LEADER_TAB shape when no SLICC page exists', async () => {
    const fakeCdp = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result).toMatchObject({ ok: false, code: 'NO_LEADER_TAB' });
  });
});

describe('registerLeaderRestartEndpoint — localhost guard', () => {
  it('returns 403 for a non-loopback remoteAddress', async () => {
    // Same synthetic-request approach as the cloud-status 403 test;
    // requireLoopback is shared from cloud-status.ts.
    const { requireLoopback } = await import('../src/cloud-status.js');
    let statusCode = 0;
    let body: unknown = null;
    const req = { socket: { remoteAddress: '10.0.0.5' } } as never;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as never;
    let nextCalled = false;
    requireLoopback(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'localhost only' });
  });
});

describe('createHttpCdp — real WebSocket roundtrip', () => {
  it('attaches to a target and sends Page.reload', async () => {
    // Stand up a fake CDP target: HTTP /json returns a target descriptor;
    // a ws server accepts the connection and echoes Target.attachToTarget +
    // Page.reload responses by request id.
    const received: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
      [];
    const httpServer = createServer((req, res) => {
      if (req.url === '/json') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              id: 'page-1',
              type: 'page',
              url: 'http://localhost:5710/?runtime=hosted-leader',
              webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/page-1`,
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;

    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: unknown;
          sessionId?: string;
        };
        received.push(msg);
        if (msg.method === 'Target.attachToTarget') {
          sock.send(JSON.stringify({ id: msg.id, result: { sessionId: 'sess-1' } }));
        } else if (msg.method === 'Page.reload') {
          sock.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });

    try {
      const cdp = createHttpCdp(port);
      const result = await restartLeader(cdp, 'http://localhost:5710/');
      expect(result.ok).toBe(true);
      expect(received.map((m) => m.method)).toEqual(['Target.attachToTarget', 'Page.reload']);
      expect(received[1].sessionId).toBe('sess-1');
    } finally {
      wss.close();
      httpServer.close();
    }
  });

  it('returns CDP_NOT_READY when /json is unreachable', async () => {
    const cdp = createHttpCdp(/* port that nothing is listening on */ 1);
    const result = await restartLeader(cdp, 'http://localhost:5710/');
    expect(result).toMatchObject({ ok: false, code: 'CDP_NOT_READY' });
  });

  it('re-opens the WebSocket on a second restartLeader cycle (cache cleared on Page.reload)', async () => {
    // Track every ws connection the test fixture receives. The first restartLeader
    // cycle should open one connection; after Page.reload the cached client must
    // be dropped, so the second cycle must open a NEW connection.
    let wsConnections = 0;
    const httpServer = createServer((req, res) => {
      if (req.url === '/json') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              id: 'page-1',
              type: 'page',
              url: 'http://localhost:5710/?runtime=hosted-leader',
              webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/page-1`,
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;

    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (sock) => {
      wsConnections++;
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id: number; method: string };
        if (msg.method === 'Target.attachToTarget') {
          sock.send(JSON.stringify({ id: msg.id, result: { sessionId: `sess-${wsConnections}` } }));
        } else if (msg.method === 'Page.reload') {
          sock.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });

    try {
      const cdp = createHttpCdp(port);
      const first = await restartLeader(cdp, 'http://localhost:5710/');
      expect(first.ok).toBe(true);
      expect(wsConnections).toBe(1);

      const second = await restartLeader(cdp, 'http://localhost:5710/');
      expect(second.ok).toBe(true);
      expect(wsConnections).toBe(2);
    } finally {
      wss.close();
      httpServer.close();
    }
  });
});
