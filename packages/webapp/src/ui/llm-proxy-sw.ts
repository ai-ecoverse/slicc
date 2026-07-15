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

import { BRIDGE_TOKEN_HEADER } from '@slicc/shared-ts';
import {
  SYNC_FS_NEED_NONCE_MSG,
  SYNC_FS_NONCE_MSG,
  type SyncFsNeedNonceMsg,
  type SyncFsNonce,
  syncFsChannelName,
} from '../kernel/realm/sync-fs-wire.js';
import { encodeForbiddenRequestHeaders, headersToRecord } from '../shell/proxy-headers.js';
import { buildDelegatedResponseStream } from './llm-proxy-extension-delegate.js';
import { synthesizeForwardResponse } from './llm-proxy-response.js';
import {
  BridgeConfigCache,
  ExtensionDelegateCache,
  type ExtensionFetchDelegateRequest,
  isBridgeConfigMessage,
  isBridgeLocalApiUrl,
  isExtensionDelegateMessage,
  isPassthroughDestination,
  maySetSyncFsNonce,
  parseExtensionDelegateFromClientUrl,
  type ResolvedExtensionDelegate,
  resolveBridgeFromClientUrls,
  resolveExtensionDelegate,
  resolveFetchProxyTarget,
  SW_EXTENSION_FETCH_MESSAGE,
} from './llm-proxy-sw-config.js';
import {
  handleSyncFsRequest,
  parseSyncFsRequest,
  SYNC_FS_ERRNO_HEADER,
  SYNC_FS_MARKER_HEADER,
  SYNC_FS_ROUTE_PREFIX,
} from './sync-fs-sw-handler.js';

declare const self: ServiceWorkerGlobalScope;

const FETCH_PROXY_PATH = '/api/fetch-proxy';
const BYPASS_HEADER = 'x-bypass-llm-proxy';

/**
 * Bridge config cache populated by the page → SW `postMessage` posted
 * from `boot/setup-sw-registration.ts` after the SW becomes the
 * controller (and re-posted on `controllerchange`). Keyed by the
 * posting client's id so that two leader tabs at the same hosted
 * origin can't clobber each other — see `BridgeConfigCache` for the
 * rationale. On a cache miss `forwardThroughProxy` falls back to
 * parsing the controlling client's URL so the SW survives
 * eviction/restart without losing thin-bridge mode. Mirrors the
 * page-realm `proxied-fetch.ts` state.
 */
const bridgeConfigCache = new BridgeConfigCache();

/**
 * Extension-delegate config cache, populated by the page → SW
 * `ExtensionDelegateConfigMessage`. Same keying rationale as
 * `bridgeConfigCache`. On a cache miss `forwardThroughProxy` falls back to
 * parsing the pinned-leader params (`slicc=leader` + `ext=<id>`) from the
 * candidate client URLs, so the SW recovers delegate mode after eviction and
 * for worker-originated fetches (the kernel DedicatedWorker URL carries no
 * params). See `llm-proxy-sw-config.ts` for the architecture note.
 */
const extensionDelegateCache = new ExtensionDelegateCache();

/** Max delegated request body we base64-encode before flagging too-large. */
const DELEGATE_REQUEST_BODY_CAP = 32 * 1024 * 1024;

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

