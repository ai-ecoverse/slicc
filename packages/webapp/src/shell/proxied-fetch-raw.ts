/**
 * proxied-fetch-raw — the raw mode of the proxied fetch (#3571), reached
 * through `createProxiedStreamingFetch({ mode: 'raw' })`.
 *
 * The default proxied fetch behaves like a browser. Raw mode behaves like an
 * HTTP client, which is what the wasm realm's HTTP proxy needs to forward
 * curl, libcurl and git: redirects come back as 3xx with `Location`, headers
 * are an ordered list (every `Set-Cookie` separate), the body is decoded with
 * `Content-Encoding` removed to match, and it streams, pulled on demand. The
 * contract is `@slicc/shared-ts` `raw-fetch-protocol.ts`.
 *
 * Float support:
 *   - CLI and cloud (node-server `/api/fetch-proxy`, raw handler in
 *     `routes/fetch-proxy-raw.ts`): supported. The upload is buffered for
 *     now; {@link RAW_FETCH_BRIDGE_REQUEST_BODY_CAP} bounds it.
 *   - Chrome extension: not yet; calls fail with `unsupported`.
 *
 * Secret handling is the float's usual one: masked values are unmasked for
 * allowed domains at egress, and response headers and text bodies scrubbed.
 */

import {
  decodeRawResponseFrame,
  encodeRawRequestHead,
  RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
  RAW_FETCH_CONTENT_TYPE,
  RAW_FETCH_REQUEST_HEADER,
  type RawFetchResponseHead,
  type RawHeaderList,
  rawResponseHasBody,
} from '@slicc/shared-ts';
import {
  apiHeaders,
  getChromeExtensionRealm,
  getExtensionDelegateId,
  resolveApiUrl,
} from '../base/api-endpoint.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';

export type { RawHeaderList } from '@slicc/shared-ts';

/** A raw-mode request. */
export interface RawFetchInit {
  method?: string;
  /** Ordered; repeats are folded as `fetch` would (`Cookie` with `; `). */
  headers?: RawHeaderList;
  body?: Uint8Array | Blob | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

/** A raw-mode response. `body` is `null` when the response has none. */
export interface RawFetchResponse extends RawFetchResponseHead {
  body: ReadableStream<Uint8Array> | null;
}

export type RawProxiedFetch = (url: string, init?: RawFetchInit) => Promise<RawFetchResponse>;

/** What the current float's raw mode can do, for the realm proxy to plan by. */
export interface RawFetchCapabilities {
  supported: boolean;
  /** Whether a request body is streamed rather than buffered first. */
  requestBodyStreaming: boolean;
  /** Largest request body the float accepts. */
  maxRequestBodyBytes: number;
}

export type RawFetchErrorCode =
  /** The float has no raw mode (extension, or a bridge that predates it). */
  | 'unsupported'
  /** The request body is past {@link RawFetchCapabilities.maxRequestBodyBytes}. */
  | 'request-body-too-large'
  /** A masked secret was used against a domain it is not scoped to. */
  | 'forbidden-secret'
  /** The upstream could not be reached, or the stream broke. */
  | 'upstream'
  /** The bridge answered with something raw mode cannot read. */
  | 'bridge';

/**
 * A raw-mode failure that is not an upstream HTTP response. `status` is the
 * HTTP status a proxy should answer its own client with.
 */
export class RawFetchError extends Error {
  constructor(
    readonly code: RawFetchErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RawFetchError';
  }
}

/**
 * Whether this realm reaches the network through the bridge's
 * `/api/fetch-proxy` endpoint rather than an extension Port. Keep in step
 * with the branch order of `createProxiedFetch`.
 */
export function usesFetchProxyEndpoint(): boolean {
  if (getChromeExtensionRealm()) return false;
  if (!getExtensionDelegateId()) return true;
  if (typeof chrome === 'undefined') return false;
  return typeof chrome?.runtime?.connect !== 'function';
}

/** Raw-mode capabilities of the current float. */
export function getRawFetchCapabilities(): RawFetchCapabilities {
  if (!usesFetchProxyEndpoint()) {
    return { supported: false, requestBodyStreaming: false, maxRequestBodyBytes: 0 };
  }
  return {
    supported: true,
    requestBodyStreaming: false,
    maxRequestBodyBytes: RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
  };
}

function tooLarge(limit: number): RawFetchError {
  return new RawFetchError(
    'request-body-too-large',
    413,
    `raw fetch: request body exceeds the ${limit} byte limit of this float`
  );
}

/** Collect a request body into one Blob, refusing it past `limit`. */
async function bufferRequestBody(body: RawFetchInit['body'], limit: number): Promise<Blob | null> {
  if (body === undefined) return null;
  if (body instanceof Blob || body instanceof Uint8Array) {
    const blob = body instanceof Blob ? body : new Blob([body as Uint8Array<ArrayBuffer>]);
    if (blob.size > limit) throw tooLarge(limit);
    return blob;
  }
  const reader = body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(limit);
    }
    parts.push(value as Uint8Array<ArrayBuffer>);
  }
  return new Blob(parts);
}

