/**
 * `fetch-transport.ts` — the realm proxy's fallback {@link RealmTransport}:
 * the browser-shaped proxied fetch (`shell/proxied-fetch.ts`), for a float
 * whose fetch path has no raw mode (`raw-transport.ts` picks): a bridge
 * (node-server or Sliccstart's swift-server) that predates raw mode. It rides the
 * `/api/fetch-proxy` route or the extension service worker's
 * `fetch-proxy.fetch` Port (bridged from the kernel worker through the page). Secrets ride along as they do for the shell's
 * `curl`: a masked value is unmasked where the request leaves (node-server,
 * the service worker), and real values in a response are masked again there.
 *
 * The reduced semantics on this path:
 *
 * - **Redirects are followed** by the CLI route (`redirect: 'follow'`) and by
 *   the service worker's `fetch()`; the client sees the final response.
 * - **Bodies arrive decoded** (undici and the browser inflate them), and the
 *   route drops `Content-Encoding` / `Content-Length`.
 * - **Streaming**: responses stream on the bridge route only; the extension
 *   Port collects the whole body in the page first (the response cap
 *   applies). Request bodies are buffered, up to {@link REQUEST_BODY_CAP}.
 * - **Header fidelity**: header names arrive lower-cased, repeated request
 *   fields are joined, and a response's repeated fields other than
 *   `Set-Cookie` arrive joined.
 */
import type { SecureFetch } from 'just-bash';
import {
  createProxiedFetch,
  createProxiedStreamingFetch,
  type ProxyRequestOptions,
  REQUEST_BODY_CAP,
  type StreamingFetch,
} from '../../../shell/proxied-fetch.js';
import type {
  HeaderList,
  RealmTransport,
  RealmTransportRequest,
  RealmTransportResponse,
} from './transport.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;

/** The buffered fetch, widened to take request bytes (as `createProxiedFetch` does). */
export type BufferedFetch = (url: string, options: ProxyRequestOptions) => Promise<FetchResult>;

/** The two halves of the fetch path: buffered (with a body) and streaming (without). */
export interface FetchPath {
  buffered: BufferedFetch;
  streaming: StreamingFetch;
}

function defaultPath(): FetchPath {
  return {
    buffered: createProxiedFetch() as BufferedFetch,
    streaming: createProxiedStreamingFetch(),
  };
}

/** The request headers as one field per name, the way `fetch()` sends them. */
export function joinHeaders(headers: HeaderList): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const prior = out[key];
    out[key] = prior === undefined ? value : `${prior}${key === 'cookie' ? '; ' : ', '}${value}`;
  }
  return out;
}

/**
 * The fetch route's own response fields: its transport encodings
 * (`X-Proxy-*`) and the CORS fields of the page-to-bridge hop (it drops the
 * upstream's `Access-Control-*`, so any left are its own).
 */
function routeField(name: string): boolean {
  return name.startsWith('x-proxy-') || name.startsWith('access-control-');
}

/**
 * The response headers as a list. The fetch path carries every `Set-Cookie`
 * of a response as one JSON array (`X-Proxy-Set-Cookie`, decoded under
 * `set-cookie`): each becomes its own field again.
 */
export function splitHeaders(headers: Readonly<Record<string, string>>): HeaderList {
  const out: Array<readonly [string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (routeField(lower)) continue;
    if (lower === 'set-cookie') {
      for (const cookie of setCookies(value)) out.push([name, cookie]);
    } else {
      out.push([name, value]);
    }
  }
  return out;
}

function setCookies(value: string): string[] {
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) return parsed;
    } catch {
      // Not the array encoding: one cookie.
    }
  }
  return [value];
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes;
}

function bodyBytes(body: FetchResult['body'] | string): Uint8Array {
  if (typeof body !== 'string') return body;
  // A latin1 string: one char per byte.
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

/** The realm proxy's transport over the float's fetch path. */
export function proxiedFetchTransport(path: FetchPath = defaultPath()): RealmTransport {
  return {
    traits: { manualRedirects: false, encodedBodies: false, maxRequestBody: REQUEST_BODY_CAP },
    async fetch(request: RealmTransportRequest): Promise<RealmTransportResponse> {
      const headers = joinHeaders(request.headers);
      if (request.body && request.body.byteLength > 0) {
        const result = await path.buffered(request.url, {
          method: request.method,
          headers,
          body: request.body,
          signal: request.signal,
        });
        return {
          status: result.status,
          statusText: result.statusText,
          headers: splitHeaders(result.headers),
          body: once(bodyBytes(result.body)),
          cancel: async () => undefined,
        };
      }
      const response = await path.streaming(request.url, {
        method: request.method,
        headers,
        signal: request.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: splitHeaders(response.headers),
        body: response.body,
        cancel: () => response.cancel(),
      };
    },
  };
}
