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
import { lookupReadBytes } from './request-body-provenance.js';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

const DEFAULT_RESPONSE_BODY_CAP = 512 * 1024 * 1024;
let responseBodyCap = DEFAULT_RESPONSE_BODY_CAP;

export function setResponseBodyCap(bytes: number | null): void {
  responseBodyCap = bytes === null ? DEFAULT_RESPONSE_BODY_CAP : bytes;
}

export function getResponseBodyCap(): number {
  return responseBodyCap;
}

export const BINARY_CACHE_BODY_CAP = 32 * 1024 * 1024;

export function responseTooLargeError(
  url: string,
  size: number | undefined,
  limit: number = responseBodyCap
): Error {
  const limitMiB = Math.round(limit / (1024 * 1024));
  const sizeNote = size === undefined ? '' : ` (${size} bytes)`;
  return new Error(
    `proxied-fetch: response body for ${url} exceeds the ${limitMiB} MiB download limit${sizeNote}; ` +
      'download it in ranges (curl -r) or from a native float'
  );
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

import {
  apiHeaders,
  getChromeExtensionRealm,
  getExtensionDelegateId,
  resolveApiUrl,
} from '../base/api-endpoint.js';

export {
  apiHeaders,
  assertLocalBridgeAcceptsToken,
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

function resolveFetchProxyUrl(): string {
  return resolveApiUrl('/api/fetch-proxy');
}

export { isTextContentType };

export async function readResponseBody(
  resp: Response,
  url?: string,
  onChunk?: (loaded: number) => void,
  expectedLength?: number,
  limit: number = responseBodyCap
): Promise<Uint8Array> {
  const contentType = resp.headers.get('content-type') ?? '';
  const hinted = expectedLength ?? contentLengthOf(resp.headers);
  if (hinted !== undefined && hinted > limit) {
    await resp.body?.cancel().catch(() => undefined);
    throw responseTooLargeError(url ?? resp.url, hinted, limit);
  }
  const bytes = await readBodyBytes(resp, url ?? resp.url, onChunk, hinted, limit);
  parkBinaryBody(bytes, contentType, url);
  return bytes;
}

function parkBinaryBody(bytes: Uint8Array, contentType: string, url?: string): void {
  if (isTextContentType(contentType) || bytes.byteLength > BINARY_CACHE_BODY_CAP) return;

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

async function readBodyBytes(
  resp: Response,
  url: string,
  onChunk?: (loaded: number) => void,
  expectedLength?: number,
  limit: number = responseBodyCap
): Promise<Uint8Array<ArrayBuffer>> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();

  let target =
    expectedLength !== undefined && expectedLength > 0 && expectedLength <= limit
      ? new Uint8Array(expectedLength)
      : null;
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
        chunks.push(target.subarray(0, loaded) as Uint8Array<ArrayBuffer>, chunk);
        target = null;
      }
    } else {
      chunks.push(chunk);
    }
    loaded += chunk.byteLength;
    if (loaded > limit) {
      await reader.cancel().catch(() => undefined);
      throw responseTooLargeError(url, undefined, limit);
    }
    onChunk?.(loaded);
  }
  if (target) return loaded === target.byteLength ? target : target.slice(0, loaded);
  return concatChunks(chunks);
}

export const headersToRecord = _headersToRecord;

export interface FetchProgressObserver {
  start(url: string, total: number | undefined): void;
  chunk(url: string, loaded: number, total: number | undefined): void;
  end(url: string): void;
}

export interface ProxiedFetchOptions {
  progress?: FetchProgressObserver;

  maxResponseBytes?: number;
}

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

export function resolveExactRequestBody(
  body: SecureFetchRequestBody | undefined
): SecureFetchRequestBody | undefined {
  if (typeof body !== 'string' || body === '') return body;
  return lookupReadBytes(body) ?? body;
}

