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

import {
  base64ToUint8,
  type FetchProxyResponseMsg,
  isTextContentType,
  uint8ToBase64,
} from '@slicc/shared-ts';
import type { SecureFetch } from 'just-bash';
import { cacheBinaryBody, cacheBinaryByUrl } from './binary-cache.js';
import { getFetchBodyBytes, type SecureFetchRequestBody } from './fetch-body.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';
import {
  decodeForbiddenResponseHeaders as _decodeForbiddenResponseHeaders,
  encodeForbiddenRequestHeaders as _encodeForbiddenRequestHeaders,
  headersToRecord as _headersToRecord,
} from './proxy-headers.js';

/**
 * Ceiling on a proxied REQUEST body. Exported so the CapabilityBroker's REST
 * adapter (#2276) enforces the same number as the Port legs below rather than
 * inventing a second one.
 */
export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

/**
 * Ceiling on a single proxied response body. Every realm branch buffers the
 * whole body in the renderer (the `SecureFetch` contract hands just-bash a
 * complete `Uint8Array`, and the VFS keeps a copy in its vnode cache until the
 * write syncs), so one download costs a small multiple of its size in RAM.
 * Past this point a download is far more likely to take the leader tab down
 * than to finish, so it fails early with a clear error instead. Checked
 * against the size hint before anything is allocated and again while the
 * bytes stream in (a hint can be absent or wrong).
 */
const DEFAULT_RESPONSE_BODY_CAP = 512 * 1024 * 1024;
let responseBodyCap = DEFAULT_RESPONSE_BODY_CAP;

/**
 * Override the response-body ceiling (`null` restores the default). Exposed
 * for tests and for floats that know their memory budget; not a per-request
 * knob.
 */
export function setResponseBodyCap(bytes: number | null): void {
  responseBodyCap = bytes === null ? DEFAULT_RESPONSE_BODY_CAP : bytes;
}

/** Current response-body ceiling in bytes. */
export function getResponseBodyCap(): number {
  return responseBodyCap;
}

/**
 * Bodies above this size are not parked in `binary-cache`. The cache exists
 * so legacy string-keyed write paths can recover exact bytes; its consumers
 * all fall back to the `Uint8Array` body just-bash already receives, so
 * skipping it only means a large download is not pinned for the cache's 10s
 * expiry window on top of the copies the write path already holds.
 */
export const BINARY_CACHE_BODY_CAP = 32 * 1024 * 1024;

/** Build the error every branch throws when a body exceeds the ceiling. */
export function responseTooLargeError(url: string, size: number | undefined): Error {
  const limitMiB = Math.round(responseBodyCap / (1024 * 1024));
  const sizeNote = size === undefined ? '' : ` (${size} bytes)`;
  return new Error(
    `proxied-fetch: response body for ${url} exceeds the ${limitMiB} MiB download limit${sizeNote}; ` +
      'download it in ranges (curl -r) or from a native float'
  );
}

/** Statuses that forbid a body argument on the `Response` constructor. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Bridge endpoint configuration lives in `base/api-endpoint.ts` so the `fs/`
 * layer can read it without importing up the stack. Re-exported here because
 * this module has always been its public address.
 */
import {
  apiHeaders,
  getChromeExtensionRealm,
  getExtensionDelegateId,
  resolveApiUrl,
} from '../base/api-endpoint.js';

