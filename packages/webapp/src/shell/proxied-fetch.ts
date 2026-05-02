/**
 * proxied-fetch — shared `SecureFetch` factory.
 *
 * Originally lived inline in `wasm-shell.ts`. Extracted so non-shell callers
 * (e.g. the onboarding orchestrator's direct `installRecommendedSkills`
 * helper) can reuse the same CORS-bypassing fetch without spinning up a
 * full `WasmShell`.
 *
 * Use these helpers instead of bare `fetch()` whenever the caller needs to
 * route through the same code path as `curl`/`upskill` so that:
 *   - CLI mode: requests go through `/api/fetch-proxy` and inherit our
 *     forbidden-header bridging (Cookie, Origin, Referer, Proxy-*).
 *   - Extension mode: requests use direct `fetch()` (CORS bypass via
 *     host_permissions).
 *
 * Binary responses are preserved as raw bytes and (when applicable) cached
 * via `binary-cache` so legacy string-based write paths can still recover
 * the original bytes without UTF-8 corruption.
 */

import type { SecureFetch } from 'just-bash';
import { cacheBinaryBody, cacheBinaryByUrl } from './binary-cache.js';
import { getFetchBodyBytes } from './fetch-body.js';
import { isProxyError, readProxyErrorMessage } from '../core/proxy-error.js';
import {
  encodeForbiddenRequestHeaders as _encodeForbiddenRequestHeaders,
  decodeForbiddenResponseHeaders as _decodeForbiddenResponseHeaders,
  headersToRecord as _headersToRecord,
} from './proxy-headers.js';

/** Check if a content-type header indicates text (safe for UTF-8 decoding). */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return true; // Default to text for unknown types
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('html') ||
    ct.includes('css') ||
    ct.includes('svg')
  );
}

/**
 * Read a fetch Response body as raw bytes.
 *
 * For binary content types, also cache a latin1-keyed copy so older
 * string-based write paths can still recover the original bytes without
 * corruption.
 */
export async function readResponseBody(resp: Response, url?: string): Promise<Uint8Array> {
  const contentType = resp.headers.get('content-type') ?? '';
  const buf = await resp.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!isTextContentType(contentType)) {
    let byteKey = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      byteKey += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    cacheBinaryBody(byteKey, bytes);
    if (url) {
      cacheBinaryByUrl(url, bytes);
    }
  }
  return bytes;
}

/** Convert Headers or Record<string, string> to a plain Record<string, string>. */
export const headersToRecord = _headersToRecord;

/**
 * Multipart form bodies contain latin1-encoded binary file content from curl —
 * convert to raw bytes so fetch() doesn't re-encode as UTF-8.
 */
export function prepareRequestBody(
  body: string | undefined,
  headers?: Record<string, string>
): BodyInit | undefined {
  if (!body) return undefined;
  const ct = headers?.['Content-Type'] ?? headers?.['content-type'] ?? '';
  if (ct.includes('multipart/form-data')) {
    const bytes = getFetchBodyBytes(body) as Uint8Array<ArrayBuffer>;
    return new Blob([bytes]);
  }
  return body;
}

/**
 * Encode request headers that browsers silently strip (forbidden headers).
 * Cookie → X-Proxy-Cookie, Origin → X-Proxy-Origin, Referer → X-Proxy-Referer, Proxy-* → X-Proxy-Proxy-*
 */
export const encodeForbiddenRequestHeaders = _encodeForbiddenRequestHeaders;

/**
 * Decode response headers that the proxy transported under non-forbidden names.
 * X-Proxy-Set-Cookie (JSON array) → set-cookie (JSON array string)
 */
export const decodeForbiddenResponseHeaders = _decodeForbiddenResponseHeaders;

/**
 * Create a SecureFetch that routes requests through the CLI server's
 * /api/fetch-proxy endpoint, bypassing browser CORS restrictions.
 * In extension mode, uses direct fetch (CORS bypass via host_permissions).
 *
 * Binary responses are preserved as raw bytes.
 */
export function createProxiedFetch(): SecureFetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  if (isExtension) {
    // Extension mode — host_permissions grant native CORS bypass
    return async (url, options) => {
      const plainHeaders = headersToRecord(options?.headers);
      const resp = await fetch(url, {
        method: options?.method ?? 'GET',
        headers: plainHeaders,
        body: prepareRequestBody(options?.body, plainHeaders),
      });
      const body = await readResponseBody(resp, url);
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
    };
  }

  // CLI mode — proxy through /api/fetch-proxy
  return async (url, options) => {
    const method = options?.method ?? 'GET';
    const plainHeaders = headersToRecord(options?.headers);
    const encoded = encodeForbiddenRequestHeaders(plainHeaders);
    const headers: Record<string, string> = {
      ...encoded,
      'X-Target-URL': url,
    };

    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (options?.body && !['GET', 'HEAD'].includes(method)) {
      init.body = prepareRequestBody(options.body, headers);
    }

    const resp = await fetch('/api/fetch-proxy', init);

    // Only treat the response as a proxy infrastructure failure when the
    // proxy itself tags it with `X-Proxy-Error: 1`. Upstream 4xx/5xx
    // responses (e.g. Google OAuth's HTTP 400 with `{error:"invalid_client"}`)
    // must flow through to curl/fetch unchanged — otherwise the caller can't
    // distinguish "Google said no" from "the proxy is broken".
    if (isProxyError(resp)) {
      throw new Error(await readProxyErrorMessage(resp));
    }

    const body = await readResponseBody(resp, url);
    const rawHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      rawHeaders[k] = v;
    });
    const respHeaders = decodeForbiddenResponseHeaders(rawHeaders);

    return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
  };
}
