import { ELECTRON_OVERLAY_APP_PATH, SLICC_HOSTED_ORIGIN } from '@slicc/shared-ts';
import { buildApiCatalogResponse } from './api-catalog.js';
import { buildAppSiteAssociationResponse } from './apple-app-site-association.js';
import { matchHashedAssetPath, mimeForAssetPath } from './asset-archive.mjs';
import { handleCloudCallback, handleCloudCallbackScript } from './auth/cloud-callback.js';
import { handleBiscottoList, handleBiscottoMint, handleBiscottoStop } from './biscotto-routes.js';
import { CloudSessionsDurableObject } from './cloud/cloud-sessions-do.js';
import { handleAdminStats } from './cloud/handler-admin.js';
import { handleCloudConfig } from './cloud/handler-config.js';
import { handleSignOut } from './cloud/handler-signout.js';
import {
  handleConeConfig,
  handleKill,
  handleList,
  handlePause,
  handleResume,
  handleStart,
} from './cloud/handlers.js';
import { getProxyEndpoint } from './cloud/proxy-config.js';
import { handleFlagsRequest } from './flags.js';
import { buildHandoffResponse } from './handoff-page.js';
import {
  buildInstallCliPowershellResponse,
  buildInstallCliScriptResponse,
  handleCliDownload,
} from './install-cli.js';
import knownGoodMacos from './known-good-macos.json';
import { applySliccLinks } from './links.js';
import { buildLlmsTxtResponse } from './llms-txt.js';
import {
  handleOAuthMethodNotAllowed,
  handleOAuthPreflight,
  handleOAuthRevoke,
  handleOAuthToken,
} from './oauth-exchange.js';
import { handlePreviewRequest } from './preview-handler.js';
import { previewTokenFromHost } from './preview-host.js';
import {
  handlePreviewFinalize,
  handlePreviewList,
  handlePreviewMint,
  handlePreviewStop,
  handlePreviewUpload,
  handleTraySupersede,
} from './preview-routes.js';
import { buildPrivacyResponse } from './privacy.js';
import { buildRelResponse } from './rel-docs.js';
import { SessionTrayDurableObject } from './session-tray.js';
import {
  type CreateTrayRequest,
  createCapabilityToken,
  type DurableObjectNamespaceLike,
  jsonResponse,
  parseCapabilityToken,
  wantsJSON,
} from './shared.js';

const SLICC_HOSTED_HOSTNAME = new URL(SLICC_HOSTED_ORIGIN).hostname;

export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  CLOUD_SESSIONS: DurableObjectNamespaceLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ASSET_ARCHIVE: R2Bucket;
  PREVIEW_STORAGE: R2Bucket;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  /** APNs token auth for follower push (issue #2062); all four or pushing is off. */
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_TOPIC?: string;
  E2B_API_KEY?: string;
  ADOBE_PROXY_ENDPOINT?: string;
  IMS_RELAY_URL?: string;
  ALLOWED_EMAIL_DOMAIN?: string;
  BLOCKED_EMAILS?: string;
  REQUIRE_OWNER_ORG?: string;
  ADMIN_USER_IDS?: string;
  CONE_CAP_RUNNING?: string;
  CONE_CAP_PAUSED?: string;
  ALLOWED_CLOUD_DASHBOARD_ORIGINS?: string;
  FEATURE_FLAGS?: unknown;
  /**
   * Space-separated origins permitted to frame the `?cherry=1` SPA. Empty/unset = deny.
   * A bare `*` token (alone or among origins) opens framing to arbitrary
   * third-party pages and emits `frame-ancestors *` (the CSP wildcard).
   */
  ALLOWED_CHERRY_HOST_ORIGINS?: string;
  /**
   * Cloudflare `version_metadata` binding. Unbound in `wrangler dev` and in
   * unit tests, so every read must tolerate `undefined`.
   */
  CF_VERSION_METADATA?: { id?: string };
}

const UNKNOWN_WORKER_VERSION = 'unknown';

/**
 * Deployed Worker version ID for the public health document — the field that
 * distinguishes "deploy reported success" from "the new build is serving
 * traffic". Nothing else from the binding is exposed: `/status` is
 * unauthenticated, so it carries an opaque version ID and no config.
 */
export function resolveWorkerVersion(env: Pick<WorkerEnv, 'CF_VERSION_METADATA'>): string {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === 'string' && id.length > 0 ? id : UNKNOWN_WORKER_VERSION;
}

/**
 * Resolve the `frame-ancestors` value for a `?cherry=1` response from the
 * `ALLOWED_CHERRY_HOST_ORIGINS` env var.
 *
 * - empty / unset → `'none'` (deny — default)
 * - contains `*`  → `*` (arbitrary third-party embedding, wildcard wins)
 * - otherwise     → the space-separated origin allowlist as configured
 *
 * Exported for tests.
 */
export function resolveCherryFrameAncestors(allowed: string | undefined): string {
  const trimmed = (allowed ?? '').trim();
  if (trimmed.length === 0) return "'none'";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.includes('*')) {
    // `*` matches only HTTP(S)/same-scheme ancestors — it does NOT authorize a
    // chrome-extension:// parent. Keep explicit extension origins alongside it.
    const ext = tokens.filter((t) => t.startsWith('chrome-extension://'));
    return ext.length ? ['*', ...ext].join(' ') : '*';
  }
  return tokens.join(' ');
}