export {
  apiHeaders,
  getBridgeToken,
  getChromeExtensionRealm,
  getExtensionDelegateId,
  getLocalApiBaseUrl,
  resolveApiUrl,
  setBridgeToken,
  setChromeExtensionRealm,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../base/api-endpoint.js';

/** Resolve the absolute /api/fetch-proxy URL, honoring `setLocalApiBaseUrl`. */
function resolveFetchProxyUrl(): string {
  return resolveApiUrl('/api/fetch-proxy');
}

/** Shared content-type predicate, re-exported for backwards compatibility. */
export { isTextContentType };

/**
 * Read a fetch Response body as raw bytes.
 *
 * For binary content types, also cache a latin1-keyed copy so older
 * string-based write paths can still recover the original bytes without
 * corruption.
 */
export async function readResponseBody(
  resp: Response,
  url?: string,
  onChunk?: (loaded: number) => void,
  expectedLength?: number
): Promise<Uint8Array> {
  const contentType = resp.headers.get('content-type') ?? '';
  const hinted = expectedLength ?? contentLengthOf(resp.headers);
  if (hinted !== undefined && hinted > responseBodyCap) {
    await resp.body?.cancel().catch(() => undefined);
    throw responseTooLargeError(url ?? resp.url, hinted);
  }
  const bytes = await readBodyBytes(resp, url ?? resp.url, onChunk, hinted);
  parkBinaryBody(bytes, contentType, url);
  return bytes;
}

/**
 * Park a binary body in `binary-cache` so legacy string-keyed write paths can
 * recover the exact bytes. Bodies past the cache ceiling are not parked (see
 * `BINARY_CACHE_BODY_CAP`); text bodies never are.
 */
function parkBinaryBody(bytes: Uint8Array, contentType: string, url?: string): void {
  if (isTextContentType(contentType) || bytes.byteLength > BINARY_CACHE_BODY_CAP) return;
  // Prefer the URL cache (the common case) — it avoids the multi-MB latin1
  // string allocation. VfsAdapter.writeFile still recovers exact bytes on
  // that path via its charCodeAt latin1 fallback. Only build the full-body
  // latin1 string when there is no URL to key on.
  if (url) {
    cacheBinaryByUrl(url, bytes);
    return;
  }
  let byteKey = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    byteKey += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  cacheBinaryBody(byteKey, bytes);
}

/**
 * Drain a Response body chunk by chunk (so the size ceiling is enforced as
 * bytes arrive, not after they have all been buffered), reporting the
 * cumulative byte count to `onChunk` when given. Bodiless responses fall
 * back to `arrayBuffer()`.
 */
async function readBodyBytes(
  resp: Response,
  url: string,
  onChunk?: (loaded: number) => void,
  expectedLength?: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  // Memory: a multi-hundred-MB `curl -o` already costs several copies
  // downstream (latin1 string, binary-cache, IndexedDB). Keeping chunks AND a
  // merged copy here would add one more transient copy at the peak, so when
  // the size is known we write straight into a preallocated buffer and only
  // fall back to chunk+concat when it is unknown or the hint was wrong.
  let target =
    expectedLength !== undefined && expectedLength > 0 ? new Uint8Array(expectedLength) : null;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array<ArrayBuffer>;
    if (target) {
      if (loaded + chunk.byteLength <= target.byteLength) {
        target.set(chunk, loaded);
      } else {
        // Hint was too small: demote to chunk mode without losing what we have.
        chunks.push(target.subarray(0, loaded) as Uint8Array<ArrayBuffer>, chunk);
        target = null;
      }
    } else {
      chunks.push(chunk);
    }
    loaded += chunk.byteLength;
    if (loaded > responseBodyCap) {
      await reader.cancel().catch(() => undefined);
      throw responseTooLargeError(url, undefined);
    }
    onChunk?.(loaded);
  }
  if (target) return loaded === target.byteLength ? target : target.slice(0, loaded);
  return concatChunks(chunks);
}

/** Convert Headers or Record<string, string> to a plain Record<string, string>. */
export const headersToRecord = _headersToRecord;

/**
 * Observer for download progress of one proxied fetch. `total` is the
 * upstream byte count when known (`content-length` on the raw Port path,
 * the proxy's `X-Proxy-Content-Length` hint on the CLI path), else
 * undefined. `loaded` is cumulative. `end` always fires, also on failure.
 */
export interface FetchProgressObserver {
  start(url: string, total: number | undefined): void;
  chunk(url: string, loaded: number, total: number | undefined): void;
  end(url: string): void;
}

