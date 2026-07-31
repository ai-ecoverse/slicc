/**
 * Centrally authored feature flags for SLICC floats.
 *
 * `FEATURE_FLAGS` is a Wrangler JSON var shaped as
 * `{ base: Record<string, string>, floats: Record<string, Record<string, string>> }`.
 * Per-float values overlay `base`. A future KV/R2 source can replace the config
 * input without changing the response contract or resolution rules.
 */

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { isAllowedOrigin } from './oauth-exchange.js';
import { jsonResponse } from './shared.js';

const FLAGS_CACHE_TTL_SECONDS = 300;
const DEFAULT_FLOAT = 'default';
const FALLBACK_BASE_FLAGS: Record<string, string> = {
  'experimental-settings': 'on',
};

export interface ResolvedFlags {
  float: string;
  flags: Record<string, string>;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringRecord(value: unknown): Record<string, string> | null {
  const record = objectRecord(value);
  if (!record || Object.values(record).some((entry) => typeof entry !== 'string')) return null;
  return record as Record<string, string>;
}

/** Resolve a requested float, falling back to the base profile on any invalid config. */
export function resolveFlags(config: unknown, requestedFloat: string | null): ResolvedFlags {
  const root = objectRecord(config);
  const base = stringRecord(root?.base) ?? FALLBACK_BASE_FLAGS;
  const floats = objectRecord(root?.floats);
  if (!requestedFloat || !floats || !Object.hasOwn(floats, requestedFloat)) {
    return { float: DEFAULT_FLOAT, flags: { ...base } };
  }

  const overlay = stringRecord(floats[requestedFloat]);
  if (!overlay) return { float: DEFAULT_FLOAT, flags: { ...base } };
  return { float: requestedFloat, flags: { ...base, ...overlay } };
}

function flagsCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && isAllowedOrigin(origin) ? origin : SLICC_HOSTED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function withFlagsCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(flagsCorsHeaders(request))) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function flagsCacheKey(request: Request, float: string): Request {
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('float', float);
  return new Request(url.toString(), { method: 'GET' });
}

async function readCachedFlags(key: Request): Promise<Response | null> {
  const cachesGlobal = (globalThis as { caches?: CacheStorage }).caches;
  if (!cachesGlobal) return null;
  try {
    return (await cachesGlobal.default.match(key)) ?? null;
  } catch {
    return null;
  }
}

async function cacheFlags(key: Request, response: Response): Promise<void> {
  const cachesGlobal = (globalThis as { caches?: CacheStorage }).caches;
  if (!cachesGlobal) return;
  try {
    await cachesGlobal.default.put(key, response.clone());
  } catch {
    // Cache failures must never make public configuration unavailable.
  }
}

export async function handleFlagsRequest(request: Request, config: unknown): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: flagsCorsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, {
      ...flagsCorsHeaders(request),
      Allow: 'GET, OPTIONS',
    });
  }

  const url = new URL(request.url);
  const resolved = resolveFlags(config, url.searchParams.get('float'));
  const cacheKey = flagsCacheKey(request, resolved.float);
  const cached = await readCachedFlags(cacheKey);
  if (cached) return withFlagsCors(cached, request);

  const response = jsonResponse(resolved, 200, {
    'Cache-Control': `public, max-age=${FLAGS_CACHE_TTL_SECONDS}`,
  });
  await cacheFlags(cacheKey, response);
  return withFlagsCors(response, request);
}
