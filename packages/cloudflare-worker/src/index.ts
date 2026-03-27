import {
  createCapabilityToken,
  jsonResponse,
  parseCapabilityToken,
  wantsJSON,
  type CreateTrayRequest,
  type DurableObjectNamespaceLike,
} from './shared.js';
import { SessionTrayDurableObject } from './session-tray.js';

export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
}

function serveSPA(request: Request, env: WorkerEnv): Promise<Response> {
  return env.ASSETS.fetch(request);
}

const OAUTH_RELAY_HTML = `<!DOCTYPE html>
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
  var port = Number(state.port);
  var path = state.path || '/auth/callback';
  var nonce = state.nonce || '';
  if (!port || port < 1024 || port > 65535) throw new Error('Invalid port: ' + port);
  if (!path.startsWith('/')) throw new Error('Invalid path');
  var target = 'http://localhost:' + port + path + '?nonce=' + encodeURIComponent(nonce);
  location.replace(target + location.hash);
} catch (e) {
  document.getElementById('msg').textContent = 'OAuth redirect failed: ' + e.message + '. Close this window and try again.';
}
</script>
</body></html>`;

export async function handleWorkerRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.hostname === 'sliccy.ai') {
    const target = new URL(url.toString());
    target.hostname = 'www.sliccy.ai';
    return Response.redirect(target.toString(), 301);
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
    return new Response(OAUTH_RELAY_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Serve runtime config for the webapp (when served from the worker)
  if (url.pathname === '/api/runtime-config') {
    const workerBaseUrl = `${url.protocol}//${url.host}`;
    return jsonResponse({ trayWorkerBaseUrl: workerBaseUrl });
  }

  // Fetch proxy not available in worker mode (webapp uses direct fetch instead)
  if (url.pathname === '/api/fetch-proxy') {
    return jsonResponse({ error: 'Fetch proxy not available in worker mode' }, 404);
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
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'GET /auth/callback',
        'GET /api/runtime-config',
        'ANY /api/fetch-proxy',
      ],
    },
    200
  );
}

async function createTray(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const trayId = crypto.randomUUID();
  const payload: CreateTrayRequest = {
    trayId,
    createdAt: new Date().toISOString(),
    joinToken: createCapabilityToken(trayId),
    controllerToken: createCapabilityToken(trayId),
    webhookToken: createCapabilityToken(trayId),
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
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
};

export default worker;
export { SessionTrayDurableObject };
