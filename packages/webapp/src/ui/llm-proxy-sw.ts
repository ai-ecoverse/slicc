/**
 * LLM-proxy Service Worker — intercepts cross-origin fetches initiated by
 * any page within scope `/` (CLI standalone mode) and forwards them through
 * the local server's `/api/fetch-proxy` endpoint.
 *
 * Why a service worker?
 *
 * Pi-ai's stock providers (`openai`, `anthropic`, `google`, etc.) use the
 * vendor SDKs which call `globalThis.fetch` directly against `api.openai.com`,
 * `opencode.ai`, etc. Those cross-origin calls are blocked by CORS in the
 * browser unless we route them through the same-origin proxy server. The
 * existing slicc-only `bedrock-camp` provider hand-rolled an
 * `isExtension ? targetUrl : '/api/fetch-proxy'` branch — but doing that
 * for every provider doesn't scale, and we don't want to maintain a copy
 * of each pi-ai stream function.
 *
 * The SW is the cleanest "inject the proxied fetch" point: page code
 * (including third-party SDKs) keeps using `globalThis.fetch` unchanged,
 * and the SW transparently rewrites cross-origin requests to
 * `/api/fetch-proxy` with `X-Target-URL` and the forbidden-header
 * transport. Streaming SSE responses pass through end-to-end because the
 * browser's `fetch` returns a real `Response` whose `body` is a chunked
 * `ReadableStream`.
 *
 * Pass-through bands:
 *   - Same-origin requests (incl. `/api/fetch-proxy` itself, HMR,
 *     `/preview/*` which the more-specific preview SW handles)
 *   - Non-http(s) protocols (`data:`, `blob:`, `chrome-extension:`)
 *   - Requests carrying an `x-bypass-llm-proxy: 1` opt-out header
 *   - Extension mode never registers this SW (host_permissions handle CORS)
 *
 * Built as a standalone IIFE bundle (mirrors `preview-sw.ts`'s build path
 * in `vite.config.ts`).
 */

/// <reference lib="webworker" />

import { encodeForbiddenRequestHeaders, headersToRecord } from '../shell/proxy-headers.js';

declare const self: ServiceWorkerGlobalScope;

const FETCH_PROXY_PATH = '/api/fetch-proxy';
const BYPASS_HEADER = 'x-bypass-llm-proxy';

// Pull in preview-sw so its fetch handler runs in this SW's context.
//
// Why: this SW is registered at scope `/` so that it controls the main
// SLICC page and can intercept cross-origin fetches issued by pi-ai
// providers. But the SW spec says a controlled client's fetches go to
// THE controlling SW only — sub-scope SWs (preview-sw at `/preview/`)
// never see them. Without this importScripts, every `/preview/*`
// request from the page would slip past preview-sw, fall through to
// the dev server, get SPA-fallback'd to `/index.html`, and render the
// full SLICC UI inside the requesting context (e.g. dip iframes,
// causing visible "infinite recursion"). Loading preview-sw.js here
// registers its fetch handler in the same global; the first handler
// that calls `event.respondWith` wins, so /preview/* keeps working
// exactly as before and we just add the cross-origin rewrite on top.
self.importScripts('/preview-sw.js');

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.headers.get(BYPASS_HEADER) === '1') return;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Same-origin: pass straight through. This deliberately includes the
  // proxy endpoint itself (no infinite loop) and the `/preview/*`
  // requests preview-sw (importScripts'd above) handles in this same
  // SW context.
  if (url.origin === self.location.origin) return;

  // Non-network protocols: nothing for us to do.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(forwardThroughProxy(req));
});

async function forwardThroughProxy(req: Request): Promise<Response> {
  const targetUrl = req.url;
  const inboundHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    // Strip SW-internal headers so they never leak upstream. The
    // bypass header is checked at the top of the fetch handler; if we
    // got here it was either absent or set to a non-"1" value, so
    // forwarding it to api.openai.com etc. is meaningless and a tiny
    // information leak.
    if (key.toLowerCase() === BYPASS_HEADER) return;
    inboundHeaders[key] = value;
  });
  const encoded = encodeForbiddenRequestHeaders(inboundHeaders);
  // The proxy endpoint expects the real upstream URL via X-Target-URL
  // and uses X-Proxy-* siblings for forbidden headers (Cookie/Origin/
  // Referer/Proxy-*). See `packages/node-server/src/index.ts` and
  // `packages/swift-server/Sources/Server/APIRoutes.swift` for the
  // matching server-side restoration logic.
  const proxyHeaders = new Headers();
  for (const [key, value] of Object.entries(encoded)) {
    proxyHeaders.set(key, value);
  }
  proxyHeaders.set('X-Target-URL', targetUrl);

  const body = await readForwardBody(req);
  const init: RequestInit = {
    method: req.method,
    headers: proxyHeaders,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'manual',
    signal: req.signal,
    body,
  };

  // Let any fetch rejection (including AbortError from req.signal and the
  // intermittent Chrome SW "Failed to fetch") propagate to the page caller
  // unchanged. Wrapping these into a synthetic 502 here would (a) convert
  // user-/timeout-cancellations into infrastructure errors and (b) break
  // unrelated callers like validateApiKey() which depend on rejected
  // fetches to classify transient outages as `kind: 'skipped'`.
  const response = await fetch(FETCH_PROXY_PATH, init);
  // Wrap in a synthetic Response. Critical for ESM module imports:
  // when a SW responds with a Response that was itself produced by
  // a `fetch(/api/fetch-proxy)`, the consumer sees
  // `response.url = "localhost:5710/api/fetch-proxy"` and resolves
  // any relative sub-imports against THAT — which 404s through the
  // SPA fallback. Synthetic Responses have no own URL, so the SW
  // contract surfaces them as the original request URL and relative
  // imports point back at the same cross-origin host (where they're
  // re-intercepted and proxied again). Body remains a streamed
  // ReadableStream so SSE token-by-token UX still works for LLM
  // completions; status, headers, and body pass through verbatim.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readForwardBody(req: Request): Promise<BodyInit | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;

  // Do not forward req.body directly here. Chrome can intermittently
  // reject the SW's same-origin proxy fetch when we hand it the intercepted
  // request stream, yielding an opaque "Failed to fetch" before
  // /api/fetch-proxy sees the request. LLM provider requests are JSON
  // payloads, so buffering the body is the more reliable transport.
  const body = await req.arrayBuffer();
  return body.byteLength > 0 ? body : undefined;
}

// Reference unused import so it survives tree-shaking (the helper is
// re-exported for symmetry with future consumers and shouldn't be
// dropped silently if a bundler decides to be aggressive).
void headersToRecord;
