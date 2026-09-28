/**
 * Raw mode of the `fetch-proxy.fetch` Port (#3571): the extension float's side
 * of `@slicc/shared-ts` `raw-fetch-protocol.ts`, for the wasm realm's HTTP
 * proxy. The page opens the Port as usual and sends `raw-request` instead of
 * `request`; see that module for the message contract.
 *
 * The upstream fetch runs with `redirect: 'manual'` and `credentials: 'omit'`
 * (the caller manages its own cookies, not Chrome's jar). Its head comes from
 * `webRequest` (`raw-fetch-capture.ts`), since `fetch` hides 3xx heads,
 * `Set-Cookie` and repeated headers; the request carries the same unique
 * fragment for the capture and for the DNR rule that restores the forbidden
 * request headers (plus `User-Agent`, which Chrome otherwise overrides).
 *
 * Uploads: large or unknown-length non-text bodies stream (`duplex: 'half'`).
 * Chrome rejects the first streamed request that needs a new connection
 * before sending any of it (measured with `credentials: 'omit'`, whose
 * connections are pooled apart), so that one attempt is retried, and only
 * when its body had not produced a single byte. Text bodies (secret unmask) and
 * HMAC-signed bodies are buffered whole, up to
 * `RAW_FETCH_BUFFERED_REQUEST_BODY_CAP`.
 *
 * Secrets: masked values in headers, URL credentials and buffered bodies are
 * unmasked for their domains only (`forbidden-secret` otherwise), response
 * header values are scrubbed, and so are text response bodies.
 */

import {
  BROWSER_DECODED_CODINGS,
  base64ToUint8,
  foldRawRequestHeaders,
  HMAC_SIGN_HEADER,
  isTextContentType,
  isTextRequestContentType,
  RAW_FETCH_BUFFERED_REQUEST_BODY_CAP,
  RAW_FETCH_PORT_CHUNK_BYTES,
  RAW_FETCH_PORT_WINDOW,
  RAW_FETCH_PROTOCOL_VERSION,
  RAW_FETCH_STREAM_THRESHOLD_BYTES,
  RAW_FETCH_TAG_PREFIX,
  type RawFetchErrorCode,
  type RawFetchRequestHead,
  type RawHeaderList,
  type RawPortRequestMsg,
  type RawPortResponseMsg,
  rawResponseHasBody,
  rawResponseHeaders,
  type SecretsPipeline,
  stripRawRequestHeaders,
  uint8ToBase64,
} from '@slicc/shared-ts';
import type { PortLike, RawSessionStarter } from './fetch-proxy-shared.js';
import { installForbiddenHeaderRule, randomFragmentToken } from './fetch-proxy-shared.js';
import type { RawFetchCapture } from './raw-fetch-capture.js';

export interface RawFetchDeps {
  capture: RawFetchCapture;
  /** Whether this Chrome can send a `ReadableStream` request body. */
  supportsRequestStreams?: () => boolean;
  fetchImpl?: typeof fetch;
}

type RawRequestMsg = Extract<RawPortRequestMsg, { type: 'raw-request' }>;

/** How long to wait for the `webRequest` head once `fetch` has settled. */
const CAPTURE_WAIT_MS = 1000;
const REDIRECT_CAPTURE_WAIT_MS = 5000;
/** Chrome sends `User-Agent` from the browser unless DNR sets it. */
const RESTORE_ALSO = new Set(['user-agent']);

