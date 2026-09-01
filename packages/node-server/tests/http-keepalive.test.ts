import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyBridgeKeepAlive,
  BRIDGE_HEADERS_TIMEOUT_MS,
  BRIDGE_KEEP_ALIVE_TIMEOUT_MS,
  createBridgeServer,
} from '../src/http-keepalive.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('applyBridgeKeepAlive', () => {
  it('raises keepAliveTimeout far above Node’s 5 s default', () => {
    const server = createServer();
    servers.push(server);
    expect(server.keepAliveTimeout).toBe(5_000); // Node's default, the #2720 trigger
    applyBridgeKeepAlive(server);
    expect(server.keepAliveTimeout).toBe(BRIDGE_KEEP_ALIVE_TIMEOUT_MS);
    expect(BRIDGE_KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThanOrEqual(65_000);
  });

  it('keeps headersTimeout above keepAliveTimeout so Node never aborts a live socket', () => {
    const server = createServer();
    servers.push(server);
    applyBridgeKeepAlive(server);
    expect(server.headersTimeout).toBe(BRIDGE_HEADERS_TIMEOUT_MS);
    expect(BRIDGE_HEADERS_TIMEOUT_MS).toBeGreaterThan(BRIDGE_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('advertises the raised timeout to the browser in the Keep-Alive header', async () => {
    const server = createBridgeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/`);
    await response.text();
    // Chrome reads this header to decide how long a pooled socket stays usable;
    // `timeout=5` is what made a reused socket race the server's close (#2720).
    expect(response.headers.get('keep-alive')).toContain(
      `timeout=${BRIDGE_KEEP_ALIVE_TIMEOUT_MS / 1000}`
    );
  });

  it('creates a server with the budget already applied', () => {
    const server = createBridgeServer(() => {});
    servers.push(server);
    expect(server.keepAliveTimeout).toBe(BRIDGE_KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(BRIDGE_HEADERS_TIMEOUT_MS);
  });

  it('is the constructor index.ts uses for the bridge server', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
    // The raw `createServer(app)` is what shipped `Keep-Alive: timeout=5`.
    expect(source).toContain('const server = createBridgeServer(app);');
    expect(source).not.toContain('createServer(app)');
  });
});
