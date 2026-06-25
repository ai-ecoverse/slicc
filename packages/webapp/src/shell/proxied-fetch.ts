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

import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';
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

/**
 * Extension id of the thin-bridge leader's extension, used to open a
 * `chrome.runtime.connect(<extensionId>, { name: 'fetch-proxy.fetch' })`
 * Port from the externally-connectable hosted leader page (where
 * `chrome.runtime.id` is undefined but `chrome.runtime.connect` exists).
 * Set in two realms during boot: the page realm (`setupStandalonePrelude`,
 * from the `?ext=<id>` launch param) and the kernel-worker realm
 * (`kernel-worker` boot, forwarded via `KernelWorkerInitMsg`). `null`
 * outside the thin-bridge extension leader (the real extension page uses
 * the id-less `chrome.runtime.connect({ name })` path instead).
 */
let extensionDelegateId: string | null = null;

/**
 * Set the thin-bridge extension delegate id. Pass `null` or an empty
 * string to clear. Mirrors `setBridgeToken` / `setLocalApiBaseUrl`: each
 * realm calls it once during boot.
 */
export function setExtensionDelegateId(id: string | null): void {
  extensionDelegateId = id === null || id === '' ? null : id;
}

/** Test-only accessor for the currently configured extension delegate id. */
export function getExtensionDelegateId(): string | null {
  return extensionDelegateId;
}

/**
 * Resolve a same-origin `/api/*` path to the absolute URL the bridge
 * configuration says to target. With no `setLocalApiBaseUrl` set (legacy
 * bundled-UI, same-origin case) the path is returned unchanged so
 * `fetch(resolveApiUrl('/api/secrets'))` keeps the relative-URL behavior
 * every existing caller expects. In thin-bridge mode (hosted leader on
 * sliccy.ai, local node-server cross-origin) the configured base is
 * prepended so the call reaches the local /api surface. `path` must
 * include the leading slash — we deliberately do not normalize it so
 * accidental `api/...` callers fail loudly instead of producing
 * `${base}api/...`.
 */
export function resolveApiUrl(path: string): string {
  return localApiBaseUrl ? `${localApiBaseUrl}${path}` : path;
}

/**
 * Build the request headers for a same-origin `/api/*` call, layering an
 * optional `extra` overrides record on top of the bridge-token header.
 * `X-Bridge-Token` is attached ONLY when both a bridge token and a local
 * API base are configured (i.e. the cross-origin thin-bridge case). On
 * the legacy same-origin path the token is omitted even if set — the
 * local node-server doesn't require it for loopback origins, and
 * sending it would needlessly leak a session capability. `extra` wins
 * over the bridge token if a caller deliberately overrides it.
 */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bridgeToken && localApiBaseUrl) {
    headers['X-Bridge-Token'] = bridgeToken;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      headers[k] = extra[k];
    }
  }
  return headers;
}

/** Resolve the absolute /api/fetch-proxy URL, honoring `setLocalApiBaseUrl`. */
function resolveFetchProxyUrl(): string {
  return resolveApiUrl('/api/fetch-proxy');
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
const decodeBase64Chunk = base64ToUint8;

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

/** Minimal structural view of the `chrome.runtime` Port the fetch-proxy
 *  uses. Works for both the id-less (`connect({name})`) and explicit-id
 *  (`connect(extensionId, {name})`) Port flavors. */
interface FetchProxyPort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

/** A prepared fetch-proxy `request` envelope ready to post over a Port. */
interface PreparedPortRequest {
  method: string;
  /** Forbidden headers already transport-encoded under X-Proxy-* (once). */
  transportHeaders: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge: boolean;
}

/**
 * Build the fetch-proxy `request` envelope from `SecureFetch` options:
 * encode forbidden headers (Cookie/Origin/Referer/Proxy-*) under X-Proxy-*
 * transport EXACTLY ONCE so the SW can restore them before calling upstream
 * `fetch()` (the CLI proxy uses the same wire format), and base64 the
 * prepared body honoring `REQUEST_BODY_CAP`.
 */
async function buildPortRequest(
  options?: Parameters<SecureFetch>[1]
): Promise<PreparedPortRequest> {
  const plainHeaders = headersToRecord(options?.headers);
  const method = options?.method ?? 'GET';
  const preparedBody = options?.body ? prepareRequestBody(options.body, plainHeaders) : undefined;
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
      bodyBase64 = uint8ToBase64(bodyBytes);
    }
  }

  return { method, transportHeaders, bodyBase64, requestBodyTooLarge };
}

/**
 * Connect a fetch-proxy Port (via the injected `connect`), post the request,
 * and collect the streamed `response-head` + chunks. Resolves the RAW head +
 * concatenated body bytes WITHOUT finalizing — callers decide where the
 * `binary-cache`-populating `finalizeProxyResponse` runs (the page realm for a
 * direct page fetch, the kernel-worker realm for a bridged worker fetch).
 *
 * `connect` is injected so the same collect/stream logic serves both the
 * real extension page (`chrome.runtime.connect({ name })`) and the thin-bridge
 * leader page (`chrome.runtime.connect(extensionId, { name })`).
 */