class RawError extends Error {
  constructor(
    readonly code: RawFetchErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Feature test from the Fetch spec's request-streams explainer. */
export function supportsRequestStreams(): boolean {
  let duplexAccessed = false;
  try {
    const hasContentType = new Request('https://example.invalid/', {
      body: new ReadableStream(),
      method: 'POST',
      get duplex() {
        duplexAccessed = true;
        return 'half';
      },
    } as RequestInit).headers.has('Content-Type');
    return duplexAccessed && !hasContentType;
  } catch {
    return false;
  }
}

/** Waitable counter for chunks a peer may still send. */
class Credits {
  private n: number;
  private waiters: Array<() => void> = [];
  constructor(initial: number) {
    this.n = initial;
  }
  grant(k: number): void {
    this.n += k;
    for (const w of this.waiters.splice(0)) w();
  }
  async take(signal: AbortSignal): Promise<boolean> {
    while (this.n <= 0) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    this.n -= 1;
    return !signal.aborted;
  }
}

/** Upload chunks as they arrive over the Port, handed out in order. */
class UploadQueue {
  private chunks: Uint8Array[] = [];
  private ended = false;
  private waiter: (() => void) | null = null;
  constructor(private readonly onConsumed: () => void) {}
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.wake();
  }
  end(): void {
    this.ended = true;
    this.wake();
  }
  async next(): Promise<Uint8Array | null> {
    while (this.chunks.length === 0 && !this.ended) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const chunk = this.chunks.shift();
    if (!chunk) return null;
    this.onConsumed();
    return chunk;
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}

interface PreparedRaw {
  url: string;
  host: string;
  headers: Record<string, string>;
  hmacSpec: string | undefined;
}

function forbidden(f: { secretName: string; hostname: string }): RawError {
  return new RawError(
    'forbidden-secret',
    403,
    `Secret "${f.secretName}" is not allowed for domain "${f.hostname}"`
  );
}

/** Unmask the head the way the default Port handler does. */
function prepareHead(pipeline: SecretsPipeline, head: RawFetchRequestHead): PreparedRaw {
  const creds = pipeline.extractAndUnmaskUrlCredentials(head.url);
  if (creds.forbidden) throw forbidden(creds.forbidden);
  const host = new URL(creds.url).host;
  const headers = foldRawRequestHeaders(stripRawRequestHeaders(head.headers));
  const hmacSpec = headers[HMAC_SIGN_HEADER];
  delete headers[HMAC_SIGN_HEADER];
  const unmasked = pipeline.unmaskHeaders(headers, host);
  if (unmasked.forbidden) throw forbidden(unmasked.forbidden);
  if (creds.syntheticAuthorization && !('authorization' in headers)) {
    headers.authorization = creds.syntheticAuthorization;
  }
  return { url: creds.url, host, headers, hmacSpec };
}

/** Whether this upload streams rather than being buffered first. */
function shouldStream(msg: RawRequestMsg, prepared: PreparedRaw, deps: RawFetchDeps): boolean {
  if (!msg.hasBody || prepared.hmacSpec) return false;
  if (isTextRequestContentType(prepared.headers['content-type'] ?? '')) return false;
  if (!(deps.supportsRequestStreams ?? supportsRequestStreams)()) return false;
  return msg.bodyLength === undefined || msg.bodyLength >= RAW_FETCH_STREAM_THRESHOLD_BYTES;
}

async function bufferUpload(queue: UploadQueue): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let chunk = await queue.next(); chunk; chunk = await queue.next()) {
    size += chunk.byteLength;
    if (size > RAW_FETCH_BUFFERED_REQUEST_BODY_CAP) {
      throw new RawError(
        'request-body-too-large',
        413,
        `raw fetch: request body exceeds the ${RAW_FETCH_BUFFERED_REQUEST_BODY_CAP} byte limit of this float`
      );
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * A streamed body over the upload queue that can be offered to `fetch` again
 * as long as no attempt has handed `fetch` a single byte. A chunk a rejected
 * attempt read but never handed on is kept for the next one.
 */
function retryableUpload(queue: UploadQueue) {
  let delivered = 0;
  let spare: Uint8Array | null = null;
  let generation = 0;
  const stream = () => {
    const own = ++generation;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const chunk = spare ?? (await queue.next());
          spare = null;
          if (own !== generation) {
            spare = chunk;
            return;
          }
          if (!chunk) {
            controller.close();
            return;
          }
          delivered += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
  };
  return { stream, untouched: () => delivered === 0 };
}

/**
 * Whether a rejected streamed attempt may be retried: the measured Chrome
 * refusal is a `TypeError` raised before the body produced any byte, so the
 * origin cannot have received a complete request (a chunked body needs its
 * terminating chunk). Anything else, possibly already processed, is not
 * replayed, whatever the method.
 */
function isUnsentRefusal(err: unknown, untouched: boolean, signal: AbortSignal): boolean {
  return err instanceof TypeError && untouched && !signal.aborted;
}

/** Relay the response body, one Port message per granted credit. */
async function relayBody(
  port: PortLike,
  body: ReadableStream<Uint8Array>,
  scrub: ((bytes: Uint8Array) => Uint8Array) | null,
  credits: Credits,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = scrub ? scrub(value) : value;
      for (let off = 0; off < bytes.byteLength; off += RAW_FETCH_PORT_CHUNK_BYTES) {
        if (!(await credits.take(signal))) return;
        const slice = bytes.subarray(off, off + RAW_FETCH_PORT_CHUNK_BYTES);
        send(port, { type: 'raw-response-chunk', dataBase64: uint8ToBase64(slice) });
      }
    }
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
  }
}

function send(port: PortLike, msg: RawPortResponseMsg): void {
  port.postMessage(msg);
}

function contentTypeOf(headers: RawHeaderList): string {
  return headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
}

/** One raw request on one Port. */
class RawSession {
  private readonly credits: Credits;
  private readonly queue: UploadQueue;
  private readonly tag = `${RAW_FETCH_TAG_PREFIX}${randomFragmentToken()}`;

