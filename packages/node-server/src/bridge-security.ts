import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  isLoopbackOrigin,
  SLICC_HOSTED_ORIGIN,
  SLICC_STAGING_HUB_ORIGIN,
} from '@slicc/shared-ts';

export {
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_HEADER,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
};

export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  SLICC_HOSTED_ORIGIN,
  SLICC_STAGING_HUB_ORIGIN,
  'http://localhost:5710',
  'http://127.0.0.1:5710',
]);

function normalizeDevOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed.toLowerCase();
  while (candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!parsed.protocol || !parsed.hostname) return null;
  } catch {
    return null;
  }
  return candidate;
}

const BRIDGE_DEV_ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const raw = process.env.BRIDGE_DEV_ALLOWED_ORIGINS;
  if (!raw) return new Set<string>();
  const set = new Set<string>();
  for (const entry of raw.split(',')) {
    const normalized = normalizeDevOrigin(entry);
    if (normalized) set.add(normalized);
  }
  return set;
})();

const CORS_BASE_ALLOW_HEADERS = [
  'Content-Type',
  'X-Slicc-Raw-Body',
  'X-Session-Id',
  'X-Bridge-Token',
  'Authorization',
  'X-Target-URL',
  'X-Proxy-Cookie',
  'X-Proxy-Origin',
  'X-Proxy-Referer',
];

const CORS_EXPOSE_HEADERS =
  'Link, X-Proxy-Error, X-Proxy-Set-Cookie, X-Proxy-Content-Length, Mcp-Session-Id, MCP-Protocol-Version';

const CORS_ALLOW_METHODS =
  'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, MKCALENDAR, REPORT, COPY, MOVE, LOCK, UNLOCK';

export function isAllowedBridgeOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (BRIDGE_ALLOWED_ORIGINS.includes(origin)) return true;
  if (BRIDGE_DEV_ALLOWED_ORIGINS.size === 0) return false;
  const normalized = normalizeDevOrigin(origin);
  if (!normalized) return false;
  return BRIDGE_DEV_ALLOWED_ORIGINS.has(normalized);
}

export function isLoopbackBridgeOrigin(origin: string | undefined | null): boolean {
  return isLoopbackOrigin(origin);
}

export function validateBridgeToken(
  presented: string | string[] | undefined,
  expected: string | null
): boolean {
  if (!expected) return false;
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (typeof value !== 'string' || value.length === 0) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function mintBridgeToken(): string {
  return randomUUID();
}

export function resolveServerBridgeToken(
  env: Record<string, string | undefined>,
  opts: { thinBridgeMode: boolean }
): string | null {
  const fromEnv = env['SLICC_BRIDGE_TOKEN'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return opts.thinBridgeMode ? mintBridgeToken() : null;
}

export function shouldMountThinBridgeCors(
  thinBridgeMode: boolean,
  bridgeToken: string | null
): boolean {
  return thinBridgeMode || bridgeToken !== null;
}

export function parseSubprotocolHeader(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const flat = Array.isArray(header) ? header.join(',') : header;
  return flat
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function selectBridgeSubprotocol(
  protocols: readonly string[],
  expectedToken: string
): string | null {
  if (!expectedToken) return null;
  const expected = `${BRIDGE_SUBPROTOCOL_PREFIX}${expectedToken}`;
  return protocols.includes(expected) ? expected : null;
}

export interface BridgeUpgradeGateResult {
  ok: boolean;

  acceptedSubprotocol: string | null;

  reason?: 'origin-not-allowed' | 'subprotocol-missing-or-mismatched';
}

export function validateBridgeUpgrade(input: {
  origin: string | undefined | null;
  subprotocolHeader: string | string[] | undefined;
  expectedToken: string;
}): BridgeUpgradeGateResult {
  if (!isAllowedBridgeOrigin(input.origin)) {
    return { ok: false, acceptedSubprotocol: null, reason: 'origin-not-allowed' };
  }
  const protocols = parseSubprotocolHeader(input.subprotocolHeader);
  const accepted = selectBridgeSubprotocol(protocols, input.expectedToken);
  if (!accepted) {
    return {
      ok: false,
      acceptedSubprotocol: null,
      reason: 'subprotocol-missing-or-mismatched',
    };
  }
  return { ok: true, acceptedSubprotocol: accepted };
}

export function resolveCorsAllowHeaders(requestHeadersHeader: string | undefined | null): string {
  if (!requestHeadersHeader) return CORS_BASE_ALLOW_HEADERS.join(', ');
  const seen = new Set(CORS_BASE_ALLOW_HEADERS.map((h) => h.toLowerCase()));
  const extras: string[] = [];
  for (const raw of requestHeadersHeader.split(',')) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    extras.push(name);
  }
  if (extras.length === 0) return CORS_BASE_ALLOW_HEADERS.join(', ');
  return [...CORS_BASE_ALLOW_HEADERS, ...extras].join(', ');
}

export function buildCorsHeaders(
  origin: string | undefined | null,
  requestHeadersHeader?: string | string[] | null
): Record<string, string> | null {
  if (!isAllowedBridgeOrigin(origin)) return null;
  const reqHeaders = Array.isArray(requestHeadersHeader)
    ? requestHeadersHeader.join(', ')
    : (requestHeadersHeader ?? null);
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': resolveCorsAllowHeaders(reqHeaders),
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
    Vary: 'Origin, Access-Control-Request-Headers',
  };
}

export function buildPnaPreflightHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Private-Network': 'true' };
}

export function preflightMaxAge(path: string): string {
  return path === '/api/hostfs' || path.startsWith('/api/hostfs/') ? '7200' : '600';
}
