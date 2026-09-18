import {
  ELECTRON_OVERLAY_APP_PATH,
  SLICC_HOSTED_ORIGIN,
  scanGithubReleases,
} from '@slicc/shared-ts';
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
  extractBearer,
  handlePreviewFinalize,
  handlePreviewList,
  handlePreviewMint,
  handlePreviewStop,
  handlePreviewUpload,
  handleTraySupersede,
} from './preview-routes.js';
import { handlePreviewTransfer } from './preview-transfer-route.js';
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
import { readBoundedWebhookBody, WebhookBodyError, withWebhookTimeout } from './webhook-body.js';
import { WebhookHomeDurableObject } from './webhook-home.js';
import { handleWebhookRevoke } from './webhook-revoke-route.js';

const SLICC_HOSTED_HOSTNAME = new URL(SLICC_HOSTED_ORIGIN).hostname;

export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  CLOUD_SESSIONS: DurableObjectNamespaceLike;

  WEBHOOK_HOMES: DurableObjectNamespaceLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ASSET_ARCHIVE: R2Bucket;
  PREVIEW_STORAGE: R2Bucket;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;

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

  ALLOWED_CHERRY_HOST_ORIGINS?: string;

  CF_VERSION_METADATA?: { id?: string };
}

const UNKNOWN_WORKER_VERSION = 'unknown';

export function resolveWorkerVersion(env: Pick<WorkerEnv, 'CF_VERSION_METADATA'>): string {
  const id = env.CF_VERSION_METADATA?.id;
  return typeof id === 'string' && id.length > 0 ? id : UNKNOWN_WORKER_VERSION;
}

export function resolveCherryFrameAncestors(allowed: string | undefined): string {
  const trimmed = (allowed ?? '').trim();
  if (trimmed.length === 0) return "'none'";
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.includes('*')) {
    const ext = tokens.filter((t) => t.startsWith('chrome-extension://'));
    return ext.length ? ['*', ...ext].join(' ') : '*';
  }
  return tokens.join(' ');
}

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

const NOOP_CTX: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const ASSET_IMMUTABLE = 'public, max-age=31536000, immutable';

async function serveAssetWithArchiveFallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const isHead = request.method === 'HEAD';

  const hasCond =
    request.headers.has('range') ||
    request.headers.has('if-none-match') ||
    request.headers.has('if-modified-since') ||
    request.headers.has('if-match') ||
    request.headers.has('if-unmodified-since');
  const probe = hasCond
    ? await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }))
    : await env.ASSETS.fetch(request);
  const probeCT = probe.headers.get('content-type') ?? '';
  const isMiss = (probe.status === 200 && probeCT.includes('text/html')) || probe.status === 404;

  if (!isMiss) {
    return hasCond ? env.ASSETS.fetch(request) : probe;
  }

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  if (!isHead) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {}
  }

  let obj: R2ObjectBody | null = null;
  try {
    obj = await env.ASSET_ARCHIVE.get(url.pathname.slice(1));
  } catch {
    obj = null;
  }
  if (!obj) {
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
  const out = new Response(res.body, res);

  if (url.searchParams.get('cherry') === '1') {
    const ancestors = resolveCherryFrameAncestors(env.ALLOWED_CHERRY_HOST_ORIGINS);
    out.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);

    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Vary', 'Sec-Fetch-Dest');
  } else if (
    url.pathname === ELECTRON_OVERLAY_APP_PATH ||
    url.pathname === `${ELECTRON_OVERLAY_APP_PATH}/`
  ) {
    out.headers.delete('Content-Security-Policy');

    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Vary', 'Sec-Fetch-Dest');
  } else {
    out.headers.set('Content-Security-Policy', "frame-ancestors 'none'");

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

export function parseAllowedCapabilityOrigins(csv: string | undefined): string[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function capabilityCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedCapabilityOrigins(env.ALLOWED_CLOUD_DASHBOARD_ORIGINS);
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type';

    headers['Access-Control-Expose-Headers'] = 'Link';
  }
  return headers;
}