export function prepareRequestBody(
  rawBody: SecureFetchRequestBody | undefined,
  headers?: Record<string, string>
): BodyInit | undefined {
  const body = resolveExactRequestBody(rawBody);
  if (body == null || body === '') return undefined;

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

export const encodeForbiddenRequestHeaders = _encodeForbiddenRequestHeaders;

export const decodeForbiddenResponseHeaders = _decodeForbiddenResponseHeaders;

const decodeBase64Chunk = base64ToUint8;

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

export type ProxyRequestOptions = Omit<NonNullable<Parameters<SecureFetch>[1]>, 'body'> & {
  body?: string | Uint8Array;
};

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

interface FetchProxyPort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

interface PreparedPortRequest {
  method: string;

  transportHeaders: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge: boolean;
}

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

function requestAbortSignal(
  options?: ProxyRequestOptions | Parameters<SecureFetch>[1]
): AbortSignal | undefined {
  return (options as { signal?: AbortSignal } | undefined)?.signal;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function collectViaPort(
  connect: () => FetchProxyPort,
  url: string,
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver,
  limit: number = responseBodyCap
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  const { method, transportHeaders, bodyBase64, requestBodyTooLarge } =
    await buildPortRequest(options);
  const signal = requestAbortSignal(options);
  if (signal?.aborted) throw abortError();
  const port = connect();

  return new Promise((resolve, reject) => {
    let headInfo: ProxyHead | null = null;
    let ended = false;
    let loaded = 0;
    let total: number | undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    const fail = (err: Error) => {
      ended = true;
      chunks.length = 0;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
      port.disconnect();
    };
    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    const onHead = (msg: Extract<FetchProxyResponseMsg, { type: 'response-head' }>) => {
      headInfo = { status: msg.status, statusText: msg.statusText, headers: msg.headers };
      total = contentLengthOf(msg.headers);
      if (total !== undefined && total > limit) {
        fail(responseTooLargeError(url, total, limit));
        return;
      }
      progress?.start(url, total);
    };
    const onChunk = (msg: Extract<FetchProxyResponseMsg, { type: 'response-chunk' }>) => {
      if (ended) return;
      const chunk = decodeBase64Chunk(msg.dataBase64);
      loaded += chunk.byteLength;
      if (loaded > limit) {
        fail(responseTooLargeError(url, undefined, limit));
        return;
      }
      chunks.push(chunk);
      progress?.chunk(url, loaded, total);
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener('abort', onAbort);
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

export function collectViaExtensionPort(
  url: string,
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver,
  limit?: number
): Promise<{ head: ProxyHead; body: ArrayBuffer }> {
  return collectViaPort(
    () => chrome.runtime.connect({ name: 'fetch-proxy.fetch' }),
    url,
    options,
    progress,
    limit
  );
}

async function extensionPortFetch(
  url: string,
  options?: Parameters<SecureFetch>[1],
  progress?: FetchProgressObserver,
  limit?: number
): ReturnType<SecureFetch> {
  const { head, body } = await withProgressEnd(progress, url, () =>
    collectViaExtensionPort(url, options, progress, limit)
  );
  return finalizeProxyResponse(head, new Uint8Array(body), url);
}

export async function collectViaExtensionDelegate(
  url: string,
  options?: ProxyRequestOptions,
  progress?: FetchProgressObserver,
  limit?: number
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
  return collectViaPort(
    () => connect(id, { name: 'fetch-proxy.fetch' }),
    url,
    options,
    progress,
    limit
  );
}

export function createProxiedFetch(fetchOptions: ProxiedFetchOptions = {}): SecureFetch {
  const progress = fetchOptions.progress;

  const limitNow = (): number =>
    fetchOptions.maxResponseBytes === undefined
      ? responseBodyCap
      : Math.min(fetchOptions.maxResponseBytes, responseBodyCap);

  if (getChromeExtensionRealm()) {
    return (url, options) => extensionPortFetch(url, options, progress, limitNow());
  }

  if (
    typeof chrome !== 'undefined' &&
    typeof chrome?.runtime?.connect === 'function' &&
    getExtensionDelegateId()
  ) {
    return async (url, options) => {
      const { head, body } = await withProgressEnd(progress, url, () =>
        collectViaExtensionDelegate(url, options, progress, limitNow())
      );
      return finalizeProxyResponse(head, new Uint8Array(body), url);
    };
  }

  if (typeof chrome === 'undefined' && getExtensionDelegateId()) {
    return async (url, options) => {
      const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
      const client = getPanelRpcClient();
      if (!client) {
        throw new Error('proxied-fetch: panel-RPC client unavailable in worker realm');
      }
      const method = options?.method ?? 'GET';

      const plainHeaders = headersToRecord(options?.headers) ?? {};

      const exactBody = resolveExactRequestBody(
        options?.body as SecureFetchRequestBody | undefined
      );

      progress?.start(url, undefined);
      const { head, body } = await withProgressEnd(progress, url, () =>
        client.call(
          'proxied-fetch',
          {
            url,
            method,
            headers: plainHeaders,
            body: exactBody,
          },

          { timeoutMs: 120_000, signal: requestAbortSignal(options) }
        )
      );
      if (body.byteLength > limitNow())
        throw responseTooLargeError(url, body.byteLength, limitNow());
      return finalizeProxyResponse(head, new Uint8Array(body), url);
    };
  }

  return async (url, options) => {
    const method = options?.method ?? 'GET';
    const plainHeaders = headersToRecord(options?.headers);
    const encoded = encodeForbiddenRequestHeaders(plainHeaders);

    const headers: Record<string, string> = apiHeaders({
      ...encoded,
      'X-Target-URL': url,
    });

    const init: RequestInit = { method, headers, cache: 'no-store' };
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    if (signal) init.signal = signal;
    if (options?.body && !['GET', 'HEAD'].includes(method)) {
      const prepared = prepareRequestBody(
        options.body as SecureFetchRequestBody | undefined,
        headers
      );

      if (prepared instanceof Blob) {
        headers['X-Slicc-Raw-Body'] = '1';
      }
      init.body = prepared;
    }

    return withProgressEnd(progress, url, async () => {
      const resp = await fetch(resolveFetchProxyUrl(), init);

      if (isProxyError(resp)) {
        throw new Error(await readProxyErrorMessage(resp));
      }

      const total = contentLengthOf(resp.headers);
      progress?.start(url, total);
      const body = await readResponseBody(
        resp,
        url,
        progress ? (loaded) => progress.chunk(url, loaded, total) : undefined,
        total,
        limitNow()
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