/**
 * Build the `connect-src` directive for the served leader (cloud dashboard SPA)
 * as an explicit allowlist. Sources, in order:
 *
 * - `'self'` — same-origin XHR/fetch/WS
 * - the Adobe LLM proxy origin — sourced from `ADOBE_PROXY_ENDPOINT` env var,
 *   falling back to the default proxy URL; only the origin is emitted (path
 *   stripped) so the directive stays CSP-valid even if the env value carries
 *   a path or trailing slash
 * - both Adobe IMS hosts (prod + stg1) for OAuth flows
 * - `ws://localhost:*` and `ws://127.0.0.1:*` for the local bridge WebSocket
 *   that the leader opens to a host-machine node-server / swift-server picking
 *   a dynamic port. The real security gate for the bridge is the node-side
 *   origin allowlist + subprotocol token, not this CSP — port wildcards are
 *   safe here.
 *
 * No bare `*` is permitted — this is an explicit allowlist by design.
 *
 * Exported for tests.
 */
export function buildLeaderConnectSrc(env: { ADOBE_PROXY_ENDPOINT?: string }): string {
  let proxyOrigin: string;
  try {
    proxyOrigin = new URL(getProxyEndpoint(env)).origin;
  } catch {
    proxyOrigin = 'https://adobe-llm-proxy.paolo-moz.workers.dev';
  }
  return [
    "'self'",
    proxyOrigin,
    'https://ims-na1.adobelogin.com',
    'https://ims-na1-stg1.adobelogin.com',
    'ws://localhost:*',
    'ws://127.0.0.1:*',
  ].join(' ');
}

/**
 * Fallback `ExecutionContext` for the many `handleWorkerRequest` / `worker.fetch`
 * call sites (tests, internal helpers) that do not thread a real ctx. Its
 * `waitUntil` is a no-op, so a `cache.put` scheduled through it simply is not
 * awaited — harmless for correctness (the response is already returned).
 */
const NOOP_CTX: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const ASSET_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * #1330 retention: serve a content-hashed `/assets/*` chunk from the R2 archive
 * when the current build no longer has it, so a long-lived tab keeps fetching
 * its own build's lazy chunks after a deploy instead of getting the SPA shell
 * (which would fail as a dynamic-import). ASSETS-first; R2 only on a miss.
 *
 * Conditional (304/412) and Range (206) are intentionally NOT implemented —
 * archived chunks are small, immutable, content-hashed, and fetched in full.
 * Every request (incl. any carrying `Range`/`If-*`) gets a full `200` (or a
 * bodyless `HEAD`). Never `500`s an asset — any R2/cache error falls back to
 * the classification-probe shell (HEAD → bodyless).
 */
async function serveAssetWithArchiveFallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const isHead = request.method === 'HEAD';

  // Classify present-vs-miss with a sanitized canonical GET so Range/conditional
  // headers can't make ASSETS answer 206/304 for the shell.
  const hasCond =
    request.headers.has('range') ||
    request.headers.has('if-none-match') ||
    request.headers.has('if-modified-since') ||
    request.headers.has('if-match') ||
    request.headers.has('if-unmodified-since');
  const probe = hasCond
    ? await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }))
    : await env.ASSETS.fetch(request); // plain GET/HEAD: original IS the probe
  const probeCT = probe.headers.get('content-type') ?? '';
  const isMiss = (probe.status === 200 && probeCT.includes('text/html')) || probe.status === 404;

  if (!isMiss) {
    // Present: for a plain GET/HEAD the probe IS the answer; only a conditional/
    // Range request needs the original re-fetched so the platform honors it.
    return hasCond ? env.ASSETS.fetch(request) : probe;
  }

  // Miss → archive. Cache only plain GET (HEAD bypasses).
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  if (!isHead) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache read failure → fall through to R2; never 500 an asset */
    }
  }

  let obj: R2ObjectBody | null = null;
  try {
    obj = await env.ASSET_ARCHIVE.get(url.pathname.slice(1)); // no onlyIf/range
  } catch {
    obj = null;
  }
  if (!obj) {
    // Fallback to the shell; a HEAD must stay bodyless.
    return isHead ? new Response(null, { status: probe.status, headers: probe.headers }) : probe;
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', mimeForAssetPath(url.pathname));
  headers.set('etag', obj.httpEtag);
  headers.set('last-modified', obj.uploaded.toUTCString());
  headers.set('cache-control', ASSET_IMMUTABLE);
  headers.set('content-length', String(obj.size));

  if (isHead) return new Response(null, { status: 200, headers });

  const res = new Response(obj.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}

async function serveSPA(request: Request, env: WorkerEnv): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const out = new Response(res.body, res); // clone for mutable headers

  if (url.searchParams.get('cherry') === '1') {
    const ancestors = resolveCherryFrameAncestors(env.ALLOWED_CHERRY_HOST_ORIGINS);
    out.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    // Cherry and non-cherry responses must never share a cache entry.
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Vary', 'Sec-Fetch-Dest');
  } else if (
    url.pathname === ELECTRON_OVERLAY_APP_PATH ||
    url.pathname === `${ELECTRON_OVERLAY_APP_PATH}/`
  ) {
    // Electron thin-overlay must be framable by its embedding app. We OMIT the
    // frame-ancestors directive entirely (no CSP frame-ancestors header at all):
    // the overlay is injected into arbitrary local apps including file:// apps
    // whose embedder origin is opaque/null, and `frame-ancestors *` does NOT
    // match an opaque origin — only omission allows a null/opaque embedder.
    out.headers.delete('Content-Security-Policy');
    // Mirror cherry cache-safety so a framable /electron response can never
    // share a cache entry with a would-be denied one.
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Vary', 'Sec-Fetch-Dest');
  } else {
    out.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    // Per-document cross-origin isolation (#2036): grants the leader (and
    // its dedicated/nested workers) `crossOriginIsolated` + SharedArrayBuffer
    // WITHOUT COOP/COEP — popups keep window.opener, iframes embed normally,
    // and the controlling service worker keeps controlling (verified live;
    // the COEP↔SW-script compatibility rule does not apply to DIP). First
    // consumer: vpod's guest-network SAB ring buffer. `credentialless` (not
    // `require-corp`) so no-cors cross-origin subresources — gravatars,
    // agent-rendered external images, sprinkle assets — load anonymously
    // instead of being blocked. Unsupported browsers (pre-Chrome-137,
    // non-desktop) ignore the header and degrade to today's non-isolated
    // behavior. This branch also serves `/join`/`/controller` follower pages;
    // isolation is harmless there (no popup/iframe/embedding restrictions),
    // and one unconditional value per URL keeps caching Vary-free. The
    // `?cherry=1` and electron-overlay branches above stay header-free:
    // embedded surfaces run no realms and never needed SAB.
    out.headers.set('Document-Isolation-Policy', 'isolate-and-credentialless');
  }
  return out;
}
const OAUTH_RELAY_HTML = (allowedOrigins: string): string =>
  `<!DOCTYPE html>
<html><head><title>Redirecting to SLICC...</title></head>
<body>
<p id="msg">Redirecting to SLICC...</p>
<script>
try {
  var params = new URLSearchParams(location.search);
  var hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  var raw = params.get('state') || hashParams.get('state');
  if (!raw) throw new Error('Missing state parameter');
  var state = JSON.parse(atob(raw));
  var source = state.source || 'local';
  var path = state.path || '/auth/callback';
  var nonce = state.nonce || '';
  if (!path.startsWith('/')) throw new Error('Invalid path');
  // Forward all original query params (except state, which we consumed) so
  // authorization codes (?code=xxx) survive the relay.
  params.delete('state');
  params.set('nonce', nonce);
  var query = '?' + params.toString();
  // 'opener' delivery (worker-served SPA / thin-bridge / hosted-leader):
  // the popup at /auth/callback shares the worker origin with the SLICC tab
  // that opened it, so post the full callback URL (including the implicit-
  // flow hash that carries the access_token) to the opener instead of
  // self-looping a localhost redirect that doesn't resolve.
  function deliverToOpener() {
    var redirectUrl = location.origin + path + query + location.hash;
    // Same-origin broadcast FIRST: a provider serving COOP 'same-origin'
    // (GitHub does) severs window.opener for this popup, and a follower
    // running a leader-delegated login has no loopback result endpoint to
    // fall back on. BroadcastChannel is origin-scoped and unaffected by the
    // browsing-context-group split, so it reaches the waiting SLICC tab.
    //
    // The channel reaches EVERY same-origin listener, not just this flow's,
    // so carry the nonce: a receiver with a different pending login filters
    // this out instead of settling on someone else's callback.
    var broadcast = false;
    try {
      var channel = new BroadcastChannel('slicc-oauth-relay');
      channel.postMessage({ type: 'oauth-callback', redirectUrl: redirectUrl, nonce: nonce });
      channel.close();
      broadcast = true;
    } catch (e) {}
    if (!window.opener) {
      if (!broadcast) throw new Error('No opener window');
    } else {
      window.opener.postMessage(
        { type: 'oauth-callback', redirectUrl: redirectUrl },
        location.origin
      );
    }
    setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
  }
  var target = null;
  if (source === 'opener') {
    deliverToOpener();
  } else if (source === 'local') {
    var port = Number(state.port);
    if (!port || port < 1024 || port > 65535) throw new Error('Invalid port: ' + port);
    var localOrigin = 'http://localhost:' + port;
    // Self-origin guard: if the 'local' target points at the relay's own
    // origin (e.g. wrangler dev on :8787 with state.port=8787) we'd loop the
    // relay forever. Divert to the opener delivery branch instead — the
    // worker-served SPA can always consume the message.
    if (localOrigin === location.origin) {
      deliverToOpener();
    } else {
      target = localOrigin + path + query;
    }
  } else if (source === 'extension') {
    // Chrome extension IDs are 32 chars in [a-p]. Strict format check prevents
    // open-redirect via subdomain injection (e.g. "evil.com.").
    var extensionId = state.extensionId || '';
    if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Invalid extensionId');
    target = 'https://' + extensionId + '.chromiumapp.org' + path + query;
  } else if (source === 'remote') {
    // Remote origin (staging / preview / deployed dashboards).
    var origin = state.origin || '';
    // Origin must be a strict https origin (no path, no userinfo, no invalid port).
    if (!/^https:\\/\\/[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(origin)) {
      throw new Error('Invalid origin: ' + origin);
    }
    // Allowlist enforced server-side via the inlined ALLOWED_ORIGINS array.
    var allowed = ${JSON.stringify('PLACEHOLDER')};
    if (allowed.indexOf(origin) === -1) {
      throw new Error('Origin not in ALLOWED_CLOUD_DASHBOARD_ORIGINS: ' + origin);
    }
    target = origin + path + query;
  } else {
    throw new Error('Unknown source: ' + source);
  }
  if (target !== null) location.replace(target + location.hash);
} catch (e) {
  var msg = 'OAuth redirect failed: ' + e.message + '. Close this window and try again.';
  document.getElementById('msg').textContent = msg;
  if (window.opener) {
    try {
      window.opener.postMessage({ type: 'sliccy.cloud.imsError', error: e.message }, '*');
    } catch (postErr) {
      /* opener may be cross-origin and reject; the inline message is the fallback */
    }
  }
  setTimeout(function() { window.close(); }, 3000);
}
</script>
</body></html>`.replace(
    JSON.stringify('PLACEHOLDER'),
    JSON.stringify(
      allowedOrigins
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );

// Capture page for OAuth callbacks that must be handed to the opener without
// interpreting their parameters. This serves both the structured relay's final
// hop (where state was consumed) and the dedicated MCP callback (where opaque
// state must be preserved).
//
// Both capture paths run on the dashboard's OWN origin, so the legitimate
// opener is same-origin: scope the postMessage `targetOrigin` to
// `location.origin` (NOT '*') so the code can't be delivered to a cross-origin
// window that managed to become our opener. The receiver also re-checks
// `event.origin`, but the sender must scope delivery too.
const OAUTH_CAPTURE_HTML = `<!DOCTYPE html>
<html><head><title>Completing sign-in…</title></head>
<body><p>Completing sign-in… you can close this window.</p>
<script>
try {
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-callback', redirectUrl: location.href }, location.origin);
  }
} catch (e) { /* opener may be gone */ }
setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
</script></body></html>`;

/**
 * Parse the comma-separated `ALLOWED_CLOUD_DASHBOARD_ORIGINS` allowlist into a
 * trimmed, non-empty origin list. Shared by the capability-route CORS surface
 * so a browser overlay/leader on an allowlisted origin different from the
 * worker (the decoupled `SLICC_TRAY_WORKER_BASE_URL` config) can attach.
 *
 * Exported for tests.
 */
export function parseAllowedCapabilityOrigins(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * CORS headers for the browser-facing capability routes (`/tray`, `/join`,
 * `/controller`). The request `Origin` is echoed into
 * `Access-Control-Allow-Origin` only when it is in the
 * `ALLOWED_CLOUD_DASHBOARD_ORIGINS` allowlist — never a wildcard `*` for these
 * capability routes. Non-allowlisted origins get only a `Vary: Origin` header
 * (no `Access-Control-Allow-Origin`), so the browser blocks the response.
 *
 * Exported for tests.
 */
export function capabilityCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedCapabilityOrigins(env.ALLOWED_CLOUD_DASHBOARD_ORIGINS);
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type';
    // Without this a cross-origin follower can't read the RFC 8288 `Link`
    // header at all — including the `successor-version` link a superseded
    // tray answers with (#1957).
    headers['Access-Control-Expose-Headers'] = 'Link';
  }
  return headers;
}