async function collectViaPort(
  connect: () => FetchProxyPort,
  url: string,
  options?: Parameters<SecureFetch>[1]
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  const { method, transportHeaders, bodyBase64, requestBodyTooLarge } =
    await buildPortRequest(options);
  const port = connect();

  return new Promise((resolve, reject) => {
    let headInfo: ProxyHead | null = null;
    let ended = false;
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as ResponseMsg;
      if (msg.type === 'response-head') {
        headInfo = { status: msg.status, statusText: msg.statusText, headers: msg.headers };
      } else if (msg.type === 'response-chunk') {
        chunks.push(decodeBase64Chunk(msg.dataBase64));
      } else if (msg.type === 'response-end') {
        ended = true;
        if (!headInfo) {
          reject(new Error('fetch-proxy: response-end before response-head'));
          return;
        }
        resolve({ head: headInfo, body: concatChunks(chunks).buffer });
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

async function extensionPortFetch(
  url: string,
  options?: Parameters<SecureFetch>[1]
): ReturnType<SecureFetch> {
  // readResponseBody (inside finalizeProxyResponse) decides text vs binary
  // (binary goes to binary-cache; preserves git-http's binary packfile path);
  // forbidden response headers are decoded back to their browser-stripped
  // names — matches the CLI client.
  const { head, body } = await collectViaPort(
    () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' }),
    url,
    options
  );
  return finalizeProxyResponse(head, new Uint8Array(body), url);
}

/**
 * Page-realm helper for the thin-bridge leader tab: open a fetch-proxy Port
 * to the extension by its EXPLICIT id (the externally-connectable page has
 * `chrome.runtime.connect` but no `chrome.runtime.id`) and collect the RAW
 * streamed response. Used by the `proxied-fetch` panel-RPC handler so the
 * worker realm (which has no `chrome`) can reach the extension through the
 * page. Returns raw head + body bytes — the WORKER finalizes them so its own
 * `binary-cache` is populated, NOT the page's.
 */
export async function collectViaExtensionDelegate(
  url: string,
  options?: Parameters<SecureFetch>[1]
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  const id = extensionDelegateId;
  if (!id) {
    throw new Error('proxied-fetch: no extension delegate id configured');
  }
  const connect = (
    chrome.runtime as unknown as {
      connect: (extensionId: string, info: { name: string }) => FetchProxyPort;
    }
  ).connect;
  return collectViaPort(() => connect(id, { name: 'fetch-proxy.fetch' }), url, options);
}

/**
 * Create a SecureFetch that routes requests through the CLI server's
 * /api/fetch-proxy endpoint, bypassing browser CORS restrictions.
 * In extension mode, uses direct fetch (CORS bypass via host_permissions).
 *
 * Binary responses are preserved as raw bytes.
 */
export function createProxiedFetch(): SecureFetch {
  // 1. Real extension page (offscreen / options): `chrome.runtime.id` is
  //    truthy. Use the id-less Port connect — UNCHANGED.
  if (typeof chrome !== 'undefined' && chrome?.runtime?.id) {
    return extensionPortFetch;
  }

  // 2. Thin-bridge leader PAGE realm: `chrome.runtime.connect` exists but
  //    `chrome.runtime.id` is undefined (externally-connectable web origin).
  //    Connect to the extension by its explicit delegate id and finalize on
  //    the page (page-realm binary-cache for direct page callers).
  if (
    typeof chrome !== 'undefined' &&
    typeof chrome?.runtime?.connect === 'function' &&
    extensionDelegateId
  ) {
    return async (url, options) => {
      const { head, body } = await collectViaExtensionDelegate(url, options);
      return finalizeProxyResponse(head, new Uint8Array(body), url);
    };
  }

  // 3. Kernel-worker realm: no `chrome` at all, but a delegate id was
  //    forwarded at boot. Bridge the fetch to the page realm over panel-RPC
  //    (the page opens the extension Port via #2's collector), then finalize
  //    the bytes HERE so the worker's own binary-cache is populated.
  if (typeof chrome === 'undefined' && extensionDelegateId) {
    return async (url, options) => {
      // Lazy import so panel-rpc isn't pulled into non-worker bundles.
      const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
      const client = getPanelRpcClient();
      if (!client) {
        throw new Error('proxied-fetch: panel-RPC client unavailable in worker realm');
      }
      const method = options?.method ?? 'GET';
      // Forward PLAIN headers + the raw SecureFetch body string; the
      // page-side collector encodes forbidden headers exactly once and
      // prepares the body via the same `prepareRequestBody` contract.
      const plainHeaders = headersToRecord(options?.headers) ?? {};
      const { head, body } = await client.call(
        'proxied-fetch',
        { url, method, headers: plainHeaders, body: options?.body },
        // Generous timeout — multi-MB wasm / package downloads outlast the
        // panel-RPC default 15s.
        { timeoutMs: 120_000 }
      );
      return finalizeProxyResponse(head, new Uint8Array(body), url);
    };
  }

  // 4. CLI mode — proxy through /api/fetch-proxy
  return async (url, options) => {
    const method = options?.method ?? 'GET';
    const plainHeaders = headersToRecord(options?.headers);
    const encoded = encodeForbiddenRequestHeaders(plainHeaders);
    // Thin-bridge: cross-origin /api/* from a remote allowlisted leader
    // (sliccy.ai) needs the per-process bridge token. `apiHeaders` only
    // attaches it when both base + token are set, so same-origin /
    // loopback callers don't carry it (and the local node-server only
    // requires it for non-loopback origins anyway).
    const headers: Record<string, string> = apiHeaders({
      ...encoded,
      'X-Target-URL': url,
    });

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