export interface ProxiedFetchOptions {
  /** Download-progress observer (bash progress overlay). */
  progress?: FetchProgressObserver;
}

/** Header carrying the exact upstream size on the CLI proxy path. */
export const PROXY_CONTENT_LENGTH_HEADER = 'x-proxy-content-length';

function contentLengthOf(headers: Record<string, string> | Headers): number | undefined {
  const get = (name: string) =>
    headers instanceof Headers
      ? headers.get(name)
      : (Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null);
  const raw = get(PROXY_CONTENT_LENGTH_HEADER) ?? get('content-length');
  if (raw === null || raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Run a collector so the observer's `end` fires on every exit path. */
async function withProgressEnd<T>(
  progress: FetchProgressObserver | undefined,
  url: string,
  run: () => Promise<T>
): Promise<T> {
  if (!progress) return run();
  try {
    return await run();
  } finally {
    progress.end(url);
  }
}

/**
 * Bodies that are NOT text-shaped (multipart form payloads, git packfiles,
 * application/octet-stream, etc.) reach this layer either as a `Uint8Array`
 * (the jsh `fetch` adapter — never a JS string, so native `fetch` cannot
 * UTF-8-expand high bytes) or as a latin1-encoded string (one char per byte)
 * from just-bash `curl` / git. `fetch()` would UTF-8-re-encode a latin1
 * string, expanding every byte ≥0x80 to two bytes and corrupting the payload
 * (git push fails for any repo with deflated objects; a JPEG SOI `FF D8`
 * becomes `C3 BF C3 98`). Convert strings back to raw bytes via
 * `getFetchBodyBytes` when the Content-Type is not text-shaped, and wrap
 * `Uint8Array` bodies in a Blob unconditionally, so the binary survives.
 */
export function prepareRequestBody(
  body: SecureFetchRequestBody | undefined,
  headers?: Record<string, string>
): BodyInit | undefined {
  if (body == null || body === '') return undefined;
  // Already bytes: the caller resolved the encoding itself (jsh fetch and
  // the CapabilityBroker adapters). Wrap as Blob unconditionally — native
  // `fetch` cannot UTF-8-expand a Blob, and lib.dom's `BodyInit` omits
  // `Uint8Array`. Content-Type is irrelevant here.
  if (typeof body !== 'string') {
    return new Blob([body as Uint8Array<ArrayBuffer>]);
  }
  const ct =
    Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  if (ct && !isTextContentType(ct)) {
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
 * `SecureFetch` request options, widened so a caller may supply pre-resolved
 * request BYTES. `just-bash`'s own `body` is a `string` (binary threaded as
 * latin1); the CapabilityBroker adapters resolve their bytes up front so both
 * of their transports send the same ones.
 */
export type ProxyRequestOptions = Omit<NonNullable<Parameters<SecureFetch>[1]>, 'body'> & {
  body?: string | Uint8Array;
};

/**
 * Build the `SecureFetch` result from a completed streamed response: apply
 * the text/binary split + binary-cache path to the merged bytes and decode
 * forbidden response headers. The bytes are used as-is — wrapping them in a
 * synthetic `Response` and reading that back (the previous shape) cost a
 * second full copy of every download. Null-body statuses (101/103/204/205/
 * 304) carry no body by definition, so they resolve to an empty array.
 */
function finalizeProxyResponse(
  headInfo: ProxyHead,
  merged: Uint8Array<ArrayBuffer>,
  url: string
): Awaited<ReturnType<SecureFetch>> {
  const respHeaders = new Headers();
  for (const [k, v] of Object.entries(headInfo.headers)) respHeaders.set(k, String(v));
  const body = NULL_BODY_STATUSES.has(headInfo.status) ? new Uint8Array(0) : merged;
  parkBinaryBody(body, respHeaders.get('content-type') ?? '', url);
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
async function buildPortRequest(options?: ProxyRequestOptions): Promise<PreparedPortRequest> {
  const plainHeaders = headersToRecord(options?.headers);
  const method = options?.method ?? 'GET';
  const preparedBody = options?.body
    ? prepareRequestBody(options.body as SecureFetchRequestBody, plainHeaders)
    : undefined;
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
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  const { method, transportHeaders, bodyBase64, requestBodyTooLarge } =
    await buildPortRequest(options);
  const port = connect();

  return new Promise((resolve, reject) => {
    let headInfo: ProxyHead | null = null;
    let ended = false;
    let loaded = 0;
    let total: number | undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    // Abort the transfer from our side: drop the buffered chunks, disconnect
    // (which stops the SW streaming into a Port nobody reads) and reject
    // exactly once — `ended` also mutes the onDisconnect rejection.
    const fail = (err: Error) => {
      ended = true;
      chunks.length = 0;
      reject(err);
      port.disconnect();
    };

    const onHead = (msg: Extract<FetchProxyResponseMsg, { type: 'response-head' }>) => {
      headInfo = { status: msg.status, statusText: msg.statusText, headers: msg.headers };
      total = contentLengthOf(msg.headers);
      if (total !== undefined && total > responseBodyCap) {
        fail(responseTooLargeError(url, total));
        return;
      }
      progress?.start(url, total);
    };
    const onChunk = (msg: Extract<FetchProxyResponseMsg, { type: 'response-chunk' }>) => {
      if (ended) return;
      const chunk = decodeBase64Chunk(msg.dataBase64);
      loaded += chunk.byteLength;
      if (loaded > responseBodyCap) {
        fail(responseTooLargeError(url, undefined));
        return;
      }
      chunks.push(chunk);
      progress?.chunk(url, loaded, total);
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      if (!headInfo) {
        reject(new Error('fetch-proxy: response-end before response-head'));
        return;
      }
      resolve({ head: headInfo, body: concatChunks(chunks).buffer });
      port.disconnect();
    };

    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as FetchProxyResponseMsg;
      if (msg.type === 'response-head') onHead(msg);
      else if (msg.type === 'response-chunk') onChunk(msg);
      else if (msg.type === 'response-end') onEnd();
      else if (msg.type === 'response-error') fail(new Error(msg.error));
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
 * Extension-realm sibling of {@link collectViaExtensionDelegate}: the same
 * collector over the ID-LESS `chrome.runtime.connect({ name })` available to
 * a real extension page (offscreen / side panel / options). Returns the RAW
 * head + body bytes, so a caller that wants an envelope rather than a
 * binary-cache-populating `SecureFetch` response (the `extension-direct`
 * CapabilityBroker adapter, #2276) can build one itself.
 */
export function collectViaExtensionPort(
  url: string,
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  return collectViaPort(
    () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' }),
    url,
    options,
    progress
  );
}

async function extensionPortFetch(
  url: string,
  options?: Parameters<SecureFetch>[1],
  progress?: FetchProgressObserver
): ReturnType<SecureFetch> {
  // readResponseBody (inside finalizeProxyResponse) decides text vs binary
  // (binary goes to binary-cache; preserves git-http's binary packfile path);
  // forbidden response headers are decoded back to their browser-stripped
  // names — matches the CLI client.
  const { head, body } = await withProgressEnd(progress, url, () =>
    collectViaExtensionPort(url, options, progress)
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
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  const id = getExtensionDelegateId();
  if (!id) {
    throw new Error('proxied-fetch: no extension delegate id configured');
  }
  const connect = (
    chrome.runtime as unknown as {
      connect: (extensionId: string, info: { name: string }) => FetchProxyPort;
    }
  ).connect;
  return collectViaPort(() => connect(id, { name: 'fetch-proxy.fetch' }), url, options, progress);
}

/**
 * Create a SecureFetch that routes requests through the CLI server's
 * /api/fetch-proxy endpoint, bypassing browser CORS restrictions.
 * In extension mode, uses direct fetch (CORS bypass via host_permissions).
 *
 * Binary responses are preserved as raw bytes.
 */
export function createProxiedFetch(fetchOptions: ProxiedFetchOptions = {}): SecureFetch {
  const progress = fetchOptions.progress;
  // 1. Real extension page (offscreen / options): `chrome.runtime.id` is
  //    truthy. Use the id-less Port connect — UNCHANGED. Reads the realm's
  //    cached answer (`base/api-endpoint.ts`) rather than probing directly
  //    (#2276): the fact is resolved once per realm, not re-checked per call.
  if (getChromeExtensionRealm()) {
    return (url, options) => extensionPortFetch(url, options, progress);
  }

  // 2. Thin-bridge leader PAGE realm: `chrome.runtime.connect` exists but
  //    `chrome.runtime.id` is undefined (externally-connectable web origin).
  //    Connect to the extension by its explicit delegate id and finalize on
  //    the page (page-realm binary-cache for direct page callers).
  if (
    typeof chrome !== 'undefined' &&
    typeof chrome?.runtime?.connect === 'function' &&
    getExtensionDelegateId()
  ) {
    return async (url, options) => {
      const { head, body } = await withProgressEnd(progress, url, () =>
        collectViaExtensionDelegate(url, options, progress)
      );
      return finalizeProxyResponse(head, new Uint8Array(body), url);
    };
  }

  // 3. Kernel-worker realm: no `chrome` at all, but a delegate id was
  //    forwarded at boot. Bridge the fetch to the page realm over panel-RPC
  //    (the page opens the extension Port via #2's collector), then finalize
  //    the bytes HERE so the worker's own binary-cache is populated.
  if (typeof chrome === 'undefined' && getExtensionDelegateId()) {
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
      // The page realm collects the chunks; the worker only sees the whole
      // body, so this path reports an indeterminate in-flight unit.
      progress?.start(url, undefined);
      const { head, body } = await withProgressEnd(progress, url, () =>
        client.call(
          'proxied-fetch',
          {
            url,
            method,
            headers: plainHeaders,
            body: options?.body as string | Uint8Array | undefined,
          },
          // Generous timeout — multi-MB wasm / package downloads outlast the
          // panel-RPC default 15s.
          { timeoutMs: 120_000 }
        )
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
      const prepared = prepareRequestBody(
        options.body as SecureFetchRequestBody | undefined,
        headers
      );
      // Skip the global express.json() parser on the proxy hop. Binary
      // Content-Types already skip it, but a Blob with no CT (or a JSON
      // file uploaded as bytes) must still arrive byte-for-byte.
      if (prepared instanceof Blob) {
        headers['X-Slicc-Raw-Body'] = '1';
      }
      init.body = prepared;
    }

    return withProgressEnd(progress, url, async () => {
      const resp = await fetch(resolveFetchProxyUrl(), init);

      // Only treat the response as a proxy infrastructure failure when the
      // proxy itself tags it with `X-Proxy-Error: 1`. Upstream 4xx/5xx
      // responses (e.g. Google OAuth's HTTP 400 with `{error:"invalid_client"}`)
      // must flow through to curl/fetch unchanged — otherwise the caller can't
      // distinguish "Google said no" from "the proxy is broken".
      if (isProxyError(resp)) {
        throw new Error(await readProxyErrorMessage(resp));
      }

      const total = contentLengthOf(resp.headers);
      progress?.start(url, total);
      const body = await readResponseBody(
        resp,
        url,
        progress ? (loaded) => progress.chunk(url, loaded, total) : undefined,
        total
      );
      const rawHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        rawHeaders[k] = v;
      });
      const respHeaders = decodeForbiddenResponseHeaders(rawHeaders);

      return { status: resp.status, statusText: resp.statusText, headers: respHeaders, body, url };
    });
  };
}
