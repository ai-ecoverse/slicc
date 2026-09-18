import { encodeMultipartFormData, isFormDataBody } from '../../base/multipart-form-data.js';
import {
  type BrowserFetchOptions,
  type BrowserFetchResult,
  buildBrowserFetchScript,
} from './realm-browser-fetch.js';
import { resolveTargetId } from './realm-browser-shared.js';
import type { RealmRpcClient } from './realm-rpc.js';
import type { TabHandle } from './realm-types.js';
import { createWsObserverApi } from './realm-ws-observer.js';

export async function serializeRequestInit(
  init: RequestInit | undefined,
  input: string | URL | Request
): Promise<RequestInit | undefined> {
  if (!init && !(input instanceof Request)) return undefined;
  const fromRequest = input instanceof Request ? input : null;
  const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  } else if (fromRequest) {
    fromRequest.headers.forEach((v, k) => {
      headers[k] = v;
    });
  }
  let body: string | Uint8Array | undefined;
  let defaultContentType: string | undefined;

  const canHaveBody = method !== 'GET' && method !== 'HEAD';
  if (canHaveBody && init?.body !== undefined && init?.body !== null && init?.body !== '') {
    const serialized = await serializeRequestBody(init.body);
    body = serialized.body;
    defaultContentType = serialized.defaultContentType;
  }
  if (
    defaultContentType &&
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  ) {
    headers['Content-Type'] = defaultContentType;
  }
  return {
    method,
    headers,

    body: body as BodyInit | undefined,
  };
}

async function serializeRequestBody(
  body: BodyInit
): Promise<{ body: string | Uint8Array; defaultContentType?: string }> {
  if (typeof body === 'string') return { body };
  if (body instanceof URLSearchParams) {
    return {
      body: body.toString(),
      defaultContentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (body instanceof Blob) {
    return {
      body: new Uint8Array(await body.arrayBuffer()),
      defaultContentType: body.type || 'application/octet-stream',
    };
  }
  if (body instanceof ArrayBuffer) {
    return {
      body: new Uint8Array(body).slice(),
      defaultContentType: 'application/octet-stream',
    };
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { body: bytes.slice(), defaultContentType: 'application/octet-stream' };
  }
  if (isFormDataBody(body)) {
    const multipart = await encodeMultipartFormData(body);
    return { body: multipart.bytes, defaultContentType: multipart.contentType };
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new Error(
      'node fetch shim: ReadableStream request bodies are not supported (collect into a Uint8Array or string before calling fetch)'
    );
  }
  throw new Error(
    `node fetch shim: unsupported request body type (${Object.prototype.toString.call(body)}); use a string, Uint8Array, ArrayBuffer, Blob, FormData, or URLSearchParams`
  );
}

export function createBrowserBridge(rpc: RealmRpcClient) {
  return {
    findTab: (query: { domain?: string; urlMatch?: string | RegExp }): Promise<TabHandle | null> =>
      rpc.call('browser', 'findTab', [normalizeUrlMatchQuery(query)]),
    ensureTab: (url: string, options: { matchUrl?: string | RegExp } = {}): Promise<TabHandle> =>
      rpc.call('browser', 'ensureTab', [url, normalizeMatchUrl(options)]),

    openWindow: (
      url: string,
      options: {
        width?: number;
        height?: number;
        left?: number;
        top?: number;
        state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
        decorated?: boolean;
        focus?: boolean;
      } = {}
    ): Promise<TabHandle> => rpc.call('browser', 'openWindow', [url, options]),

    windowBounds: (
      tab: TabHandle | string
    ): Promise<{
      left: number;
      top: number;
      width: number;
      height: number;
      state: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
      dpr: number;
    }> => rpc.call('browser', 'windowBounds', [resolveTargetId(tab)]),

    setWindowBounds: (
      tab: TabHandle | string,
      bounds: {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        state?: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
      }
    ): Promise<{
      left: number;
      top: number;
      width: number;
      height: number;
      state: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
      dpr: number;
    }> => rpc.call('browser', 'setWindowBounds', [resolveTargetId(tab), bounds]),
    eval: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'eval', [resolveTargetId(tab), serializeEvalSource(fnOrCode, false)]),
    evalAsync: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'evalAsync', [resolveTargetId(tab), serializeEvalSource(fnOrCode, true)]),
    cookie: (tab: TabHandle | string, name: string): Promise<string | null> =>
      rpc.call('browser', 'cookie', [resolveTargetId(tab), name]),
    localStorage: (tab: TabHandle | string, key: string): Promise<string | null> =>
      rpc.call('browser', 'localStorage', [resolveTargetId(tab), key]),
    fetch: (
      tab: TabHandle | string,
      url: string,
      opts: BrowserFetchOptions = {}
    ): Promise<BrowserFetchResult> =>
      buildBrowserFetchScript(url, opts).then((script) =>
        rpc.call('browser', 'evalAsync', [resolveTargetId(tab), script])
      ) as Promise<BrowserFetchResult>,
    websocket: createWsObserverApi(rpc),
  };
}

function serializeEvalSource(
  source: ((..._args: unknown[]) => unknown) | string,
  _awaitPromise: boolean
): string {
  if (typeof source === 'function') {
    return `(${source.toString()})()`;
  }
  if (typeof source === 'string') return source;
  throw new TypeError('browser.eval/evalAsync: source must be a function or string');
}

function normalizeUrlMatchQuery(query: { domain?: string; urlMatch?: string | RegExp }): {
  domain?: string;
  urlMatch?: string;
} {
  const out: { domain?: string; urlMatch?: string } = {};
  if (query.domain !== undefined) out.domain = query.domain;
  if (query.urlMatch !== undefined) {
    out.urlMatch = query.urlMatch instanceof RegExp ? query.urlMatch.source : query.urlMatch;
  }
  return out;
}

function normalizeMatchUrl(options: { matchUrl?: string | RegExp }): { matchUrl?: string } {
  if (options.matchUrl === undefined) return {};
  return {
    matchUrl: options.matchUrl instanceof RegExp ? options.matchUrl.source : options.matchUrl,
  };
}
