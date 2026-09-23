/**
 * Same-origin relay for pi's hosted model catalogue.
 *
 * `pi update --models` refreshes model lists from
 * `https://pi.dev/api/models/providers/<id>`. That endpoint sends no CORS
 * headers and `Cross-Origin-Resource-Policy: same-origin`, so the webapp cannot
 * read it from the browser. This route fetches it server-side, edge-caches it,
 * and passes the validators (`ETag`, `Last-Modified`) through so the webapp can
 * apply pi's own freshness rules.
 */

import { SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { isAllowedOrigin, jsonResponse } from './shared.js';

export const MODEL_CATALOG_ROUTE_PREFIX = '/api/models/providers/';
export const PI_MODEL_CATALOG_ORIGIN = 'https://pi.dev';

const MODEL_CATALOG_CACHE_TTL_SECONDS = 300;
/** Below the webapp's 4 s client timeout, so a hung origin surfaces as a 502. */
export const MODEL_CATALOG_UPSTREAM_TIMEOUT_MS = 3_000;
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PASSTHROUGH_HEADERS = [
  'content-type',
  'etag',
  'last-modified',
  'x-pi-model-catalog-minimum-version',
  'x-pi-model-catalog-revision',
] as const;

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowedOrigin = origin && isAllowedOrigin(origin) ? origin : SLICC_HOSTED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'If-None-Match',
    'Access-Control-Expose-Headers': 'ETag, Last-Modified',
    Vary: 'Origin',
  };
}

/** The provider id in `/api/models/providers/<id>`, or null for any other path. */
export function modelCatalogProviderId(pathname: string): string | null {
  if (!pathname.startsWith(MODEL_CATALOG_ROUTE_PREFIX)) return null;
  return pathname.slice(MODEL_CATALOG_ROUTE_PREFIX.length);
}

function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || bare(tag) === bare(etag));
}

export async function handleModelCatalogRequest(
  request: Request,
  providerId: string,
  fetchImpl: typeof fetch
): Promise<Response> {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'GET, OPTIONS' });
  }
  if (!PROVIDER_ID_RE.test(providerId)) {
    return jsonResponse({ error: 'invalid_provider' }, 400, cors);
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(
      `${PI_MODEL_CATALOG_ORIGIN}${MODEL_CATALOG_ROUTE_PREFIX}${providerId}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'slicc-tray-hub' },
        signal: AbortSignal.timeout(MODEL_CATALOG_UPSTREAM_TIMEOUT_MS),
        cf: { cacheTtl: MODEL_CATALOG_CACHE_TTL_SECONDS, cacheEverything: true },
      } as RequestInit
    );
  } catch {
    return jsonResponse({ error: 'upstream_unreachable' }, 502, cors);
  }

  // pi treats 501 like 404: this provider has no hosted catalogue.
  if (upstream.status === 404 || upstream.status === 501) {
    return jsonResponse({ error: 'unknown_provider' }, 404, cors);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: 'upstream_error', status: upstream.status }, 502, cors);
  }

  const headers = new Headers(cors);
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', `public, max-age=${MODEL_CATALOG_CACHE_TTL_SECONDS}`);

  if (etagMatches(request.headers.get('If-None-Match'), upstream.headers.get('etag'))) {
    headers.delete('content-type');
    return new Response(null, { status: 304, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}