// Thin-bridge config push from the page. Only acts on the tagged
// message shape so unrelated SW postMessage traffic (e.g. future
// page→SW signaling) doesn't corrupt the bridge state. The posting
// client's id keys the cache so two leader tabs at the same hosted
// origin don't clobber each other's bridge / token state.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const source = event.source;
  // `source` may be Client | ServiceWorker | MessagePort | null. Only
  // Client carries the `id` we key the cache on; anything else is
  // dropped silently — the page-side bootstrap only sends from window
  // clients, so a non-Client sender is either an unrelated message or
  // a future channel we haven't wired up yet.
  if (!source || !('id' in source) || typeof source.id !== 'string') return;
  if (isBridgeConfigMessage(event.data)) {
    bridgeConfigCache.set(source.id, {
      apiBaseUrl: event.data.apiBaseUrl,
      token: event.data.token,
    });
    return;
  }
  if (isExtensionDelegateMessage(event.data)) {
    extensionDelegateCache.set(source.id, { extensionId: event.data.extensionId });
    return;
  }
  const d = event.data as { type?: string; nonce?: string } | undefined;
  if (d?.type === SYNC_FS_NONCE_MSG && typeof d.nonce === 'string') {
    // SECURITY: only a NON-NESTED same-origin window (top-level/auxiliary — in
    // practice the leader page) may add a channel nonce; see `maySetSyncFsNonce`.
    // A `worker` client (a realm) or a `nested` window client (a same-origin
    // srcdoc sprinkle/dip iframe) is rejected, so neither can add a channel and
    // harvest/spoof other realms' sync-fs traffic.
    if (maySetSyncFsNonce(source)) addSyncFsNonce(d.nonce);
    return;
  }
});

self.addEventListener('fetch', (event: FetchEvent) => {
  const req = event.request;
  if (req.headers.get(BYPASS_HEADER) === '1') return;
  if (isPassthroughDestination(req.destination)) return;

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

  event.respondWith(forwardThroughProxy(req, event.clientId || null));
});

// ---------------------------------------------------------------------------
// Synchronous-fs bridge route (`/__slicc/fs-sync/*`).
//
// The proxy listener above ignores same-origin fetches, so the sync-fs route
// needs its OWN respondWith'ing listener (first respondWith wins, so this
// coexists with the proxy listener and the importScripts'd preview-sw). A
// realm's synchronous XHR is answered here by round-tripping over the
// per-session nonce-named BroadcastChannel(s) (`slicc-sync-fs-<nonce>`) to the
// kernel-worker responder (`sync-fs-responder.ts`), which reads/writes the
// CALLING realm's own ctx.fs.
// ---------------------------------------------------------------------------
// Per-session nonces naming the sync-fs channels — each same-origin leader tab
// mints its own and delivers it over `postMessage` (never on a realm-observable
// channel). Held in memory only; an MV3 SW eviction+respawn drops them and
// re-requests them from the page(s) (see the fetch handler's
// `requestSyncFsNonce` path). Until at least one arrives, sync-fs fails closed
// (`EIO`), never leaking or hanging.
//
// A SET of channels (not a single nonce) is required: this SW is shared across
// every same-origin client, so two leader tabs publish two distinct nonces and
// each tab's kernel-worker responder listens only on its OWN. We keep a channel
// per nonce and fan every request out to all of them; the responder's
// token-ownership silence (`sync-fs-responder.ts`) guarantees only the owning
// worker answers. A single last-writer-wins nonce would orphan every tab but
// the most-recent publisher (its ops stall to the SW timeout, then EIO).
const syncFsChannels = new Map<string, BroadcastChannel>();
function getSyncFsChannels(): BroadcastChannel[] {
  return [...syncFsChannels.values()];
}
function addSyncFsNonce(nonce: string): void {
  // `nonce` arrives as an opaque string on an untrusted `postMessage`; the gate
  // (`maySetSyncFsNonce`) has already vetted the SENDER. Re-brand it here for
  // `syncFsChannelName` — this is the SW's channel-name boundary.
  if (syncFsChannels.has(nonce)) return;
  syncFsChannels.set(nonce, new BroadcastChannel(syncFsChannelName(nonce as SyncFsNonce)));
}
async function requestSyncFsNonce(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window' });
  const msg: SyncFsNeedNonceMsg = { type: SYNC_FS_NEED_NONCE_MSG };
  for (const c of clients) c.postMessage(msg);
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SYNC_FS_ROUTE_PREFIX)) return;
  event.respondWith(
    (async () => {
      const req = await parseSyncFsRequest(event.request);
      // Prefix already matched above, so a null parse means a malformed path
      // (bad percent-encoding from an untrusted caller) → fail closed EINVAL,
      // never a network fallthrough that could return SPA HTML.
      if (!req) {
        return new Response('sync-fs bridge: malformed path', {
          status: 400,
          headers: { [SYNC_FS_ERRNO_HEADER]: 'EINVAL', [SYNC_FS_MARKER_HEADER]: '1' },
        });
      }
      const channels = getSyncFsChannels();
      if (channels.length === 0) {
        // No nonce yet (fresh boot before the page's post, or a post-eviction
        // respawn). Ask the page(s) to (re)publish so the NEXT request works,
        // and fail THIS one closed — never hang, never a wrong answer.
        void requestSyncFsNonce();
        return new Response('sync-fs bridge not ready', {
          status: 503,
          headers: { [SYNC_FS_ERRNO_HEADER]: 'EIO', [SYNC_FS_MARKER_HEADER]: '1' },
        });
      }
      return handleSyncFsRequest(channels, req);
    })()
  );
});