const CAPABILITY_CORS_TOKEN_PATH = /^\/(join|controller)\/[^/]+$/;

/** True for the browser-facing capability routes that carry CORS. */
function isCapabilityCorsPath(url: URL): boolean {
  return url.pathname === '/tray' || CAPABILITY_CORS_TOKEN_PATH.test(url.pathname);
}

/**
 * Attach CORS headers to a capability-route response (skips WebSocket
 * upgrades). The worker is the single CORS authority for these routes, so any
 * pre-existing CORS headers (e.g. the legacy wildcard the tray DO sets on
 * `/join`) are stripped first — this guarantees a non-allowlisted origin is
 * never granted a wildcard `Access-Control-Allow-Origin`.
 */
function withCapabilityCors(response: Response, cors: Record<string, string>): Response {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.delete('access-control-allow-origin');
  out.headers.delete('access-control-allow-methods');
  out.headers.delete('access-control-allow-headers');
  for (const [key, value] of Object.entries(cors)) {
    out.headers.set(key, value);
  }
  return out;
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  // fetchImpl stays the 3rd positional arg (the established test-injection
  // convention across this file); ctx is last so existing `(request, env, fetch)`
  // call sites keep working. serveAssetWithArchiveFallback uses ctx.waitUntil.
  fetchImpl: typeof fetch = fetch,
  ctx: ExecutionContext = NOOP_CTX
): Promise<Response> {
  const url = new URL(request.url);

  // Preview subdomains (<token>.sliccy.now prod / <token>.sliccy.dev staging)
  // dispatch FIRST — they share the worker binding but never want any of the
  // /api, /handoff, /auth, or SPA routes below. The handler resolves the token
  // to a tray Durable Object and round-trips the request through the leader.
  if (previewTokenFromHost(url.host) !== null) {
    return handlePreviewRequest(request, env);
  }

  if (url.hostname === 'sliccy.ai') {
    const target = new URL(url.toString());
    target.hostname = SLICC_HOSTED_HOSTNAME;
    return Response.redirect(target.toString(), 301);
  }

  // CORS preflight for the browser-facing capability routes (/tray, /join,
  // /controller). The follower attach is a non-simple request
  // (content-type: application/json) so the browser sends an OPTIONS preflight.
  if (request.method === 'OPTIONS' && isCapabilityCorsPath(url)) {
    return new Response(null, { status: 204, headers: capabilityCorsHeaders(request, env) });
  }

  const cloudResponse = await tryHandleCloudRoutes(url, request, env);
  if (cloudResponse) return cloudResponse;

  if (url.pathname === '/tray' && request.method === 'POST') {
    return withCapabilityCors(await createTray(request, env), capabilityCorsHeaders(request, env));
  }

  if ((url.pathname === '/session' || url.pathname === '/trays') && request.method === 'POST') {
    return jsonResponse(
      {
        error: 'Tray creation moved to POST /tray',
        code: 'TRAY_CREATE_ENDPOINT_MOVED',
        canonical: 'POST /tray',
      },
      410
    );
  }

  const oauthResponse = await tryHandleOAuthRoutes(url, request, env, fetchImpl);
  if (oauthResponse) return oauthResponse;

  const infoResponse = await tryHandleInfoRoutes(url, request, env, fetchImpl);
  if (infoResponse) return infoResponse;

  const capResponse = await tryHandleCapabilityRoutes(url, request, env);
  if (capResponse) {
    // Echo CORS for the browser-facing /join and /controller capability API
    // responses so an overlay/leader on an allowlisted origin different from the
    // worker can attach. The SPA-serving (top-level navigation) and
    // WebSocket-upgrade branches are passed through untouched — they need no
    // CORS and the SPA branch owns its own Vary header.
    const isBrowserNav =
      !wantsJSON(request) &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.headers.get('Upgrade');
    if (CAPABILITY_CORS_TOKEN_PATH.test(url.pathname) && !isBrowserNav) {
      return withCapabilityCors(capResponse, capabilityCorsHeaders(request, env));
    }
    return capResponse;
  }

  // #1330 retention: serve content-hashed /assets/* from the R2 archive when the
  // current build no longer has them, before the SPA fallback turns them into HTML.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    matchHashedAssetPath(url.pathname)
  ) {
    return serveAssetWithArchiveFallback(request, env, ctx);
  }

  // SPA fallback for GET/HEAD browser navigation, unless ?json=true
  if (!wantsJSON(request) && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveSPA(request, env);
  }

  return jsonResponse(ROUTES_INDEX_BODY, 200);
}

