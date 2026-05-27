import { type SecretsPipeline } from '@slicc/shared-ts';
import { decodeForbiddenRequestHeaders } from '../../webapp/src/shell/proxy-headers.js';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

/**
 * Extract `Set-Cookie` values from upstream response headers as a list.
 * `Headers.forEach` joins multi-value `set-cookie` entries with a comma
 * (per WHATWG fetch — undef behavior for set-cookie), so use the dedicated
 * `getSetCookie()` accessor when available. Falls back to a single
 * comma-joined string for older runtimes that don't implement it.
 */
function extractSetCookies(headers: Headers): string[] {
  const get = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof get === 'function') {
    return get.call(headers);
  }
  const joined = headers.get('set-cookie');
  return joined ? [joined] : [];
}

/**
 * Build the response-head headers map the way the CLI proxy does:
 *   - drop `set-cookie` and any `x-proxy-*` from the scrubbed map
 *   - if there were any `set-cookie` values, repack them as a JSON array
 *     under `X-Proxy-Set-Cookie` so the page side can recover them via
 *     `decodeForbiddenResponseHeaders`.
 */
function buildResponseHeaders(
  scrubbed: Record<string, string>,
  upstream: Headers,
  pipeline: SecretsPipeline
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubbed)) {
    const lower = k.toLowerCase();
    if (lower === 'set-cookie' || lower.startsWith('x-proxy-')) continue;
    out[k] = v;
  }
  const setCookies = extractSetCookies(upstream);
  if (setCookies.length > 0) {
    out['X-Proxy-Set-Cookie'] = pipeline.scrubResponse(JSON.stringify(setCookies));
  }
  return out;
}

export interface PortLike {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

export interface RequestMsg {
  type: 'request';
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge?: boolean;
}

/**
 * Port-streamed response protocol. The SW emits exactly one `response-head`
 * followed by 0..N `response-chunk`s + a terminating `response-end`, OR a
 * single `response-error` (terminal). Discriminated union so both the SW
 * emitters AND the page consumer narrow on `type` exhaustively — typos like
 * `response-haed` no longer compile, and adding a new variant forces an
 * update at both ends.
 */
export type ResponseMsg =
  | {
      type: 'response-head';
      status: number;
      statusText: string;
      headers: Record<string, string>;
    }
  | { type: 'response-chunk'; dataBase64: string }
  | { type: 'response-end' }
  | { type: 'response-error'; error: string };

function send(port: PortLike, msg: ResponseMsg): void {
  port.postMessage(msg);
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Variant that accepts a Promise for the pipeline so the caller can attach
 * the onMessage listener SYNCHRONOUSLY in the onConnect callback — Chrome
 * drops port messages that arrive before any listener exists, and the
 * page-side caller posts its request immediately after connect (before
 * the async pipeline build completes). The listener awaits the pipeline
 * before processing.
 */
export function handleFetchProxyConnectionAsync(
  port: PortLike,
  pipelinePromise: Promise<SecretsPipeline>
): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
    const msg = raw as RequestMsg;
    if (msg.type !== 'request') return;

    if (msg.requestBodyTooLarge) {
      send(port, {
        type: 'response-head',
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
      });
      send(port, { type: 'response-end' });
      return;
    }

    let pipeline: SecretsPipeline;
    try {
      pipeline = await pipelinePromise;
    } catch (err) {
      send(port, {
        type: 'response-error',
        error: `fetch-proxy init failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    try {
      const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
      if (credsResult.forbidden) {
        send(port, {
          type: 'response-error',
          error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
        });
        return;
      }
      const cleanedUrl = credsResult.url;
      const host = new URL(cleanedUrl).host;

      // Decode X-Proxy-* forbidden-header transport BEFORE unmask so the
      // pipeline sees real header names. Matches CLI server behavior.
      const headers: Record<string, string> = decodeForbiddenRequestHeaders(msg.headers);
      const headersResult = pipeline.unmaskHeaders(headers, host);
      if (headersResult.forbidden) {
        send(port, {
          type: 'response-error',
          error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
        });
        return;
      }
      if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
        headers.authorization = credsResult.syntheticAuthorization;
      }

      let body: Uint8Array | undefined;
      if (msg.bodyBase64) {
        const raw = decodeBase64Bytes(msg.bodyBase64);
        body = pipeline.unmaskBodyBytes(raw, host).bytes;
      }

      const upstream = await fetch(cleanedUrl, {
        method: msg.method,
        headers,
        body: body as BodyInit | undefined,
        signal: ac.signal,
      });
      const scrubbed = pipeline.scrubHeaders(upstream.headers);
      const respHeaders = buildResponseHeaders(scrubbed, upstream.headers, pipeline);
      send(port, {
        type: 'response-head',
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const bodyScrubbed = pipeline.scrubResponseBytes(value);
          send(port, { type: 'response-chunk', dataBase64: encodeBase64Bytes(bodyScrubbed) });
        }
      }
      send(port, { type: 'response-end' });
    } catch (err) {
      send(port, {
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

export function handleFetchProxyConnection(port: PortLike, pipeline: SecretsPipeline): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
    const msg = raw as RequestMsg;
    if (msg.type !== 'request') return;

    if (msg.requestBodyTooLarge) {
      send(port, {
        type: 'response-head',
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
      });
      send(port, { type: 'response-end' });
      return;
    }

    try {
      const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
      if (credsResult.forbidden) {
        send(port, {
          type: 'response-error',
          error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
        });
        return;
      }
      const cleanedUrl = credsResult.url;
      const host = new URL(cleanedUrl).host;

      // Decode X-Proxy-* forbidden-header transport BEFORE unmask so the
      // pipeline sees real header names. Matches CLI server behavior.
      const headers: Record<string, string> = decodeForbiddenRequestHeaders(msg.headers);
      const headersResult = pipeline.unmaskHeaders(headers, host);
      if (headersResult.forbidden) {
        send(port, {
          type: 'response-error',
          error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
        });
        return;
      }
      if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
        headers.authorization = credsResult.syntheticAuthorization;
      }

      let body: Uint8Array | undefined;
      if (msg.bodyBase64) {
        const raw = decodeBase64Bytes(msg.bodyBase64);
        body = pipeline.unmaskBodyBytes(raw, host).bytes;
      }

      const upstream = await fetch(cleanedUrl, {
        method: msg.method,
        headers,
        body: body as BodyInit | undefined,
        signal: ac.signal,
      });
      const scrubbed = pipeline.scrubHeaders(upstream.headers);
      const respHeaders = buildResponseHeaders(scrubbed, upstream.headers, pipeline);
      send(port, {
        type: 'response-head',
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Byte-safe scrub — no TextDecoder round-trip, so binary chunks
          // (git packfiles, ZIPs, images) survive intact. Chunk-boundary
          // scrub limitation matches CLI behavior: a coincidental real-value
          // straddling a chunk boundary leaks through. v2: carry-over window.
          const bodyScrubbed = pipeline.scrubResponseBytes(value);
          send(port, { type: 'response-chunk', dataBase64: encodeBase64Bytes(bodyScrubbed) });
        }
      }
      send(port, { type: 'response-end' });
    } catch (err) {
      send(port, {
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