const CAPABILITY_CORS_TOKEN_PATH = /^\/(join|controller)\/[^/]+$/;

function isCapabilityCorsPath(url: URL): boolean {
  return url.pathname === '/tray' || CAPABILITY_CORS_TOKEN_PATH.test(url.pathname);
}

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

  fetchImpl: typeof fetch = fetch,
  ctx: ExecutionContext = NOOP_CTX
): Promise<Response> {
  const url = new URL(request.url);

  if (previewTokenFromHost(url.host) !== null) {
    return handlePreviewRequest(request, env);
  }

  if (url.hostname === 'sliccy.ai') {
    const target = new URL(url.toString());
    target.hostname = SLICC_HOSTED_HOSTNAME;
    return Response.redirect(target.toString(), 301);
  }

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
    const isBrowserNav =
      !wantsJSON(request) &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      !request.headers.get('Upgrade');
    if (CAPABILITY_CORS_TOKEN_PATH.test(url.pathname) && !isBrowserNav) {
      return withCapabilityCors(capResponse, capabilityCorsHeaders(request, env));
    }
    return capResponse;
  }

  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    matchHashedAssetPath(url.pathname)
  ) {
    return serveAssetWithArchiveFallback(request, env, ctx);
  }

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
    'POST /wh/:token/:webhookId',
    'POST /api/tray/:trayId/preview',
    'PUT /api/tray/:trayId/preview/:previewToken/file',
    'POST /api/tray/:trayId/preview/:previewToken/finalize',
    'POST /api/tray/:trayId/preview/stop',
    'GET /api/tray/:trayId/previews',
    'POST /api/tray/:trayId/preview-transfer',
    'POST /api/tray/:trayId/biscotto',
    'POST /api/tray/:trayId/biscotto/stop',
    'GET /api/tray/:trayId/biscotti',
    'POST /api/tray/:trayId/supersede',
    'POST /api/tray/:trayId/webhook/rotate',
    'POST /webhooks/:coneId/:webhookId/revoke',
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

  if (url.pathname === '/auth/cloud-callback') return handleCloudCallback();
  if (url.pathname === '/auth/cloud-callback.js') return handleCloudCallbackScript();

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
  if (url.pathname === '/auth/mcp-callback') {
    return new Response(OAUTH_CAPTURE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

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

type OAuthHandlerEnv = Parameters<typeof handleOAuthToken>[1];

interface RuntimeConfigOverrides {
  TRAY_WORKER_BASE_URL_OVERRIDE?: unknown;

  GITHUB_CLIENT_ID?: unknown;
}

function handleRuntimeConfig(url: URL, request: Request, env: WorkerEnv): Response {
  const envRecord = env as WorkerEnv & RuntimeConfigOverrides;

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

  const cliDownloadMatch = url.pathname.match(/^\/download\/slicc-cli\/([^/]+)$/);
  if (cliDownloadMatch) {
    return handleCliDownload(cliDownloadMatch[1], fetchImpl);
  }
  return null;
}

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

async function tryHandleBiscottoRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv
): Promise<Response | null> {
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
  const transferMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview-transfer$/);
  if (transferMatch && request.method === 'POST') {
    return handlePreviewTransfer(request, transferMatch[1], () =>
      env.TRAY_HUB.get(env.TRAY_HUB.idFromName(transferMatch[1]))
    );
  }
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
  return tryHandleSessionCapabilityRoutes(url, request, env);
}