const ROUTES_INDEX_BODY = {
  service: 'slicc-tray-hub',
  phase: 1,
  routes: [
    'POST /tray',
    'GET /download/slicc.dmg',
    'GET /install-cli',
    'GET /install-cli.ps1',
    'GET /download/slicc-cli/:target',
    'GET /handoff',
    'GET /.well-known/api-catalog',
    'GET /.well-known/apple-app-site-association',
    'GET /privacy',
    'GET /llms.txt',
    'GET /status',
    'GET /rel/:name',
    'GET|POST /join/:token',
    'GET|POST /controller/:token',
    'POST /webhook/:token/:webhookId',
    'POST /api/tray/:trayId/preview',
    'PUT /api/tray/:trayId/preview/:previewToken/file',
    'POST /api/tray/:trayId/preview/:previewToken/finalize',
    'POST /api/tray/:trayId/preview/stop',
    'GET /api/tray/:trayId/previews',
    'POST /api/tray/:trayId/biscotto',
    'POST /api/tray/:trayId/biscotto/stop',
    'GET /api/tray/:trayId/biscotti',
    'POST /api/tray/:trayId/supersede',
    'GET /auth/callback',
    'GET /auth/mcp-callback',
    'POST /oauth/token',
    'POST /oauth/revoke',
    'GET /api/runtime-config',
    'GET /api/flags',
    'ANY /api/fetch-proxy',
    'GET /api/cloud/config',
    'POST /api/cloud/start',
    'GET /api/cloud/list',
    'POST /api/cloud/pause',
    'POST /api/cloud/resume',
    'POST /api/cloud/kill',
    'GET /api/cloud/cone-config',
    'POST /api/cloud/sign-out',
    'GET /api/cloud/admin/stats',
    'GET /auth/cloud-callback',
    'GET /auth/cloud-callback.js',
    'GET /cloud',
    'GET /cloud/*',
  ],
};

async function tryHandleCloudRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv
): Promise<Response | null> {
  // Cloud cones routes (Plan D).
  if (url.pathname.startsWith('/api/cloud/')) {
    const op = url.pathname.replace('/api/cloud/', '');
    const cloudEnv = env as unknown as Parameters<typeof handleStart>[1];
    const adminEnv = env as unknown as Parameters<typeof handleAdminStats>[1];
    switch (op) {
      case 'config':
        return handleCloudConfig(request, env);
      case 'start':
        return handleStart(request, cloudEnv);
      case 'list':
        return handleList(request, cloudEnv);
      case 'pause':
        return handlePause(request, cloudEnv);
      case 'resume':
        return handleResume(request, cloudEnv);
      case 'kill':
        return handleKill(request, cloudEnv);
      case 'cone-config':
        return handleConeConfig(request, cloudEnv);
      case 'sign-out':
        return handleSignOut(request);
      case 'admin/stats':
        return handleAdminStats(request, adminEnv);
      default:
        return new Response(`unknown cloud op: ${op}`, { status: 404 });
    }
  }

  // IMS implicit-grant callback (Plan D).
  if (url.pathname === '/auth/cloud-callback') return handleCloudCallback();
  if (url.pathname === '/auth/cloud-callback.js') return handleCloudCallbackScript();

  // Cloud dashboard SPA (Plan D Phase D-6).
  if (
    url.pathname === '/cloud' ||
    (url.pathname.startsWith('/cloud/') && (request.method === 'GET' || request.method === 'HEAD'))
  ) {
    const path =
      url.pathname === '/cloud' ? '/packages/webapp/cloud/' : `/packages/webapp${url.pathname}`;
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));

    const finalRes =
      res.status >= 300 && res.status < 400 && res.headers.get('location')
        ? await env.ASSETS.fetch(
            new Request(new URL(res.headers.get('location')!, request.url), request)
          )
        : res;

    const headers = new Headers(finalRes.headers);
    headers.set(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        `connect-src ${buildLeaderConnectSrc(env)}`,
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    return new Response(finalRes.body, {
      status: finalRes.status,
      statusText: finalRes.statusText,
      headers,
    });
  }

  return null;
}

