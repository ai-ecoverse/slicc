/**
 * Keep-alive tuning for the local bridge HTTP server.
 *
 * Node's default `keepAliveTimeout` is 5 s, which Express advertises verbatim
 * (`Keep-Alive: timeout=5`). That is far below Chrome's idle-socket timeout, so
 * during a bursty fan-out — an in-browser `git status` walking a repo over
 * `/api/hostfs` issues thousands of small requests in waves — the server closes
 * a pooled socket in the same instant the browser writes the next request onto
 * it. The browser cannot tell that apart from a dead server and rejects the
 * `fetch()` with `TypeError: Failed to fetch`, which used to abort the whole
 * git command (issue #2720).
 *
 * Holding idle sockets open for two minutes makes that race vanishingly rare on
 * a loopback bridge that only ever serves this machine's browser. Sockets are
 * still reaped, just on a scale the client's own pooling never reaches during a
 * burst. `headersTimeout` must stay above `keepAliveTimeout`, otherwise Node
 * aborts a connection it is still willing to keep.
 */

import { createServer, type Server as HttpServer, type RequestListener } from 'http';

/** Idle keep-alive socket lifetime (ms). Advertised as `Keep-Alive: timeout=120`. */
export const BRIDGE_KEEP_ALIVE_TIMEOUT_MS = 120_000;

/** Header-completion budget (ms). Must exceed `BRIDGE_KEEP_ALIVE_TIMEOUT_MS`. */
export const BRIDGE_HEADERS_TIMEOUT_MS = 130_000;

/**
 * Apply the bridge keep-alive settings to an HTTP server. Call before
 * `listen()` — Node reads both values per connection, but a server that has
 * already accepted sockets would keep the old budget for them.
 */
export function applyBridgeKeepAlive(server: HttpServer): void {
  server.keepAliveTimeout = BRIDGE_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = BRIDGE_HEADERS_TIMEOUT_MS;
}

/**
 * Create the bridge's HTTP server with the keep-alive budget already applied,
 * so no caller can construct one that still advertises `timeout=5`.
 */
export function createBridgeServer(requestListener: RequestListener): HttpServer {
  const server = createServer(requestListener);
  applyBridgeKeepAlive(server);
  return server;
}
