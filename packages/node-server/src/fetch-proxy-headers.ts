import type { IncomingMessage } from 'http';

import { isHostFsStableBodyRequest } from './hostfs.js';

export const FETCH_PROXY_SKIP_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'x-target-url',
  'x-slicc-raw-body',
  'content-length',
  'transfer-encoding',
  'x-proxy-cookie',
  'x-proxy-origin',
  'x-proxy-referer',

  'x-bridge-token',

  'x-slicc-hmac-sign',

  'accept-encoding',
]);

export const FETCH_PROXY_SKIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'transfer-encoding',

  'content-encoding',
  'content-length',
  'www-authenticate',
  'set-cookie',
]);

export const FETCH_PROXY_SKIP_RESPONSE_PREFIXES: readonly string[] = [
  'access-control-',
  'x-proxy-',
];

export const FETCH_PROXY_CONTENT_LENGTH_HEADER = 'X-Proxy-Content-Length';

export const FETCH_PROXY_BASE_EXPOSE_HEADERS: readonly string[] = [
  'Link',
  'X-Proxy-Error',
  'X-Proxy-Set-Cookie',
  FETCH_PROXY_CONTENT_LENGTH_HEADER,
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Cache-Control',
];

export function buildFetchProxyExposeHeaders(forwardedHeaderNames: Iterable<string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...FETCH_PROXY_BASE_EXPOSE_HEADERS, ...forwardedHeaderNames]) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out.join(', ');
}

export function shouldParseGlobalJson(req: IncomingMessage): boolean {
  if (req.headers['x-slicc-raw-body'] === '1') return false;
  if (isHostFsStableBodyRequest(req)) return false;
  return (req.headers['content-type'] ?? '').includes('application/json');
}