async function tryHandleOAuthRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch
): Promise<Response | null> {
  // MCP authorization servers return an opaque CSRF state. Keep this path
  // separate from the structured SLICC relay so the value survives unchanged.
  if (url.pathname === '/auth/mcp-callback') {
    return new Response(OAUTH_CAPTURE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // OAuth callback relay — serves a static HTML page that reads the OAuth state
  // parameter and redirects to the correct localhost port. Provider-agnostic.
  if (url.pathname === '/auth/callback') {
    const isCaptureHop =
      !url.searchParams.has('state') &&
      (url.searchParams.has('code') || url.searchParams.has('error'));
    const html = isCaptureHop
      ? OAUTH_CAPTURE_HTML
      : OAUTH_RELAY_HTML(env.ALLOWED_CLOUD_DASHBOARD_ORIGINS ?? '');
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Generic OAuth token exchange and revocation (authorization code grant)
  if (url.pathname === '/oauth/token' || url.pathname === '/oauth/revoke') {
    if (request.method === 'OPTIONS') {
      return handleOAuthPreflight(request);
    }
    if (request.method !== 'POST') {
      return handleOAuthMethodNotAllowed(request);
    }
    if (url.pathname === '/oauth/token') {
      return handleOAuthToken(request, env as unknown as OAuthHandlerEnv, fetchImpl);
    }
    return handleOAuthRevoke(request, env as unknown as OAuthHandlerEnv, fetchImpl);
  }

  return null;
}

/** The env view the OAuth exchange handlers declare (`OAuthCredentialEnv`). */
type OAuthHandlerEnv = Parameters<typeof handleOAuthToken>[1];

/** Dev-harness override vars that are deliberately absent from `WorkerEnv`. */
interface RuntimeConfigOverrides {
  TRAY_WORKER_BASE_URL_OVERRIDE?: unknown;
  /** Public OAuth client id; a var in wrangler.jsonc, typed loosely here. */
  GITHUB_CLIENT_ID?: unknown;
}

function handleRuntimeConfig(url: URL, request: Request, env: WorkerEnv): Response {
  const envRecord = env as WorkerEnv & RuntimeConfigOverrides;
  // Dev harness override: when the worker runs locally via `wrangler dev`
  // and the real relay is on a different origin (e.g. the staging worker),
  // `TRAY_WORKER_BASE_URL_OVERRIDE` lets the harness point
  // `trayWorkerBaseUrl` at the relay instead of the local origin. Has no
  // effect in production (the env var is not set).
  const overrideBaseUrl =
    typeof envRecord.TRAY_WORKER_BASE_URL_OVERRIDE === 'string' &&
    envRecord.TRAY_WORKER_BASE_URL_OVERRIDE
      ? envRecord.TRAY_WORKER_BASE_URL_OVERRIDE.replace(/\/+$/, '')
      : null;
  const workerBaseUrl = overrideBaseUrl || `${url.protocol}//${url.host}`;
  const origin = request.headers.get('Origin');
  const cors: Record<string, string> = origin
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
  return jsonResponse(
    {
      trayWorkerBaseUrl: workerBaseUrl,
      oauth: {
        github:
          typeof envRecord.GITHUB_CLIENT_ID === 'string' ? envRecord.GITHUB_CLIENT_ID : undefined,
      },
    },
    200,
    cors
  );
}

/** The slicc CLI installer surface: both installer scripts + the binary resolver. */
async function tryHandleInstallerRoutes(
  url: URL,
  request: Request,
  fetchImpl: typeof fetch
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return null;
  }
  if (url.pathname === '/install-cli') {
    return buildInstallCliScriptResponse(request);
  }
  if (url.pathname === '/install-cli.ps1') {
    return buildInstallCliPowershellResponse(request);
  }
  // Match ANY suffix so a typo'd target gets the route's 404 instead of the
  // SPA fallback's 200 HTML page (which `curl -f` would happily save as the
  // "binary"); handleCliDownload validates against the released target list.
  const cliDownloadMatch = url.pathname.match(/^\/download\/slicc-cli\/([^/]+)$/);
  if (cliDownloadMatch) {
    return handleCliDownload(cliDownloadMatch[1], fetchImpl);
  }
  return null;
}

// GET|HEAD pages served straight from a builder, with no env or fetch
// dependency. `/privacy` is linked from App Store Connect and must be
// answered by the worker, not the SPA fallback (which would serve the
// dashboard shell instead of a policy).
const STATIC_INFO_ROUTES: Record<string, (request: Request) => Response> = {
  '/.well-known/api-catalog': buildApiCatalogResponse,
  '/.well-known/apple-app-site-association': buildAppSiteAssociationResponse,
  '/llms.txt': buildLlmsTxtResponse,
  '/privacy': buildPrivacyResponse,
};

async function tryHandleInfoRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch
): Promise<Response | null> {
  if (url.pathname === '/api/runtime-config') {
    return handleRuntimeConfig(url, request, env);
  }

  if (url.pathname === '/api/flags') {
    return handleFlagsRequest(request, env.FEATURE_FLAGS);
  }

  if (url.pathname === '/api/fetch-proxy') {
    return jsonResponse({ error: 'Fetch proxy not available in worker mode' }, 404);
  }

  if (
    url.pathname === '/download/slicc.dmg' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    return handleDmgDownload(fetchImpl);
  }

  const installerResponse = await tryHandleInstallerRoutes(url, request, fetchImpl);
  if (installerResponse) {
    return installerResponse;
  }

  if (url.pathname === '/handoff' && request.method === 'GET') {
    return buildHandoffResponse(request);
  }

  const staticInfoRoute = STATIC_INFO_ROUTES[url.pathname];
  if (staticInfoRoute && (request.method === 'GET' || request.method === 'HEAD')) {
    return staticInfoRoute(request);
  }

  if (url.pathname === '/status' && (request.method === 'GET' || request.method === 'HEAD')) {
    // Also load-bearing for the E2E suite: `packages/webapp/tests/e2e/playwright.config.ts`
    // gates the wrangler `webServer` readiness on a 200 from this handler
    // (see the `url:` comment there). A future refactor must preserve both
    // the 200 status and the `no-store` header, and must keep this route
    // reachable by the worker's `fetch` (i.e. must not move it behind an
    // asset/SPA intercept — see `wrangler.jsonc` `run_worker_first: true`).
    return jsonResponse(
      {
        status: 'ok',
        service: 'slicc-tray-hub',
        timestamp: new Date().toISOString(),
        version: resolveWorkerVersion(env),
      },
      200,
      { 'Cache-Control': 'no-store' }
    );
  }

  const relMatch = url.pathname.match(/^\/rel\/([a-z0-9-]+)$/);
  if (relMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return buildRelResponse(relMatch[1]);
  }

  return null;
}

/**
 * Biscotto (guest seat) mint/revoke/list. Bearer = controllerToken throughout,
 * so only the leader can hand out or withdraw a seat — a seat is never an
 * issuing authority. Split out of `tryHandleCapabilityRoutes` to keep that
 * function under the cognitive-complexity ceiling.
 */
async function tryHandleBiscottoRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv
): Promise<Response | null> {
  // `/biscotto/stop` is matched before `/biscotto` so the bare-mint pattern
  // cannot shadow it.
  const stopMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/biscotto\/stop$/);
  if (stopMatch && request.method === 'POST') {
    return handleBiscottoStop(request, env.TRAY_HUB.get(env.TRAY_HUB.idFromName(stopMatch[1])));
  }
  const mintMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/biscotto$/);
  if (mintMatch && request.method === 'POST') {
    return handleBiscottoMint(request, env.TRAY_HUB.get(env.TRAY_HUB.idFromName(mintMatch[1])));
  }
  const listMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/biscotti$/);
  if (listMatch && request.method === 'GET') {
    return handleBiscottoList(request, env.TRAY_HUB.get(env.TRAY_HUB.idFromName(listMatch[1])));
  }
  return null;
}