async function tryHandleSessionCapabilityRoutes(
  url: URL,
  request: Request,
  env: WorkerEnv
): Promise<Response | null> {
  const supersedeMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/supersede$/);
  if (supersedeMatch && request.method === 'POST') {
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(supersedeMatch[1]));
    return handleTraySupersede(request, stub);
  }

  const rotateMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/webhook\/rotate$/);
  if (rotateMatch && request.method === 'POST') {
    return handleWebhookRotate(request, env, url, rotateMatch[1]!);
  }

  const revokeMatch = url.pathname.match(/^\/webhooks\/([^/]+)\/([^/]+)\/revoke$/);
  if (revokeMatch) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    return handleWebhookRevoke(request, revokeMatch[1]!, revokeMatch[2]!, (coneId) =>
      env.WEBHOOK_HOMES.get(env.WEBHOOK_HOMES.idFromName(coneId))
    );
  }

  const coneWebhookMatch = url.pathname.match(/^\/wh\/([^/]+?)(?:\/([^/]+))?$/);
  if (coneWebhookMatch) {
    return handleConeWebhookRoute(request, env, coneWebhookMatch[1]!, coneWebhookMatch[2]);
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

const DMG_ASSET_PATTERN = /^sliccstart-v.+\.dmg$/i;
const GITHUB_RELEASES_CF_CACHE = { cacheTtl: 300, cacheEverything: true };

interface KnownGoodPointer {
  version?: unknown;
}

export function buildKnownGoodDmgUrl(pointer: KnownGoodPointer | null | undefined): string | null {
  const version = pointer?.version;
  if (typeof version !== 'string' || version.trim() === '') {
    return null;
  }
  return `https://github.com/ai-ecoverse/slicc/releases/download/v${version}/sliccstart-v${version}.dmg`;
}

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

export async function handleDmgDownload(
  fetchImpl: typeof fetch,
  pointer: KnownGoodPointer = knownGoodMacos
): Promise<Response> {
  const knownGoodUrl = buildKnownGoodDmgUrl(pointer);
  const pointerVersion =
    knownGoodUrl && typeof pointer.version === 'string' ? pointer.version : null;
  const fallback = knownGoodUrl ?? RELEASES_FALLBACK;
  try {
    const hit = await scanGithubReleases(fetchImpl, {
      userAgent: 'slicc-tray-hub',
      requestInit: { cf: GITHUB_RELEASES_CF_CACHE },
      assetPredicate: (asset, githubRelease) =>
        !githubRelease.draft &&
        !githubRelease.prerelease &&
        typeof asset.name === 'string' &&
        DMG_ASSET_PATTERN.test(asset.name) &&
        Boolean(asset.browser_download_url),
      shouldStop: (githubRelease) => {
        if (!pointerVersion || githubRelease.draft || githubRelease.prerelease) {
          return false;
        }
        return (
          typeof githubRelease.tag_name === 'string' &&
          compareReleaseVersions(githubRelease.tag_name, pointerVersion) <= 0
        );
      },
    });
    if (hit?.asset.browser_download_url) {
      return Response.redirect(hit.asset.browser_download_url, 302);
    }
    return Response.redirect(fallback, 302);
  } catch {
    return Response.redirect(fallback, 302);
  }
}

async function handleConeWebhookRoute(
  request: Request,
  env: WorkerEnv,
  token: string,
  webhookId: string | undefined
): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*' };
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' }, 405, {
      ...cors,
      allow: 'POST, OPTIONS',
    });
  }
  const parsed = parseCapabilityToken(token);
  if (!parsed) {
    return jsonResponse(
      { error: 'Malformed webhook capability', code: 'MALFORMED_CAPABILITY' },
      400,
      cors
    );
  }
  if (!webhookId) {
    return jsonResponse(
      {
        error: 'Webhook ID is required. Use POST /wh/{coneId}.{secret}/{webhookId}',
        code: 'WEBHOOK_ID_REQUIRED',
      },
      400,
      cors
    );
  }
  const home = env.WEBHOOK_HOMES.get(env.WEBHOOK_HOMES.idFromName(parsed.trayId));

  const forwardUrl = new URL(request.url);
  forwardUrl.pathname = '/internal/home/deliver';
  const headers = new Headers(request.headers);
  headers.set('x-slicc-cone-secret', parsed.secret);
  headers.set('x-slicc-webhook-id', webhookId);
  let forwardBody: Uint8Array;
  try {
    forwardBody = await readBoundedWebhookBody(request);
  } catch (error) {
    if (!(error instanceof WebhookBodyError)) throw error;
    return jsonResponse(
      { error: error.message, code: 'WEBHOOK_BODY_REJECTED' },
      error.status,
      cors
    );
  }
  return home.fetch(new Request(forwardUrl, { method: 'POST', headers, body: forwardBody }));
}

