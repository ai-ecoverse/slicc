/**
 * proxied-fetch — shared `SecureFetch` factory.
 *
 * Originally lived inline in `almost-bash-shell.ts`. Extracted so non-shell callers
 * (e.g. the onboarding orchestrator's direct `installRecommendedSkills`
 * helper) can reuse the same CORS-bypassing fetch without spinning up a
 * full `AlmostBashShell`.
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
import type { ResponseMsg } from '../../../chrome-extension/src/fetch-proxy-shared.js';
import { isProxyError, readProxyErrorMessage } from '../core/proxy-error.js';
import { cacheBinaryBody, cacheBinaryByUrl } from './binary-cache.js';
import { getFetchBodyBytes } from './fetch-body.js';
import {
  decodeForbiddenResponseHeaders as _decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders as _encodeForbiddenRequestHeaders,
  headersToRecord as _headersToRecord,
} from './proxy-headers.js';

const REQUEST_BODY_CAP = 32 * 1024 * 1024;

/**
 * Optional absolute origin (e.g. `http://localhost:5710`) the CLI mode
 * should prepend to `/api/fetch-proxy`. Set in thin-bridge mode where
 * the hosted leader (sliccy.ai) serves the UI cross-origin but has no
 * local /api surface — the bridge launch params carry the local
 * node-server origin, which is wired here via `setLocalApiBaseUrl`.
 * Page realm and kernel-worker realm have independent module instances;
 * each calls the setter once during boot.
 */
let localApiBaseUrl: string | null = null;

/**
 * Per-process bridge token paired with `localApiBaseUrl`. When set, the
 * CLI-mode fetcher attaches it as the `X-Bridge-Token` header so the
 * local node-server's thin-bridge middleware accepts the cross-origin
 * call — the origin allowlist alone is insufficient because any script
 * on a remote allowlisted origin (e.g. `https://www.sliccy.ai`) would
 * otherwise reach /api unchallenged. Treat as a session capability:
 * never log, never put on a URL, never expose via a Referer.
 */
let bridgeToken: string | null = null;

/**
 * Set the absolute origin CLI-mode proxied fetches should target. Pass
 * `null` to fall back to same-origin (the legacy bundled-UI path).
 * Trailing slashes are trimmed so we never double-slash the path.
 */
export function setLocalApiBaseUrl(baseUrl: string | null): void {
  if (baseUrl === null || baseUrl === '') {
    localApiBaseUrl = null;
    return;
  }
  localApiBaseUrl = baseUrl.replace(/\/+$/, '');
}

/** Test-only accessor for the currently configured local API base. */
export function getLocalApiBaseUrl(): string | null {
  return localApiBaseUrl;
}

/**
 * Set the per-process bridge token CLI-mode proxied fetches should send
 * as `X-Bridge-Token` on cross-origin /api/fetch-proxy calls. Pass `null`
 * or an empty string to clear. Called from the boot path (page realm via
 * `setupStandalonePrelude`, worker realm via `kernel-worker`) once the
 * `bridgeToken` launch param has been parsed.
 */
export function setBridgeToken(token: string | null): void {
  bridgeToken = token === null || token === '' ? null : token;
}

/** Test-only accessor for the currently configured bridge token. */
export function getBridgeToken(): string | null {
  return bridgeToken;
}

/** Resolve the absolute /api/fetch-proxy URL, honoring `setLocalApiBaseUrl`. */
function resolveFetchProxyUrl(): string {
  return localApiBaseUrl ? `${localApiBaseUrl}/api/fetch-proxy` : '/api/fetch-proxy';
}

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
 * Bodies that are NOT text-shaped (multipart form payloads, git packfiles,
 * application/octet-stream, etc.) reach this layer as latin1-encoded strings
 * (one char per byte) — the convention upstream callers use to thread binary
 * data through `SecureFetch`'s `body: string` contract. `fetch()` would
 * UTF-8-re-encode such a string, expanding every byte ≥0x80 to two bytes
 * and corrupting the payload (git push fails for any repo with deflated
 * objects). Convert back to raw bytes via `getFetchBodyBytes` and ship as
 * a Blob so the binary survives intact.
 */
