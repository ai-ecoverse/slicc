/**
 * Shared `/__slicc/*` route handling for both preview-worker and hub preview path.
 * Returns a Response when the route matches, or null to fall through to normal preview logic.
 */
import { PREVIEW_BRIDGE_JS } from './preview-bridge-assets.js';
import { type DurableObjectNamespaceLike, parseCapabilityToken } from './shared.js';

interface BridgeEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
}

/**
 * Handle `/__slicc/*` bridge routes.
 * @param request - The incoming request
 * @param url - Parsed URL of the request
 * @param env - Worker environment with TRAY_HUB binding
 * @param previewToken - Already-parsed preview token from the host (caller extracted it)
 * @returns Response for a bridge route, or null to fall through to normal preview logic
 */
export async function handleBridgeRoute(
  request: Request,
  url: URL,
  env: BridgeEnv,
  previewToken: string
): Promise<Response | null> {
  // Only handle /__slicc/* paths
  if (!url.pathname.startsWith('/__slicc/')) {
    return null;
  }

  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) {
    return new Response('Invalid preview token', { status: 403 });
  }

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));

  // Route 1: GET /__slicc/preview-bridge.js — serve the embedded bootstrap IIFE
  if (url.pathname === '/__slicc/preview-bridge.js' && request.method === 'GET') {
    return new Response(PREVIEW_BRIDGE_JS, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // Route 2: POST /__slicc/emit — forward beacon payload to DO
  if (url.pathname === '/__slicc/emit' && request.method === 'POST') {
    const body = await request.text();
    return stub.fetch(
      new Request('https://internal/internal/preview/emit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ previewToken, body }),
      })
    );
  }

  // Route 3: WebSocket /__slicc/bridge with Upgrade header — forward to DO
  if (
    url.pathname === '/__slicc/bridge' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    // Forward the original request to the DO — it will read the token from the Host
    return stub.fetch(request);
  }

  // Unknown /__slicc/* path
  return new Response('Not found', { status: 404 });
}