async function forwardThroughProxy(req: Request, clientId: string | null): Promise<Response> {
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

  // Thin-bridge: rewrite the forward target onto the local node-server's
  // origin and attach the per-process bridge token. Per-client cache
  // lookup keyed by the triggering FetchEvent's `clientId` keeps two
  // leader tabs at the same hosted origin isolated. Cache miss falls
  // back to parsing `bridge`/`bridgeToken` from the triggering client
  // URL; if that client is a worker (kernel DedicatedWorker → no
  // launch params) or unknown, we additionally enumerate the page
  // window clients so the SW recovers bridge mode after eviction +
  // worker-originated fetches. Same-origin (non-bridge) callers keep
  // the legacy `/api/fetch-proxy` path with no token header — mirrors
  // `proxied-fetch.ts` gating.
  const cached = bridgeConfigCache.get(clientId);
  const cachedDelegate = extensionDelegateCache.get(clientId);
  const triggeringClientUrl = await readClientUrl(clientId);
  // The expensive `clients.matchAll` window enumeration only runs when
  // neither cache resolves — the fallback for worker-originated fetches
  // (the kernel DedicatedWorker URL carries no launch params).
  const windowClientUrls = cached || cachedDelegate ? [] : await readWindowClientUrls();
  const candidateUrls = [triggeringClientUrl, ...windowClientUrls];

  // Extension-delegate mode takes precedence over the thin-bridge rewrite:
  // the pinned leader tab (hosted origin, externally-connectable) routes
  // cross-origin LLM fetches through the extension's secret-aware fetch
  // proxy via a window client + `chrome.runtime` Port. A window client must
  // exist to delegate to; if none is reachable we fall through to the
  // standard path rather than hang. See `llm-proxy-sw-config.ts`.
  const delegate = resolveExtensionDelegate(cachedDelegate, candidateUrls);
  if (delegate) {
    const delegateClient = await pickDelegateWindowClient();
    if (delegateClient) {
      return forwardViaExtensionDelegate(req, delegate, delegateClient, targetUrl);
    }
  }

  const bridge = resolveBridgeFromClientUrls(cached, candidateUrls);

  // Bridge local-API pass-through: direct calls to any `/api/*` endpoint
  // on the local node-server must reach it with the caller's original headers
  // intact (including `X-Bridge-Token`). Re-routing through fetch-proxy would
  // strip the bridge token (it's in FETCH_PROXY_SKIP_HEADERS) and decode
  // X-Proxy-Origin back onto the internal request, causing the node-server's
  // CORS middleware to reject with `bridge-token-required`. Re-fetch with the
  // bypass header so this SW instance does not re-intercept the outgoing call.
  if (bridge && isBridgeLocalApiUrl(req.url, bridge.apiBaseUrl)) {
    const passHeaders = new Headers(req.headers);
    passHeaders.set(BYPASS_HEADER, '1');
    const passInit: RequestInit = {
      method: req.method,
      headers: passHeaders,
      cache: 'no-store',
      credentials: req.credentials,
      redirect: 'manual',
      signal: req.signal,
      body: await readForwardBody(req),
    };
    return synthesizeForwardResponse(await fetch(req.url, passInit));
  }

  if (bridge) {
    proxyHeaders.set(BRIDGE_TOKEN_HEADER, bridge.token);
  }
  const forwardUrl = resolveFetchProxyTarget(FETCH_PROXY_PATH, bridge);

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
  const response = await fetch(forwardUrl, init);
  // Wrap in a synthetic Response (see `llm-proxy-response.ts` for
  // the full rationale). Body stays a streamed ReadableStream so
  // SSE token-by-token UX for LLM completions is unchanged.
  return synthesizeForwardResponse(response);
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

/**
 * Resolve the controlling client's URL for the bridge-config fallback
 * path. Returns `null` when the client is unknown (e.g. background
 * fetch, deleted tab) — the caller treats that as cache-only mode.
 */
async function readClientUrl(clientId: string | null): Promise<string | null> {
  if (!clientId) return null;
  try {
    const client = await self.clients.get(clientId);
    return client?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Enumerate page window clients for the bridge-config fallback. Used
 * when the triggering fetch came from the kernel DedicatedWorker (whose
 * URL has no launch params) or an unknown client. Guarded so a clients
 * API hiccup can't throw inside the fetch handler — on any error we
 * return `[]` and the caller treats it as cache-only mode.
 */
async function readWindowClientUrls(): Promise<string[]> {
  try {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    return clients.map((c) => c.url).filter((u): u is string => !!u);
  } catch {
    return [];
  }
}

/**
 * Pick the window client to delegate a fetch to. Prefers a pinned-leader-tab
 * client (`slicc=leader` + `ext=<id>`) so the message lands on the realm that
 * can reach `chrome.runtime`; otherwise falls back to the first window client.
 * Returns `null` when no window client is reachable.
 */
async function pickDelegateWindowClient(): Promise<Client | null> {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length === 0) return null;
    const leader = clients.find((c) => parseExtensionDelegateFromClientUrl(c.url) !== null);
    return leader ?? clients[0];
  } catch {
    return null;
  }
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Delegate a cross-origin fetch to a window client (the pinned leader tab),
 * which forwards it to the extension's fetch proxy over a `chrome.runtime`
 * Port and pipes the response back over the transferred `MessagePort`. The
 * returned `Response` streams as `response-chunk`s arrive, so SSE UX is
 * preserved end-to-end.
 */
async function forwardViaExtensionDelegate(
  req: Request,
  delegate: ResolvedExtensionDelegate,
  client: Client,
  targetUrl: string
): Promise<Response> {
  const inboundHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === BYPASS_HEADER) return;
    inboundHeaders[key] = value;
  });
  const headers = encodeForbiddenRequestHeaders(inboundHeaders);

  let bodyBase64: string | undefined;
  let requestBodyTooLarge = false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > DELEGATE_REQUEST_BODY_CAP) {
      requestBodyTooLarge = true;
    } else if (buf.byteLength > 0) {
      bodyBase64 = encodeBase64Bytes(new Uint8Array(buf));
    }
  }

  const channel = new MessageChannel();
  const { responsePromise } = buildDelegatedResponseStream(channel.port1);
  const envelope: ExtensionFetchDelegateRequest = {
    type: SW_EXTENSION_FETCH_MESSAGE,
    requestId: randomRequestId(),
    extensionId: delegate.extensionId,
    request: { url: targetUrl, method: req.method, headers, bodyBase64, requestBodyTooLarge },
  };
  client.postMessage(envelope, [channel.port2]);
  return responsePromise;
}

function randomRequestId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Reference unused import so it survives tree-shaking (the helper is
// re-exported for symmetry with future consumers and shouldn't be
// dropped silently if a bundler decides to be aggressive).
void headersToRecord;