  constructor(
    private readonly port: PortLike,
    private readonly msg: RawRequestMsg,
    private readonly deps: RawFetchDeps,
    private readonly signal: AbortSignal
  ) {
    this.credits = new Credits(msg.credits);
    this.queue = new UploadQueue(() => send(port, { type: 'raw-body-credit', chunks: 1 }));
    if (!msg.hasBody) this.queue.end();
  }

  onMessage(raw: unknown): void {
    const msg = raw as RawPortRequestMsg;
    if (msg.type === 'raw-body-chunk') this.queue.push(base64ToUint8(msg.dataBase64));
    else if (msg.type === 'raw-body-end') this.queue.end();
    else if (msg.type === 'raw-credit') this.credits.grant(msg.chunks);
  }

  async run(pipelinePromise: Promise<SecretsPipeline>): Promise<void> {
    if (this.msg.hasBody)
      send(this.port, { type: 'raw-body-credit', chunks: RAW_FETCH_PORT_WINDOW });
    this.deps.capture.expect(this.tag);
    try {
      const pipeline = await pipelinePromise;
      const prepared = prepareHead(pipeline, this.msg.head);
      const upstream = await this.fetchUpstream(pipeline, prepared);
      await this.relay(pipeline, upstream);
    } catch (err) {
      if (this.signal.aborted) return;
      const e =
        err instanceof RawError
          ? err
          : new RawError('upstream', 502, err instanceof Error ? err.message : String(err));
      send(this.port, {
        type: 'raw-response-error',
        code: e.code,
        status: e.status,
        error: e.message,
      });
    } finally {
      this.deps.capture.forget(this.tag);
    }
  }

