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
 */
export function createNodeFetchAdapter(secureFetch: SecureFetch): typeof globalThis.fetch {
  return async function nodeFetch(input, init) {
    const url = resolveUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = headersToRecord(init?.headers);
    const body = encodeBody(init?.body, method);

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

    // Response body must be null when the response cannot have a body
    // (status 1xx/204/205/304) — otherwise the constructor throws.
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
  // ReadableStream and other exotics — let String() do its best.
  return String(body);
}
