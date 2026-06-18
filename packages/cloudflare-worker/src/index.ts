import { buildApiCatalogResponse } from './api-catalog.js';
import { handleCloudCallback, handleCloudCallbackScript } from './auth/cloud-callback.js';
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
import { buildHandoffResponse } from './handoff-page.js';
import { applySliccLinks } from './links.js';
import { buildLlmsTxtResponse } from './llms-txt.js';
import {
  handleOAuthMethodNotAllowed,
  handleOAuthPreflight,
  handleOAuthRevoke,
  handleOAuthToken,
} from './oauth-exchange.js';
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

export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  CLOUD_SESSIONS: DurableObjectNamespaceLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
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
  /**
   * Space-separated origins permitted to frame the `?cherry=1` SPA. Empty/unset = deny.
   * A bare `*` token (alone or among origins) opens framing to arbitrary
   * third-party pages and emits `frame-ancestors *` (the CSP wildcard).
   */
  ALLOWED_CHERRY_HOST_ORIGINS?: string;
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
  if (tokens.includes('*')) return '*';
  return tokens.join(' ');
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
  } else {
    out.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
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
  var target;
  if (source === 'local') {
    var port = Number(state.port);
    if (!port || port < 1024 || port > 65535) throw new Error('Invalid port: ' + port);
    target = 'http://localhost:' + port + path + query;
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
  location.replace(target + location.hash);
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

// Capture page for the OAuth relay's final hop. After the relay bounces a
// provider response back to the dashboard's own origin (code present, state
// consumed), this page hands the full URL (which carries the OAuth `code`) to
// the opener via postMessage — the signal the webapp's `launchOAuthCli` waits
// for — then closes. Used by the webapp-served-by-worker (connect/cloud)
// context, where there's no node-server callback page.
//
// The relay only ever bounces back to the dashboard's OWN origin, so the
// legitimate opener is same-origin: scope the postMessage `targetOrigin` to
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

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === 'sliccy.ai') {
    const target = new URL(url.toString());
    target.hostname = 'www.sliccy.ai';
    return Response.redirect(target.toString(), 301);
  }

  // Cloud cones routes (Plan D).
  if (url.pathname.startsWith('/api/cloud/')) {
    const op = url.pathname.replace('/api/cloud/', '');
    // Handlers expect CloudEnv/AdminEnv types, which are structurally compatible
    // with WorkerEnv but have different optionality. Cast at dispatch boundary.
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
    // Use the canonical directory URL — fetching `index.html` triggers CF
    // Static Assets' html_handling auto-canonicalize which 307s to the dir,
    // and the worker only intercepts `/cloud*`, so the followed redirect
    // hits Static Assets directly without our CSP wrapper. Asking for `/`
    // returns the same index.html content without the redirect dance.
    const path =
      url.pathname === '/cloud' ? '/packages/webapp/cloud/' : `/packages/webapp${url.pathname}`;
    const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));

    // If ASSETS still returned a redirect (e.g., for some edge path),
    // follow it internally and proxy the eventual response — this preserves
    // our CSP wrapping across any auto-canonicalize hop.
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
        "connect-src 'self' https://ims-na1.adobelogin.com",
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

  if (url.pathname === '/tray' && request.method === 'POST') {
    return createTray(request, env);
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

  // OAuth callback relay — serves a static HTML page that reads the OAuth state
  // parameter and redirects to the correct localhost port. Provider-agnostic.
  if (url.pathname === '/auth/callback') {
    // Capture hop: the relay has already bounced the provider response back to
    // this origin (provider params present, `state` consumed). Hand the URL to
    // the opener via postMessage instead of re-running the relay — this is the
    // webapp-served-by-worker (connect/cloud) completion path.
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
      return handleOAuthToken(request, env as unknown as Record<string, unknown>, fetchImpl);
    }
    return handleOAuthRevoke(request, env as unknown as Record<string, unknown>, fetchImpl);
  }

  // Serve runtime config for the webapp (when served from the worker).
  // CORS enabled so dev-mode apps on localhost can fetch env-specific config.
  if (url.pathname === '/api/runtime-config') {
    const workerBaseUrl = `${url.protocol}//${url.host}`;
    const envRecord = env as unknown as Record<string, unknown>;
    const origin = request.headers.get('Origin');
    const cors: Record<string, string> = origin
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};
    return jsonResponse(
      {
        trayWorkerBaseUrl: workerBaseUrl,
        // Expose public OAuth client IDs so the webapp can build authorize URLs
        // for the correct environment (staging vs production).
        oauth: {
          github:
            typeof envRecord.GITHUB_CLIENT_ID === 'string' ? envRecord.GITHUB_CLIENT_ID : undefined,
        },
      },
      200,
      cors
    );
  }

  // Fetch proxy not available in worker mode (webapp uses direct fetch instead)
  if (url.pathname === '/api/fetch-proxy') {
    return jsonResponse({ error: 'Fetch proxy not available in worker mode' }, 404);
  }

  if (
    url.pathname === '/download/slicc.dmg' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    return handleDmgDownload();
  }

  if (url.pathname === '/handoff' && request.method === 'GET') {
    return buildHandoffResponse(request);
  }

  if (
    url.pathname === '/.well-known/api-catalog' &&
    (request.method === 'GET' || request.method === 'HEAD')
  ) {
    return buildApiCatalogResponse(request);
  }

  if (url.pathname === '/llms.txt' && (request.method === 'GET' || request.method === 'HEAD')) {
    return buildLlmsTxtResponse(request);
  }

  // Public health endpoint. Advertised via the `status` rel (RFC 8631) in the
  // standard Link header set, so any consumer that walks the rels can probe
  // liveness without hard-coding a path.
  if (url.pathname === '/status' && (request.method === 'GET' || request.method === 'HEAD')) {
    return jsonResponse(
      {
        status: 'ok',
        service: 'slicc-tray-hub',
        timestamp: new Date().toISOString(),
      },
      200,
      { 'Cache-Control': 'no-store' }
    );
  }

  // Documentation pages for the SLICC custom rel URIs (per RFC 8288 §2.1.2,
  // extension rels SHOULD be dereferenceable). Match `/rel/<name>` only —
  // not `/rel/<name>/sub` — so we don't intercept future nested routes.
  const relMatch = url.pathname.match(/^\/rel\/([a-z0-9-]+)$/);
  if (relMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    return buildRelResponse(relMatch[1]);
  }

  const tokenMatch = url.pathname.match(/^\/(join|controller|webhook)\/([^/]+?)(?:\/([^/]+))?$/);
  if (tokenMatch) {
    const route = tokenMatch[1];
    const token = tokenMatch[2];

    // Serve SPA for GET/HEAD browser navigation to join/controller URLs,
    // unless the client explicitly requests JSON via ?json=true
    // WebSocket upgrades must pass through to the Durable Object
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
      return jsonResponse(
        { error: 'Malformed capability token', code: 'MALFORMED_CAPABILITY' },
        400
      );
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

  // SPA fallback for GET/HEAD browser navigation, unless ?json=true
  if (!wantsJSON(request) && (request.method === 'GET' || request.method === 'HEAD')) {
    return serveSPA(request, env);
  }

  return jsonResponse(
    {
      service: 'slicc-tray-hub',
      phase: 1,
      routes: [
        'POST /tray',
        'GET /download/slicc.dmg',
        'GET /handoff',
        'GET /.well-known/api-catalog',
        'GET /llms.txt',
        'GET /status',
        'GET /rel/:name',
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'GET /auth/callback',
        'POST /oauth/token',
        'POST /oauth/revoke',
        'GET /api/runtime-config',
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
    },
    200
  );
}

const RELEASES_FALLBACK = 'https://github.com/ai-ecoverse/slicc/releases/latest';

async function handleDmgDownload(): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(RELEASES_FALLBACK, { redirect: 'manual' });
  } catch {
    return Response.redirect(RELEASES_FALLBACK, 302);
  }
  const location = res.headers.get('Location');
  if (!location) {
    return Response.redirect(RELEASES_FALLBACK, 302);
  }
  // Location is like https://github.com/ai-ecoverse/slicc/releases/tag/v1.59.1
  const tag = location.split('/tag/')[1];
  if (!tag) {
    return Response.redirect(RELEASES_FALLBACK, 302);
  }
  // Strip leading 'v' for the filename: v1.59.1 → 1.59.1
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  const dmgUrl = `https://github.com/ai-ecoverse/slicc/releases/download/${tag}/sliccstart-v${version}.dmg`;
  return Response.redirect(dmgUrl, 302);
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
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    // Root redirects to www.sliccy.com — indexable, return as-is
    if (url.pathname === '/' && url.search === '') {
      if (url.hostname === 'sliccy.ai') {
        return Response.redirect('https://www.sliccy.com/', 301);
      }
      if (url.hostname === 'www.sliccy.ai') {
        return Response.redirect('https://www.sliccy.com/', 301);
      }
    }

    const response = await handleWorkerRequest(request, env);
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