  private async fetchUpstream(pipeline: SecretsPipeline, prepared: PreparedRaw): Promise<Response> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const streamed = shouldStream(this.msg, prepared, this.deps);
    const rule = await installForbiddenHeaderRule(prepared.url, prepared.headers, {
      fragment: this.tag,
      alsoRestore: RESTORE_ALSO,
    });
    try {
      const init: RequestInit & { duplex?: 'half' } = {
        method: this.msg.head.method,
        headers: prepared.headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: this.signal,
      };
      if (!streamed) {
        if (this.msg.hasBody) {
          const bytes = pipeline.unmaskBodyBytes(
            await bufferUpload(this.queue),
            prepared.host
          ).bytes;
          await this.sign(pipeline, prepared, bytes);
          init.body = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        } else {
          await this.sign(pipeline, prepared, new Uint8Array(0));
        }
        return await fetchImpl(rule.fetchUrl, init);
      }
      init.duplex = 'half';
      const upload = retryableUpload(this.queue);
      try {
        return await fetchImpl(rule.fetchUrl, { ...init, body: upload.stream() });
      } catch (err) {
        if (!isUnsentRefusal(err, upload.untouched(), this.signal)) throw err;
        return await fetchImpl(rule.fetchUrl, { ...init, body: upload.stream() });
      }
    } finally {
      await rule.cleanup();
    }
  }

  private async sign(pipeline: SecretsPipeline, prepared: PreparedRaw, body: Uint8Array) {
    if (!prepared.hmacSpec) return;
    const signed = await pipeline.signHmac(prepared.hmacSpec, body, prepared.host);
    if (signed.forbidden) throw forbidden(signed.forbidden);
    if (signed.headerName && signed.signatureHex) {
      prepared.headers[signed.headerName] = signed.signatureHex;
    }
    if (signed.timestampHeaderName && signed.timestampValue) {
      prepared.headers[signed.timestampHeaderName] = signed.timestampValue;
    }
  }

  private async relay(pipeline: SecretsPipeline, upstream: Response): Promise<void> {
    const method = this.msg.head.method;
    const opaque = upstream.type === 'opaqueredirect';
    const captured = await this.deps.capture.wait(
      this.tag,
      opaque ? REDIRECT_CAPTURE_WAIT_MS : CAPTURE_WAIT_MS
    );
    if (opaque && !captured) {
      throw new RawError('upstream', 502, 'raw fetch: the redirect response was not observed');
    }
    const status = captured?.status ?? upstream.status;
    const upstreamHeaders = captured?.headers ?? [...upstream.headers];
    const isText = isTextContentType(contentTypeOf(upstreamHeaders));
    const headers = rawResponseHeaders({
      method,
      status,
      headers: upstreamHeaders,
      bodyRewritten: isText,
      decodedCodings: BROWSER_DECODED_CODINGS,
    }).map(([name, value]): [string, string] => [name, pipeline.scrubResponse(value)]);
    const hasBody = !opaque && upstream.body !== null && rawResponseHasBody(method, status);
    send(this.port, {
      type: 'raw-response-head',
      head: {
        status,
        statusText: captured?.statusText || upstream.statusText,
        headers,
        url: this.msg.head.url,
      },
      hasBody,
    });
    if (hasBody && upstream.body) {
      const scrub = isText ? (bytes: Uint8Array) => pipeline.scrubResponseBytes(bytes) : null;
      await relayBody(this.port, upstream.body, scrub, this.credits, this.signal);
      if (this.signal.aborted) return;
    } else {
      await upstream.body?.cancel().catch(() => undefined);
    }
    send(this.port, { type: 'raw-response-end' });
  }
}

/**
 * Build the raw-session starter the service worker hands to
 * `handleFetchProxyConnectionAsync` for one Port.
 */
export function rawSessionStarter(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>,
  deps: RawFetchDeps
): RawSessionStarter {
  return (first, signal) => {
    if ((first as RawPortRequestMsg).type === 'raw-probe') {
      send(port, {
        type: 'raw-probe-reply',
        reply: {
          rawFetch: RAW_FETCH_PROTOCOL_VERSION,
          requestBodyStreaming: (deps.supportsRequestStreams ?? supportsRequestStreams)(),
          maxRequestBodyBytes: RAW_FETCH_BUFFERED_REQUEST_BODY_CAP,
        },
      });
      return () => {};
    }
    const session = new RawSession(port, first as RawRequestMsg, deps, signal);
    void session.run(pipelinePromise);
    return (raw) => session.onMessage(raw);
  };
}
