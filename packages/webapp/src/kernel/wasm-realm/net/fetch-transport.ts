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

export type BufferedFetch = (url: string, options: ProxyRequestOptions) => Promise<FetchResult>;

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

export function joinHeaders(headers: HeaderList): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    const prior = out[key];
    out[key] = prior === undefined ? value : `${prior}${key === 'cookie' ? '; ' : ', '}${value}`;
  }
  return out;
}

function routeField(name: string): boolean {
  return name.startsWith('x-proxy-') || name.startsWith('access-control-');
}

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
    } catch {}
  }
  return [value];
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  if (bytes.byteLength > 0) yield bytes;
}

function bodyBytes(body: FetchResult['body'] | string): Uint8Array {
  if (typeof body !== 'string') return body;

  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

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
