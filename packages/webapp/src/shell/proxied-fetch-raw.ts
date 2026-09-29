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
  parseRawFetchProbeReply,
  RAW_FETCH_CONTENT_TYPE,
  RAW_FETCH_PROBE_HEADER,
  RAW_FETCH_REQUEST_HEADER,
  rawResponseHasBody,
} from '@slicc/shared-ts';
import { apiHeaders, resolveApiUrl } from '../base/api-endpoint.js';
import {
  type RawFetchCapabilities,
  RawFetchError,
  type RawFetchInit,
  type RawFetchResponse,
  type RawProxiedFetch,
  usesFetchProxyEndpoint,
} from './proxied-fetch-raw-types.js';
import { isProxyError, readProxyErrorMessage } from './proxy-error.js';

export type { RawHeaderList } from '@slicc/shared-ts';

export {
  type RawFetchCapabilities,
  RawFetchError,
  type RawFetchErrorCode,
  type RawFetchInit,
  type RawFetchResponse,
  type RawProxiedFetch,
  usesFetchProxyEndpoint,
} from './proxied-fetch-raw-types.js';

const UNSUPPORTED: RawFetchCapabilities = {
  supported: false,
  requestBodyStreaming: false,
  maxRequestBodyBytes: 0,
};

/**
 * Probe answers per bridge URL. Only definitive answers are kept (a raw
 * bridge's reply, or a bridge that plainly lacks raw mode); a bridge that
 * could not be reached is asked again next time.
 */
const probed = new Map<string, Promise<RawFetchCapabilities>>();

async function probeBridge(url: string): Promise<RawFetchCapabilities> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: apiHeaders({ [RAW_FETCH_PROBE_HEADER]: '1' }),
      cache: 'no-store',
    });
  } catch {
    probed.delete(url);
    return UNSUPPORTED;
  }
  const reply = resp.ok ? parseRawFetchProbeReply(await resp.json().catch(() => null)) : null;
  if (!reply) {
    await resp.body?.cancel().catch(() => undefined);
    return UNSUPPORTED;
  }
  return {
    supported: true,
    requestBodyStreaming: reply.requestBodyStreaming,
    maxRequestBodyBytes: reply.maxRequestBodyBytes,
  };
}

/**
 * Raw-mode capabilities of the current float. On the bridge floats this asks
 * the bridge ({@link RAW_FETCH_PROBE_HEADER}) once per bridge URL, since a
 * bridge that routes `/api/fetch-proxy` need not implement raw mode
 * (swift-server, an older node-server). The extension float has no raw
 * transport yet.
 */
export function getRawFetchCapabilities(): Promise<RawFetchCapabilities> {
  if (!usesFetchProxyEndpoint()) return Promise.resolve(UNSUPPORTED);
  const url = resolveApiUrl('/api/fetch-proxy');
  let answer = probed.get(url);
  if (!answer) {
    answer = probeBridge(url);
    probed.set(url, answer);
  }
  return answer;
}

/** Forget the probe answers, e.g. after the bridge was replaced. */
export function resetRawFetchCapabilities(): void {
  probed.clear();
}

function unsupported(): RawFetchError {
  return new RawFetchError(
    'unsupported',
    501,
    'raw fetch: this bridge does not support raw mode; update node-server'
  );
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function tooLarge(limit: number): RawFetchError {
  return new RawFetchError(
    'request-body-too-large',
    413,
    `raw fetch: request body exceeds the ${limit} byte limit of this float`
  );
}

/** A reader read that gives up (cancelling the reader) when `signal` aborts. */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

/** Collect a request body into one Blob, refusing it past `limit`. */
async function bufferRequestBody(
  body: RawFetchInit['body'],
  limit: number,
  signal?: AbortSignal
): Promise<Blob | null> {
  if (body === undefined) return null;
  if (body instanceof Blob || body instanceof Uint8Array) {
    const blob = body instanceof Blob ? body : new Blob([body as Uint8Array<ArrayBuffer>]);
    if (blob.size > limit) throw tooLarge(limit);
    return blob;
  }
  const reader = body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await readOrAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge(limit);
      parts.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return new Blob(parts);
}

/** Map a bridge-generated error response onto a {@link RawFetchError}. */
async function bridgeError(resp: Response): Promise<RawFetchError> {
  const message = await readProxyErrorMessage(resp);
  if (resp.status === 413) return new RawFetchError('request-body-too-large', 413, message);
  if (resp.status === 403) return new RawFetchError('forbidden-secret', 403, message);
  if (resp.status === 400 && /X-Target-URL/i.test(message)) return unsupported();
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
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          // The bridge drops the connection when the upstream body breaks.
          controller.error(
            new RawFetchError(
              'upstream',
              502,
              `raw fetch: response body failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
          return;
        }
        if (result.done) controller.close();
        else controller.enqueue(result.value);
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
    const capabilities = await getRawFetchCapabilities();
    if (!capabilities.supported) throw unsupported();
    const blob = await bufferRequestBody(init.body, capabilities.maxRequestBodyBytes, init.signal);
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
    let resp: Response;
    try {
      resp = await fetch(resolveApiUrl('/api/fetch-proxy'), request);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new RawFetchError(
        'bridge',
        502,
        `raw fetch: the bridge is unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (isProxyError(resp)) throw await bridgeError(resp);
    if (!(resp.headers.get('content-type') ?? '').startsWith(RAW_FETCH_CONTENT_TYPE)) {
      await resp.body?.cancel().catch(() => undefined);
      throw unsupported();
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