async function tryHandleCapabilityRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv
): Promise<Response | null> {
  // Unified-preview mint/revoke/list HTTP routes.
  // Bearer = controllerToken; the worker forwards to the DO via its fetch() surface.
  const previewMintMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview$/);
  if (previewMintMatch && request.method === 'POST') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(previewMintMatch[1]));
    return handlePreviewMint(request, stub);
  }
  const previewUploadMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview\/([^/]+)\/file$/);
  if (previewUploadMatch && request.method === 'PUT') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(previewUploadMatch[1]));
    return handlePreviewUpload(request, stub, env.PREVIEW_STORAGE, previewUploadMatch[2]);
  }
  const previewFinalizeMatch = url.pathname.match(
    /^\/api\/tray\/([^/]+)\/preview\/([^/]+)\/finalize$/
  );
  if (previewFinalizeMatch && request.method === 'POST') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(previewFinalizeMatch[1]));
    return handlePreviewFinalize(request, stub, previewFinalizeMatch[2]);
  }
  const previewStopMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview\/stop$/);
  if (previewStopMatch && request.method === 'POST') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(previewStopMatch[1]));
    return handlePreviewStop(request, stub);
  }
  const previewListMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/previews$/);
  if (previewListMatch && request.method === 'GET') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(previewListMatch[1]));
    return handlePreviewList(request, stub);
  }
  const biscotto = await tryHandleBiscottoRoutes(url, request, env);
  if (biscotto) return biscotto;
  const supersedeMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/supersede$/);
  if (supersedeMatch && request.method === 'POST') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(supersedeMatch[1]));
    return handleTraySupersede(request, stub);
  }

  const tokenMatch = url.pathname.match(/^\/(join|controller|webhook)\/([^/]+?)(?:\/([^/]+))?$/);
  if (!tokenMatch) return null;

  const route = tokenMatch[1];
  const token = tokenMatch[2];

  if (
    !wantsJSON(request) &&
    !request.headers.get('Upgrade') &&
    (route === 'join' || route === 'controller') &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    return serveSPA(request, env);
  }

  const parsed = parseCapabilityToken(token);
  if (!parsed) {
    return jsonResponse({ error: 'Malformed capability token', code: 'MALFORMED_CAPABILITY' }, 400);
  }
  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));
  const webhookId = route === 'webhook' ? tokenMatch[3] : undefined;
  if (webhookId) {
    const doUrl = new URL(request.url);
    doUrl.pathname = `/webhook/${token}/${webhookId}`;
    return stub.fetch(new Request(doUrl, request));
  }
  return stub.fetch(request);
}

const RELEASES_FALLBACK = 'https://github.com/ai-ecoverse/slicc/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/ai-ecoverse/slicc/releases?per_page=30';
const RELEASES_PER_PAGE = 30;
// Cap the release-list pagination so a long streak of binary-less releases can't
// trigger unbounded GitHub API calls / rate-limit exhaustion (5 × 30 = up to 150
// releases scanned before we give up and fall back to the releases page).
const MAX_RELEASE_PAGES = 5;
// Mirrors the tolerant macOS-asset filtering in the Swift updater
// (`hasViableMacOSAsset`); the website download wants the `.dmg` specifically.
const DMG_ASSET_PATTERN = /^sliccstart-v.+\.dmg$/i;

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string;
  assets?: GithubReleaseAsset[];
}

interface KnownGoodPointer {
  version?: unknown;
}

// PURE: build the guaranteed-valid known-good macOS DMG download URL from the
// bundled pointer. Returns null when the pointer is missing/malformed (absent,
// non-string, or blank version) so callers can fall back to bounded search.
export function buildKnownGoodDmgUrl(pointer: KnownGoodPointer | null | undefined): string | null {
  const version = pointer?.version;
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }
  return `https://github.com/ai-ecoverse/slicc/releases/download/v${version}/sliccstart-v${version}.dmg`;
}

// PURE: compare two version strings (leading `v` tolerated). Returns a negative
// number when a < b, 0 when equal, and a positive number when a > b. Non-numeric
// or missing segments are treated as 0.
export function compareReleaseVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isNaN(n) ? 0 : n;
      });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

