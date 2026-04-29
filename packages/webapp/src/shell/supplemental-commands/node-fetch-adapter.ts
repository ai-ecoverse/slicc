/**
 * Adapt the just-bash `SecureFetch` (which is what the curl shim uses to route
 * outbound requests through the CLI server's `/api/fetch-proxy` endpoint, with
 * masked-secret -> real-secret injection) into a function that satisfies the
 * Web Fetch API contract — i.e. `(input, init) => Promise<Response>`.
 *
 * Without this adapter, `node -e "fetch(...)"` resolves `fetch` to the
 * browser's native global, which:
 *   1. Bypasses `/api/fetch-proxy` entirely, so masked secret values
 *      (e.g. the `e5be41af...` placeholders the GWS skill receives) are
 *      sent to upstream APIs literally and rejected with `invalid_client`
 *      / 401 / 403 etc.
 *   2. Is subject to browser CORS rules from the slicc page origin.
 *
 * Wrapping `ctx.fetch` here keeps node `fetch()` on the same proxied path
 * as `curl`, so secret injection, domain allow-listing, and the
 * `X-Proxy-Error` marker all apply.
 */

import type { SecureFetch } from 'just-bash';

/**
 * Build a `globalThis.fetch`-shaped function from a just-bash `SecureFetch`.
 * The returned function returns a real `Response` instance so callers can
 * use `.ok`, `.json()`, `.text()`, `.arrayBuffer()`, `.headers`, etc.
 *
 * Faithfully implements the `fetch(input, init?)` contract:
 *
 * - When `input` is a `Request`, its method, headers, and body are read from
 *   the Request and used as defaults; any field also present in `init`
 *   overrides the Request's value (matching the browser's behavior).
 * - `URLSearchParams` bodies cause `Content-Type:
 *   application/x-www-form-urlencoded;charset=UTF-8` to be set automatically
 *   when no Content-Type was provided — this is what real `fetch` does and
 *   is required for OAuth token endpoints (otherwise Google rejects the
 *   request because the body is treated as `text/plain`).
 */
export function createNodeFetchAdapter(secureFetch: SecureFetch): typeof globalThis.fetch {
  return async function nodeFetch(input, init) {
    const request = input instanceof Request ? input : null;

    const url = resolveUrl(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    // Headers: start with the Request's headers (if any), then layer init.headers
    // on top so explicit init values win — mirroring the browser fetch spec.
    const headers = mergeHeaders(request?.headers, init?.headers);

    // Body: prefer init.body when explicitly provided. When init.body is
    // omitted but a Request was passed, read the Request's body so prebuilt
    // Request objects with auth bodies still go through the proxy intact.
    let body: string | undefined;
    let bodyForContentType: BodyInit | null | undefined;
    if (init && 'body' in init && init.body !== undefined) {
      body = encodeBody(init.body, method);
      bodyForContentType = init.body;
    } else if (request && method !== 'GET' && method !== 'HEAD') {
      const buf = await request.arrayBuffer();
      body =
        buf.byteLength === 0 ? undefined : new TextDecoder('utf-8').decode(new Uint8Array(buf));
      bodyForContentType = undefined; // Content-Type already on request.headers
    } else {
      body = undefined;
      bodyForContentType = undefined;
    }

    // Real fetch sets `Content-Type: application/x-www-form-urlencoded;
    // charset=UTF-8` automatically when the body is a URLSearchParams and no
    // Content-Type is explicitly set. Without this, OAuth token POSTs land
    // with the wrong Content-Type and get rejected with `invalid_request`.
    if (
      bodyForContentType instanceof URLSearchParams &&
      headers &&
      !hasHeader(headers, 'content-type')
    ) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }

    const result = await secureFetch(url, {
      method,
      headers,
      body,
    });

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(result.headers)) {
      // Skip headers Response constructor refuses (rare).
      try {
        responseHeaders.set(k, v);
      } catch {
        // ignore unsettable header
      }
    }

    // Response body must be null for 204/205/304 — the constructor rejects
    // a body otherwise. (Note: 1xx informational responses can't be modeled
    // by the Response constructor at all — `init.status must be in the
    // range of 200 to 599`. They never surface here because HTTP libraries
    // consume them transparently before the fetch resolves; we therefore
    // do not special-case 1xx and would re-throw the constructor error.)
    const noBodyStatus = result.status === 204 || result.status === 205 || result.status === 304;
    // Uint8Array is a valid BodyInit at runtime, but the lib.dom.d.ts
    // shipped with TypeScript narrows BodyInit to a set that does not
    // include Uint8Array<ArrayBufferLike>; cast through BodyInit to
    // satisfy the compiler without copying the bytes.
    const responseBody: BodyInit | null =
      noBodyStatus || !result.body || result.body.byteLength === 0
        ? null
        : (result.body as unknown as BodyInit);

    const response = new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: responseHeaders,
    });

    // The `Response` constructor does not allow setting the `url` field —
    // expose the upstream URL via defineProperty so `response.url` matches
    // what real fetch would return. Some runtimes lock the property; if
    // so, fall through silently and `response.url` stays "".
    try {
      Object.defineProperty(response, 'url', {
        value: result.url || url,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // ignore — non-fatal
    }

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

/**
 * Merge a `Request`'s headers (if any) with explicit `init.headers`, with
 * init winning on conflicts — matches how the browser's fetch combines a
 * `Request` input with an `init` argument. Always returns an object so we
 * can attach an auto-Content-Type later if the body is `URLSearchParams`.
 */
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

/** Case-insensitive presence check for a header name in a record. */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * SecureFetch's body type is `string | undefined`, so we coerce common
 * BodyInit shapes (URLSearchParams, ArrayBuffer, typed arrays) into a
 * string. Streaming bodies (Blob, FormData, ReadableStream) throw — they
 * aren't compatible with the proxy contract on the wire today.
 */
function encodeBody(body: BodyInit | null | undefined, method: string): string | undefined {
  if (body == null) return undefined;
  if (method === 'GET' || method === 'HEAD') return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return new TextDecoder('utf-8').decode(body);
  if (body instanceof ArrayBuffer) {
    return new TextDecoder('utf-8').decode(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return new TextDecoder('utf-8').decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    );
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    throw new Error(
      'node fetch shim: Blob request bodies are not supported (use a string, Uint8Array, or URLSearchParams)'
    );
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new Error(
      'node fetch shim: FormData request bodies are not supported (post raw application/x-www-form-urlencoded with URLSearchParams instead)'
    );
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
    throw new Error(
      'node fetch shim: ReadableStream request bodies are not supported (collect into a Uint8Array or string before calling fetch)'
    );
  }
  // Anything else (a non-string non-typed-array object) is unsupported —
  // refuse explicitly instead of silently sending "[object Foo]" through
  // the proxy, which would never match an upstream API contract.
  throw new Error(
    `node fetch shim: unsupported request body type (${Object.prototype.toString.call(body)}); use a string, Uint8Array, ArrayBuffer, or URLSearchParams`
  );
}