async function handleWebhookRotate(
  request: Request,
  env: WorkerEnv,
  url: URL,
  trayId: string
): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: {
    oldConeId?: string;
    oldSecret?: string;
    oldRebindSecret?: string;
    secret?: string;
    rebindSecret?: string;
  };
  try {
    body = JSON.parse(new TextDecoder().decode(await readBoundedWebhookBody(request)));
  } catch (error) {
    if (error instanceof WebhookBodyError) {
      return jsonResponse({ error: error.message, code: 'WEBHOOK_BODY_REJECTED' }, error.status);
    }
    return jsonResponse({ error: 'invalid body', code: 'INVALID_BODY' }, 400);
  }
  if (
    !body ||
    typeof body.oldConeId !== 'string' ||
    !body.oldConeId ||
    typeof body.oldSecret !== 'string' ||
    !body.oldSecret ||
    typeof body.oldRebindSecret !== 'string' ||
    !body.oldRebindSecret ||
    typeof body.secret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(body.secret) ||
    typeof body.rebindSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(body.rebindSecret) ||
    body.secret === body.oldSecret ||
    body.rebindSecret === body.oldRebindSecret ||
    body.secret === body.rebindSecret
  ) {
    return jsonResponse(
      {
        error: 'Old identity and distinct fresh replacement secrets are required',
        code: 'INVALID_BODY',
      },
      400
    );
  }

  const coneId = body.oldConeId;
  const rebindSecret = body.rebindSecret;
  const coneSecret = body.secret;
  try {
    const oldHome = env.WEBHOOK_HOMES.get(env.WEBHOOK_HOMES.idFromName(body.oldConeId));
    const rotated = await oldHome.fetch(
      new Request(new URL('/internal/home/rotate', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          oldSecret: body.oldSecret,
          secret: coneSecret,
          oldRebindSecret: body.oldRebindSecret,
          rebindSecret,
          trayId,
          controllerToken,
        }),
      })
    );
    if (!rotated.ok) {
      return jsonResponse(
        { error: 'Webhook rotation refused', code: 'ROTATE_FAILED' },
        rotated.status === 403 ? 403 : 502
      );
    }
  } catch {
    return jsonResponse(
      { error: 'Webhook rotation failed; retry safely', code: 'ROTATE_FAILED' },
      502
    );
  }

  return jsonResponse(
    {
      coneId,
      webhook: {
        token: `${coneId}.${coneSecret}`,
        url: `${url.origin}/wh/${coneId}.${coneSecret}`,
        rebindToken: `${coneId}.${rebindSecret}`,
      },
    },
    200,
    { 'cache-control': 'no-store' }
  );
}