// Scan one page of releases newest→oldest for a viable macOS DMG. Returns the
// asset download URL for the first non-draft/non-prerelease release that ships a
// `sliccstart-v<version>.dmg`. When a valid pointer version is supplied, a
// binary-less release at or below it is the pagination floor: everything older is
// stale, so we return `fallback` (the guaranteed-valid known-good DMG). Returns
// null when nothing matched on this page and pagination should continue.
function scanReleasesForDmg(
  releases: GithubRelease[],
  pointerVersion: string | null,
  fallback: string
): string | null {
  for (const release of releases) {
    if (release.draft || release.prerelease) {
      continue;
    }
    const asset = release.assets?.find(
      (candidate) => typeof candidate.name === 'string' && DMG_ASSET_PATTERN.test(candidate.name)
    );
    if (asset?.browser_download_url) {
      return asset.browser_download_url;
    }
    if (
      pointerVersion &&
      typeof release.tag_name === 'string' &&
      compareReleaseVersions(release.tag_name, pointerVersion) <= 0
    ) {
      return fallback;
    }
  }
  return null;
}

// Redirect to the newest published release that actually ships a
// `sliccstart-v<version>.dmg` asset, paginating newest→oldest. With a valid
// bundled known-good pointer the scan stops as soon as it reaches a binary-less
// release at or below the known-good version (the pagination floor) and 302s to
// the guaranteed-valid known-good DMG — never a 404. `MAX_RELEASE_PAGES` remains
// an absolute backstop so unparseable tags can't drive unbounded GitHub calls.
// If the pointer is missing/malformed we retain the old bounded search and fall
// back to `releases/latest` on exhaustion (existing behavior). On any failure
// (network throw, non-2xx, unparseable/empty JSON) we 302 to the same fallback.
export async function handleDmgDownload(
  fetchImpl: typeof fetch,
  pointer: KnownGoodPointer = knownGoodMacos
): Promise<Response> {
  const knownGoodUrl = buildKnownGoodDmgUrl(pointer);
  const pointerVersion =
    knownGoodUrl && typeof pointer.version === 'string' ? pointer.version : null;
  const fallback = knownGoodUrl ?? RELEASES_FALLBACK;
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const res = await fetchImpl(`${RELEASES_API}&page=${page}`, {
        headers: { 'User-Agent': 'slicc-tray-hub' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!res.ok) {
        return Response.redirect(fallback, 302);
      }
      let releases: unknown;
      try {
        releases = await res.json();
      } catch {
        return Response.redirect(fallback, 302);
      }
      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }
      const hit = scanReleasesForDmg(releases as GithubRelease[], pointerVersion, fallback);
      if (hit) {
        return Response.redirect(hit, 302);
      }
      // Fewer than a full page means we've reached the last page — stop early.
      if (releases.length < RELEASES_PER_PAGE) {
        break;
      }
    }
    return Response.redirect(fallback, 302);
  } catch {
    return Response.redirect(fallback, 302);
  }
}

async function createTray(request: Request, env: WorkerEnv): Promise<Response> {
  let kind: 'desktop' | 'hosted' = 'desktop';
  // Tolerate three back-compat shapes: no content-length header at all
  // (legacy clients), content-length: 0, and an empty-string body. Only
  // attempt JSON parse when there's actually a body to parse.
  const rawBody = await request.text();
  if (rawBody.trim() !== '') {
    try {
      const body = JSON.parse(rawBody) as { kind?: unknown };
      if (body.kind === 'hosted' || body.kind === 'desktop') {
        kind = body.kind;
      } else if (body.kind !== undefined) {
        return jsonResponse(
          {
            error: 'kind must be "desktop" or "hosted"',
            code: 'INVALID_KIND',
          },
          400
        );
      }
    } catch {
      return jsonResponse(
        {
          error: 'request body must be valid JSON',
          code: 'INVALID_BODY',
        },
        400
      );
    }
  }

  const url = new URL(request.url);
  const trayId = crypto.randomUUID();
  const payload: CreateTrayRequest = {
    trayId,
    createdAt: new Date().toISOString(),
    joinToken: createCapabilityToken(trayId),
    controllerToken: createCapabilityToken(trayId),
    webhookToken: createCapabilityToken(trayId),
    kind,
  };

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(trayId));
  const initResponse = await stub.fetch(
    new Request(new URL('/internal/create', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );

  if (initResponse.status >= 400) {
    return initResponse;
  }

  return jsonResponse(
    {
      trayId,
      createdAt: payload.createdAt,
      capabilities: {
        join: {
          token: payload.joinToken,
          url: `${url.origin}/join/${payload.joinToken}`,
        },
        controller: {
          token: payload.controllerToken,
          url: `${url.origin}/controller/${payload.controllerToken}`,
        },
        webhook: {
          token: payload.webhookToken,
          url: `${url.origin}/webhook/${payload.webhookToken}`,
        },
      },
    },
    201
  );
}

const worker = {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext = NOOP_CTX
  ): Promise<Response> {
    const url = new URL(request.url);

    // Root redirects to www.sliccy.com — indexable, return as-is
    if (url.pathname === '/' && url.search === '') {
      if (url.hostname === 'sliccy.ai') {
        return Response.redirect('https://www.sliccy.com/', 301);
      }
      if (url.hostname === SLICC_HOSTED_HOSTNAME) {
        return Response.redirect('https://www.sliccy.com/', 301);
      }
    }

    const response = await handleWorkerRequest(request, env, undefined, ctx);
    if (response.status === 101) {
      return response;
    }
    // Apply SLICC's standard `Link` set, then attach the noindex tag.
    const withLinks = applySliccLinks(response, request);
    const mutable = new Response(withLinks.body, withLinks);
    mutable.headers.set('X-Robots-Tag', 'noindex');
    return mutable;
  },
};

export default worker;
export { CloudSessionsDurableObject, SessionTrayDurableObject };
