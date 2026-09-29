/**
 * `raw-transport.ts` — the realm proxy's {@link RealmTransport} over the
 * proxied fetch's raw mode (`createProxiedStreamingFetch({ mode: 'raw' })`,
 * contract in `@slicc/shared-ts` `raw-fetch-protocol.ts`): an HTTP client's
 * view of the float's way out. A 3xx comes back with its `Location`, every
 * `Set-Cookie` stays its own field, bodies are decoded with their headers
 * made to match, and the body is pulled as the proxy writes it on. A raw
 * failure that is no upstream response carries the status the proxy answers
 * with (413 for a body over the float's cap, 403 for a secret used on a
 * domain it is not scoped to).
 *
 * Where a float has no raw mode (Sliccstart's swift-server, a bridge that
 * predates it) the proxy falls back to {@link proxiedFetchTransport}, with
 * that path's reduced semantics (redirects followed, no streaming in the
 * extension): up front when the float says so, or on the first request a
 * bridge answers `unsupported`, which is retried on the fallback.
 *
 * Float differences the proxy passes through: node-server joins repeated
 * response fields (except `Set-Cookie`) with `, ` where the extension keeps
 * them apart; the extension adds `Accept-Language` / `Sec-Fetch-*` upstream
 * and decodes zstd; Chrome reads a response ahead of any reader, so there
 * the backpressure the proxy applies stops at the browser.
 */
import {
  createProxiedStreamingFetch,
  getRawFetchCapabilities,
  type RawFetchCapabilities,
  RawFetchError,
  type RawProxiedFetch,
} from '../../../shell/proxied-fetch.js';
import { proxiedFetchTransport } from './fetch-transport.js';
import type { RealmTransport, RealmTransportResponse } from './transport.js';

/** A pull-driven stream as the body the proxy iterates; `cancel` drops it. */
function bodyOf(
  stream: ReadableStream<Uint8Array> | null
): Pick<RealmTransportResponse, 'body' | 'cancel'> {
  if (!stream) {
    return { body: (async function* () {})(), cancel: async () => undefined };
  }
  const reader = stream.getReader();
  let done = false;
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        yield next.value;
      }
      done = true;
    } finally {
      if (!done) await reader.cancel().catch(() => undefined);
    }
  }
  return {
    body: body(),
    cancel: async () => {
      if (!done) await reader.cancel().catch(() => undefined);
      done = true;
    },
  };
}

/** The realm transport over raw mode. */
export function rawFetchTransport(
  raw: RawProxiedFetch,
  capabilities: RawFetchCapabilities
): RealmTransport {
  return {
    traits: {
      manualRedirects: true,
      // Raw mode already made its headers match the bytes: a coding it
      // undid is gone, one it left (zstd on node-server, an unknown one) is
      // still named, and a HEAD/304 keeps its representation's length.
      encodedBodies: true,
      maxRequestBody: capabilities.maxRequestBodyBytes,
    },
    async fetch(request) {
      const response = await raw(request.url, {
        method: request.method,
        headers: request.headers.map(([name, value]) => [name, value]),
        ...(request.body && request.body.byteLength > 0 ? { body: request.body } : {}),
        signal: request.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        ...bodyOf(response.body),
      };
    },
  };
}

export interface RealmFetchOptions {
  capabilities?: () => RawFetchCapabilities;
  raw?: () => RawProxiedFetch;
  fallback?: () => RealmTransport;
}

/**
 * The float's transport for the realm proxy: raw mode where the float has
 * it, else today's proxied fetch; a raw `unsupported` answer switches to the
 * fallback for good.
 */
export function realmFetchTransport(options: RealmFetchOptions = {}): RealmTransport {
  const capabilities = (options.capabilities ?? getRawFetchCapabilities)();
  const fallback = options.fallback ?? (() => proxiedFetchTransport());
  if (!capabilities.supported) return fallback();
  const raw = rawFetchTransport(
    (options.raw ?? (() => createProxiedStreamingFetch({ mode: 'raw' })))(),
    capabilities
  );
  let current: RealmTransport = raw;
  return {
    get traits() {
      return current.traits;
    },
    async fetch(request) {
      if (current !== raw) return current.fetch(request);
      try {
        return await raw.fetch(request);
      } catch (e) {
        if (!(e instanceof RawFetchError) || e.code !== 'unsupported') throw e;
        current = fallback();
        return current.fetch(request);
      }
    },
  };
}
