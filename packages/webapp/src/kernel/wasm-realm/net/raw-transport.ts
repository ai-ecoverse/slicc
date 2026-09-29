import {
  createProxiedStreamingFetch,
  getRawFetchCapabilities,
  type RawFetchCapabilities,
  RawFetchError,
  type RawProxiedFetch,
} from '../../../shell/proxied-fetch.js';
import { proxiedFetchTransport } from './fetch-transport.js';
import type { RealmTransport, RealmTransportResponse } from './transport.js';

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

export function rawFetchTransport(
  raw: RawProxiedFetch,
  capabilities: RawFetchCapabilities
): RealmTransport {
  return {
    traits: {
      manualRedirects: true,

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
  capabilities?: () => RawFetchCapabilities | Promise<RawFetchCapabilities>;
  raw?: () => RawProxiedFetch;
  fallback?: () => RealmTransport;
}

export function realmFetchTransport(options: RealmFetchOptions = {}): RealmTransport {
  let fallbackTransport: RealmTransport | undefined;
  const fallback = () => {
    fallbackTransport ??= (options.fallback ?? (() => proxiedFetchTransport()))();
    return fallbackTransport;
  };
  let current: RealmTransport | undefined;
  const chosen = Promise.resolve()
    .then(() => (options.capabilities ?? getRawFetchCapabilities)())
    .then(
      (capabilities) =>
        capabilities.supported
          ? rawFetchTransport(
              (options.raw ?? (() => createProxiedStreamingFetch({ mode: 'raw' })))(),
              capabilities
            )
          : fallback(),
      () => fallback()
    )
    .then((transport) => {
      current ??= transport;
      return current;
    });
  return {
    get traits() {
      return (current ?? fallback()).traits;
    },
    async fetch(request) {
      const transport = current ?? (await chosen);
      if (transport === fallbackTransport) return transport.fetch(request);
      try {
        return await transport.fetch(request);
      } catch (e) {
        if (!(e instanceof RawFetchError) || e.code !== 'unsupported') throw e;
        current = fallback();
        return current.fetch(request);
      }
    },
  };
}