/** Map a bridge-generated error response onto a {@link RawFetchError}. */
async function bridgeError(resp: Response): Promise<RawFetchError> {
  const message = await readProxyErrorMessage(resp);
  if (resp.status === 413) return new RawFetchError('request-body-too-large', 413, message);
  if (resp.status === 403) return new RawFetchError('forbidden-secret', 403, message);
  if (resp.status === 400 && /X-Target-URL/i.test(message)) {
    return new RawFetchError(
      'unsupported',
      501,
      'raw fetch: this bridge does not support raw mode; update node-server'
    );
  }
  if (resp.status === 502) return new RawFetchError('upstream', 502, message);
  return new RawFetchError('bridge', 502, message);
}

/**
 * Read the response-head frame off the front of the bridge body and hand the
 * rest on as a pull-driven stream: nothing is read from the bridge until the
 * caller asks. That bounds what this layer holds, not the upstream: Chrome's
 * `fetch` reads the bridge response ahead of any JS reader.
 */
async function splitRawResponse(resp: Response, method: string): Promise<RawFetchResponse> {
  if (!resp.body) throw new RawFetchError('bridge', 502, 'raw fetch: bridge sent no body');
  const reader = resp.body.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  let split: ReturnType<typeof decodeRawResponseFrame> = null;
  try {
    while (!split) {
      const { done, value } = await reader.read();
      if (done) throw new RawFetchError('bridge', 502, 'raw fetch: truncated response head');
      const next = new Uint8Array(buffered.byteLength + value.byteLength);
      next.set(buffered);
      next.set(value, buffered.byteLength);
      buffered = next;
      split = decodeRawResponseFrame(buffered);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof RawFetchError) throw err;
    throw new RawFetchError('bridge', 502, err instanceof Error ? err.message : String(err));
  }
  const { head, rest } = split;
  if (!rawResponseHasBody(method, head.status)) {
    await reader.cancel().catch(() => undefined);
    return { ...head, body: null };
  }
  let pending: Uint8Array | null = rest.byteLength > 0 ? rest : null;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pending) {
          controller.enqueue(pending);
          pending = null;
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { ...head, body };
}

/** Raw mode over the node-server bridge (CLI and cloud floats). */
function bridgeRawFetch(): RawProxiedFetch {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const blob = await bufferRequestBody(init.body, RAW_FETCH_BRIDGE_REQUEST_BODY_CAP);
    const headers = apiHeaders({
      [RAW_FETCH_REQUEST_HEADER]: encodeRawRequestHead({
        url,
        method,
        headers: init.headers ?? [],
      }),
      'Content-Type': 'application/octet-stream',
      'X-Slicc-Raw-Body': '1',
    });
    const request: RequestInit = { method: 'POST', headers, cache: 'no-store' };
    if (blob) request.body = blob;
    if (init.signal) request.signal = init.signal;
    const resp = await fetch(resolveApiUrl('/api/fetch-proxy'), request);
    if (isProxyError(resp)) throw await bridgeError(resp);
    if (!(resp.headers.get('content-type') ?? '').startsWith(RAW_FETCH_CONTENT_TYPE)) {
      await resp.body?.cancel().catch(() => undefined);
      throw new RawFetchError(
        'unsupported',
        501,
        'raw fetch: this bridge does not support raw mode; update node-server'
      );
    }
    return splitRawResponse(resp, method);
  };
}

/** Build the raw-mode fetch for the current float. */
export function createRawProxiedFetch(): RawProxiedFetch {
  if (usesFetchProxyEndpoint()) return bridgeRawFetch();
  return async () => {
    throw new RawFetchError(
      'unsupported',
      501,
      'raw fetch: not available in the Chrome extension float yet'
    );
  };
}