async function createTray(request: Request, env: WorkerEnv): Promise<Response> {
  let kind: 'desktop' | 'hosted' = 'desktop';

  let rawBody: string;
  try {
    rawBody = new TextDecoder().decode(await readBoundedWebhookBody(request));
  } catch (error) {
    if (!(error instanceof WebhookBodyError)) throw error;
    return jsonResponse({ error: error.message, code: 'INVALID_BODY' }, error.status);
  }
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

  const coneIdentity = parseConeIdentity(rawBody);
  if (coneIdentity === 'invalid') {
    return jsonResponse(
      { error: 'Invalid cone identity or createAttemptId', code: 'INVALID_BODY' },
      400
    );
  }

  const url = new URL(request.url);
  const trayId = coneIdentity ? await trayIdForCreateAttempt(coneIdentity) : crypto.randomUUID();
  let payload: CreateTrayRequest = {
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

  payload = (await initResponse.json()) as CreateTrayRequest;

  const bind = coneIdentity
    ? await bindWebhookHome(env, url, {
        coneId: coneIdentity.coneId,
        secret: coneIdentity.coneSecret,
        rebindSecret: coneIdentity.rebindSecret,
        trayId,
        controllerToken: payload.controllerToken,
      })
    : { ok: true };
  if (!bind.ok) {
    return jsonResponse(
      {
        error: 'Webhook home bind failed; retry with the same cone identity and createAttemptId',
        code: 'WEBHOOK_HOME_BIND_FAILED',
      },
      503,
      { 'retry-after': '30' }
    );
  }

  return jsonResponse(
    {
      trayId,
      ...(coneIdentity ? { coneId: coneIdentity.coneId } : {}),
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
        webhook: coneIdentity
          ? {
              token: `${coneIdentity.coneId}.${coneIdentity.coneSecret}`,
              url: `${url.origin}/wh/${coneIdentity.coneId}.${coneIdentity.coneSecret}`,
              rebindToken: `${coneIdentity.coneId}.${coneIdentity.rebindSecret}`,
            }
          : {
              token: payload.webhookToken,
              url: `${url.origin}/webhook/${payload.webhookToken}`,
            },
      },
    },
    201
  );
}

interface ConeIdentity {
  coneId: string;
  coneSecret: string;
  rebindSecret: string;
  createAttemptId: string;
}

async function trayIdForCreateAttempt(identity: ConeIdentity): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'tray-create-v1',
        identity.coneId,
        identity.rebindSecret,
        identity.createAttemptId,
      ])
    )
  );

  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function parseConeIdentity(rawBody: string): ConeIdentity | undefined | 'invalid' {
  if (rawBody.trim() === '') return undefined;
  let body: {
    coneId?: unknown;
    coneSecret?: unknown;
    rebindSecret?: unknown;
    createAttemptId?: unknown;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return 'invalid';
  }
  const present = [body.coneId, body.coneSecret, body.rebindSecret].filter((v) => v !== undefined);
  if (present.length === 0) return body.createAttemptId === undefined ? undefined : 'invalid';
  if (present.length !== 3) return 'invalid';
  const { coneId, coneSecret, rebindSecret, createAttemptId } = body;

  const ok = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
  if (
    !ok(coneId) ||
    !ok(coneSecret) ||
    !ok(rebindSecret) ||
    !ok(createAttemptId) ||
    createAttemptId.length < 32
  ) {
    return 'invalid';
  }
  return { coneId, coneSecret, rebindSecret, createAttemptId };
}

async function bindWebhookHome(
  env: WorkerEnv,
  url: URL,
  body: {
    coneId: string;
    secret: string;
    rebindSecret: string;
    trayId: string;
    controllerToken: string;
  }
): Promise<{ ok: boolean }> {
  try {
    const home = env.WEBHOOK_HOMES.get(env.WEBHOOK_HOMES.idFromName(body.coneId));
    const res = await withWebhookTimeout(
      home.fetch(
        new Request(new URL('/internal/home/bind', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      )
    );
    return { ok: res.status === 200 };
  } catch {
    return { ok: false };
  }
}

const worker = {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext = NOOP_CTX
  ): Promise<Response> {
    const url = new URL(request.url);

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

    const withLinks = applySliccLinks(response, request);
    const mutable = new Response(withLinks.body, withLinks);
    mutable.headers.set('X-Robots-Tag', 'noindex');
    return mutable;
  },
};

export default worker;
export { CloudSessionsDurableObject, SessionTrayDurableObject, WebhookHomeDurableObject };
