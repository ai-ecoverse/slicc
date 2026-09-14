import type { SecureFetch } from 'just-bash';
import { encodeMultipartFormData, isFormDataBody } from '../../base/multipart-form-data.js';
import { copyUint8, type SecureFetchRequestBody } from '../fetch-body.js';
import { isTextContentType } from '../proxied-fetch.js';

export function createNodeFetchAdapter(secureFetch: SecureFetch): typeof globalThis.fetch {
  return async function nodeFetch(input, init) {
    const request = input instanceof Request ? input : null;

    const url = resolveUrl(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    const headers = mergeHeaders(request?.headers, init?.headers);

    const encoded = await resolveRequestBody(init, request, method, headers);
    if (encoded.defaultContentType && !hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = encoded.defaultContentType;
    }

    const result = await secureFetch(url, {
      method,
      headers,
      body: encoded.body as string | undefined,
    });

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(result.headers)) {
      try {
        responseHeaders.set(k, v);
      } catch {}
    }

    const noBodyStatus = result.status === 204 || result.status === 205 || result.status === 304;

    const responseBody: BodyInit | null =
      noBodyStatus || !result.body || result.body.byteLength === 0
        ? null
        : (result.body as unknown as BodyInit);

    const response = new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: responseHeaders,
    });

    try {
      Object.defineProperty(response, 'url', {
        value: result.url || url,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch {}

    return response;
  };
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headersToRecord(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((v, k) => {
      rec[k] = v;
    });
    return rec;
  }
  if (Array.isArray(headers)) {
    const rec: Record<string, string> = {};
    for (const [k, v] of headers) rec[k] = v;
    return rec;
  }
  return { ...(headers as Record<string, string>) };
}

function mergeHeaders(
  requestHeaders: Headers | undefined,
  initHeaders: HeadersInit | undefined
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (requestHeaders) {
    requestHeaders.forEach((v, k) => {
      merged[k] = v;
    });
  }
  const initRec = headersToRecord(initHeaders);
  if (initRec) {
    for (const [k, v] of Object.entries(initRec)) {
      merged[k] = v;
    }
  }
  return merged;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return getHeader(headers, name) !== undefined;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  let value: string | undefined;
  for (const [key, candidate] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) value = candidate;
  }
  return value;
}

interface EncodedRequestBody {
  body?: SecureFetchRequestBody;
  defaultContentType?: string;
}

async function resolveRequestBody(
  init: RequestInit | undefined,
  request: Request | null,
  method: string,
  headers: Record<string, string>
): Promise<EncodedRequestBody> {
  if (init && 'body' in init && init.body !== undefined) {
    return encodeInitBody(init.body, method);
  }

  if (request && method !== 'GET' && method !== 'HEAD') {
    const hadBody = request.body !== null;
    const bytes = new Uint8Array(await request.arrayBuffer());
    const contentType = getHeader(headers, 'content-type') ?? '';
    const isBinary = hadBody && (!contentType || !isTextContentType(contentType));
    return {
      body:
        bytes.byteLength === 0
          ? undefined
          : isBinary
            ? copyUint8(bytes)
            : new TextDecoder('utf-8').decode(bytes),
      defaultContentType: isBinary ? 'application/octet-stream' : undefined,
    };
  }

  return {};
}

async function encodeInitBody(
  body: BodyInit | null | undefined,
  method: string
): Promise<EncodedRequestBody> {
  if (isFormDataBody(body)) {
    if (method === 'GET' || method === 'HEAD') return {};
    const multipart = await encodeMultipartFormData(body);
    return { body: multipart.bytes, defaultContentType: multipart.contentType };
  }
  return {
    body: await encodeBody(body, method),
    defaultContentType: getDefaultContentType(body, method),
  };
}

async function encodeBody(
  body: BodyInit | null | undefined,
  method: string
): Promise<SecureFetchRequestBody | undefined> {
  if (body == null) return undefined;
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return copyUint8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body).slice();
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
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

function isRawBinaryBody(body: BodyInit | null | undefined): boolean {
  return (
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob)
  );
}

function getDefaultContentType(
  body: BodyInit | null | undefined,
  method: string
): string | undefined {
  if (body instanceof URLSearchParams) {
    return 'application/x-www-form-urlencoded;charset=UTF-8';
  }
  if (method === 'GET' || method === 'HEAD' || !isRawBinaryBody(body)) return undefined;
  if (typeof Blob !== 'undefined' && body instanceof Blob && body.type) return body.type;
  return 'application/octet-stream';
}
