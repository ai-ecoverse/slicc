import { createServer, type Server as HttpServer, type RequestListener } from 'http';

export const BRIDGE_KEEP_ALIVE_TIMEOUT_MS = 120_000;

export const BRIDGE_HEADERS_TIMEOUT_MS = 130_000;

export function applyBridgeKeepAlive(server: HttpServer): void {
  server.keepAliveTimeout = BRIDGE_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = BRIDGE_HEADERS_TIMEOUT_MS;
}

export function createBridgeServer(requestListener: RequestListener): HttpServer {
  const server = createServer(requestListener);
  applyBridgeKeepAlive(server);
  return server;
}