export function prepareRequestBody(
  body: string | undefined,
  headers?: Record<string, string>
): BodyInit | undefined {
  if (!body) return undefined;
  const ct = headers?.['Content-Type'] ?? headers?.['content-type'] ?? '';
  if (!isTextContentType(ct)) {
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

/** Decode a base64 `response-chunk` payload into raw bytes. */
function decodeBase64Chunk(dataBase64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(dataBase64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Concatenate accumulated response chunks into a single byte buffer. */
function concatChunks(chunks: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

type ProxyHead = { status: number; statusText: string; headers: Record<string, string> };

/**
 * Build the `SecureFetch` result from a completed streamed response: wrap the
 * merged bytes in a synthetic `Response` (so `readResponseBody` applies the
 * text/binary split + binary-cache path) and decode forbidden response headers.
 */
async function finalizeProxyResponse(
  headInfo: ProxyHead,
  merged: Uint8Array<ArrayBuffer>,
  url: string
): Promise<Awaited<ReturnType<SecureFetch>>> {
  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(headInfo.headers)) respHeaders.set(k, String(v));
  const synth = new Response(merged, {
    status: headInfo.status,
    statusText: headInfo.statusText,
    headers: respHeaders,
  });
  const body = await readResponseBody(synth, url);
  return {
    status: headInfo.status,
    statusText: headInfo.statusText,
    headers: decodeForbiddenResponseHeaders(headInfo.headers),
    body,
    url,
  };
}

async function extensionPortFetch(
  url: string,
  options?: Parameters<SecureFetch>[1]
): ReturnType<SecureFetch> {
  const port = chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
  const plainHeaders = headersToRecord(options?.headers);
  const method = options?.method ?? 'GET';
  const preparedBody = options?.body ? prepareRequestBody(options.body, plainHeaders) : undefined;
  // Encode forbidden headers (Cookie/Origin/Referer/Proxy-*) under X-Proxy-*
  // transport so the SW can restore them before calling upstream `fetch()` —
  // same wire format the CLI proxy uses. Without this the SW silently
  // strips them at the browser fetch boundary.
  const transportHeaders = encodeForbiddenRequestHeaders(plainHeaders);

  let bodyBase64: string | undefined;
  let requestBodyTooLarge = false;
  if (preparedBody !== undefined) {
    const bodyBytes =
      preparedBody instanceof Uint8Array
        ? preparedBody
        : new Uint8Array(await new Response(preparedBody as BodyInit).arrayBuffer());
    if (bodyBytes.byteLength > REQUEST_BODY_CAP) {
      requestBodyTooLarge = true;
    } else {
      let bin = '';
      for (let i = 0; i < bodyBytes.length; i++) bin += String.fromCharCode(bodyBytes[i]);
      bodyBase64 = btoa(bin);
    }
  }

  return new Promise((resolve, reject) => {
    let headInfo: ProxyHead | null = null;
    let ended = false;
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as ResponseMsg;
      if (msg.type === 'response-head') {
        headInfo = msg;
      } else if (msg.type === 'response-chunk') {
        chunks.push(decodeBase64Chunk(msg.dataBase64));
      } else if (msg.type === 'response-end') {
        ended = true;
        if (!headInfo) {
          reject(new Error('fetch-proxy: response-end before response-head'));
          return;
        }
        // readResponseBody decides text vs binary (binary goes to binary-cache;
        // preserves git-http's binary packfile path); forbidden response headers
        // are decoded back to their browser-stripped names — matches CLI client.
        finalizeProxyResponse(headInfo, concatChunks(chunks), url).then(resolve).catch(reject);
        port.disconnect();
      } else if (msg.type === 'response-error') {
        ended = true;
        reject(new Error(msg.error));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      // Three disconnect scenarios:
      //   1. Before response-head — caller's promise stays pending forever
      //      unless we reject explicitly.
      //   2. After response-head but before response-end — partial response
      //      received; the chunks accumulated so far would otherwise be
      //      silently discarded. Reject so the caller sees a clear error.
      //   3. After response-end — we initiated the disconnect; do nothing
      //      (the promise has already resolved).
      if (ended) return;
      if (!headInfo) {
        reject(new Error('fetch-proxy port disconnected before response'));
      } else {
        reject(new Error('fetch-proxy port disconnected mid-stream'));
      }
    });

    port.postMessage({
      type: 'request',
      url,
      method,
      headers: transportHeaders,
      bodyBase64,
      requestBodyTooLarge,
    });
  });
}

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
    return extensionPortFetch;
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
    // Thin-bridge: cross-origin /api/* from a remote allowlisted leader
    // (sliccy.ai) needs the per-process bridge token. Only attach when
    // there is one — same-origin / loopback callers don't need it and
    // the local node-server only requires it for non-loopback origins.
    if (bridgeToken && localApiBaseUrl) {
      headers['X-Bridge-Token'] = bridgeToken;
    }

    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (options?.body && !['GET', 'HEAD'].includes(method)) {
      init.body = prepareRequestBody(options.body, headers);
    }

    const resp = await fetch(resolveFetchProxyUrl(), init);

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
