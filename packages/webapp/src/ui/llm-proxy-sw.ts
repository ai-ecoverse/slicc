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

  // Build the proxied request. Pass the body through as-is so that
  // streaming request bodies (rare but legal — e.g. file uploads,
  // chunked transfer-encoded fetches) flow without being collected
  // into memory. `duplex: 'half'` is required by the spec when the
  // body is a ReadableStream.
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: proxyHeaders,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'manual',
    signal: req.signal,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
    duplex: req.method === 'GET' || req.method === 'HEAD' ? undefined : 'half',
  };

  const response = await fetch(FETCH_PROXY_PATH, init);
  // Return the proxy response unchanged. Its body is a streamed
  // ReadableStream that pipes upstream chunks back to the page caller
  // with no extra buffering — preserving SSE token-by-token UX for LLM
  // completions. Status, headers (including X-Proxy-Set-Cookie and
  // X-Proxy-Error), and body all pass through verbatim.
  return response;
}

// Reference unused import so it survives tree-shaking (the helper is
// re-exported for symmetry with future consumers and shouldn't be
// dropped silently if a bundler decides to be aggressive).
void headersToRecord;
