/**
 * End-to-end WebSocket upgrade gate for the thin /cdp bridge.
 *
 * Boots a real `http.Server` + `WebSocketServer` wired with the same
 * `handleProtocols` + `attachCdpUpgradeRouting` shape as `index.ts`, then
 * drives `ws` clients through every accept/reject branch:
 *   - allowlisted origin + matching subprotocol = 101 + echoed subprotocol
 *   - allowlisted origin + wrong subprotocol    = 401 close
 *   - allowlisted origin + no subprotocol       = 401 close
 *   - disallowed origin                         = 401 close
 *
 * The handler is copied verbatim from `index.ts` so this test pins the
 * gate behavior; `bridge-security.test.ts` covers the pure-function layer.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  BRIDGE_SUBPROTOCOL_PREFIX,
  selectBridgeSubprotocol,
  validateBridgeUpgrade,
} from '../src/bridge-security.js';

const TOKEN = '11112222-3333-4444-5555-666677778888';
const PROD_ORIGIN = 'https://www.sliccy.ai';

let httpServer: HttpServer;
let wss: WebSocketServer;
let port = 0;

beforeEach(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols: Set<string>) =>
      selectBridgeSubprotocol([...protocols], TOKEN) ?? false,
  });

  // Mirror of the index.ts upgrade routing (token-gated branch only).
  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url!, `http://${request.headers.host}`);
    if (pathname !== '/cdp') {
      socket.destroy();
      return;
    }
    const gate = validateBridgeUpgrade({
      origin: request.headers.origin,
      subprotocolHeader: request.headers['sec-websocket-protocol'],
      expectedToken: TOKEN,
    });
    if (!gate.ok) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    // Echo a single hello so the client can confirm the connection is live.
    ws.send('hello');
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function connect(
  protocols: string[] | undefined,
  origin: string | undefined
): Promise<{ ws: WebSocket; status?: number; firstMessage: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`, protocols ?? [], { headers });
    // Listener attached BEFORE the connection opens so the server's first
    // frame can't lose the race with the open callback.
    const firstMessage = new Promise<string>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('no message received')), 4000);
      ws.once('message', (data: Buffer) => {
        clearTimeout(timer);
        res(data.toString());
      });
    });
    ws.on('open', () => resolve({ ws, firstMessage }));
    ws.on('unexpected-response', (_req, res) => {
      resolve({ ws, status: res.statusCode, firstMessage });
    });
    ws.on('error', (err) => {
      // Surface connect-time errors only; post-open errors are caller's problem.
      if (ws.readyState === WebSocket.CONNECTING) reject(err);
    });
    setTimeout(() => reject(new Error('connect timed out')), 5000);
  });
}

describe('thin /cdp bridge WS upgrade gate (integration)', () => {
  it('accepts allowlisted origin + matching subprotocol and echoes it back', async () => {
    const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;
    const { ws, firstMessage } = await connect([proto], PROD_ORIGIN);
    expect(ws.protocol).toBe(proto);
    expect(await firstMessage).toBe('hello');
    ws.close();
  });

  it('rejects allowlisted origin without any Sec-WebSocket-Protocol', async () => {
    const result = await connect(undefined, PROD_ORIGIN);
    expect(result.status).toBe(401);
  });

  it('rejects allowlisted origin with mismatched subprotocol token', async () => {
    const result = await connect([`${BRIDGE_SUBPROTOCOL_PREFIX}wrong-token`], PROD_ORIGIN);
    expect(result.status).toBe(401);
  });

  it('rejects non-allowlisted origin even when subprotocol matches', async () => {
    const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;
    const result = await connect([proto], 'https://evil.example.com');
    expect(result.status).toBe(401);
  });

  it('rejects when Origin header is omitted entirely', async () => {
    const proto = `${BRIDGE_SUBPROTOCOL_PREFIX}${TOKEN}`;
    const result = await connect([proto], undefined);
    expect(result.status).toBe(401);
  });
});
