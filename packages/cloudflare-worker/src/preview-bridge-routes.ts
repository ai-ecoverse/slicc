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
 * @param bridge - Whether the resolved PreviewRecord opted into `--bridge`. The
 *   `/__slicc/*` namespace is reserved for the bridge, so a non-bridged preview
 *   falls through (returns null) — its bootstrap JS never leaks and a real file
 *   at that path is served by the normal preview pipe instead.
 * @returns Response for a bridge route, or null to fall through to normal preview logic
 */
export async function handleBridgeRoute(
  request: Request,
  url: URL,
  env: BridgeEnv,
  previewToken: string,
  bridge: boolean
): Promise<Response | null> {
  // Only handle /__slicc/* paths, and only for bridged previews.
  if (!url.pathname.startsWith('/__slicc/') || !bridge) {
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

  // Unknown /__slicc/* path — fall through to normal preview serving rather than
  // shadowing a real file the served directory might expose under /__slicc/.
  return null;
}

/**
 * Insert the bootstrap `<script>` at the earliest safe anchor: inside `<head>`
 * when present, otherwise after `<body>` / `<html>` / `<!doctype …>`. Never
 * before a leading `<!DOCTYPE>` (that would force quirks mode). The `<head>`
 * pattern requires a `>` or whitespace after `head` so it can't match `<header>`.
 */
function insertBootstrapScript(html: string, scriptTag: string): string {
  const headOpen = html.match(/<head(?:\s[^>]*)?>/i);
  if (headOpen?.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + scriptTag + html.slice(at);
  }
  const anchor = html.match(/<body(?:\s[^>]*)?>|<html(?:\s[^>]*)?>|<!doctype[^>]*>/i);
  if (anchor?.index !== undefined) {
    const at = anchor.index + anchor[0].length;
    return html.slice(0, at) + scriptTag + html.slice(at);
  }
  // Bare fragment (no doctype/html/body) — prepend is safe, nothing to displace.
  return scriptTag + html;
}

/**
 * Inject the preview-bridge bootstrap script into an HTML response and augment CSP.
 * Only applied when record.bridge && content-type is text/html. Non-HTML / non-bridged
 * responses pass through unchanged.
 *
 * @param response - The preview response from the DO
 * @param opts - { previewToken, host, scheme } where scheme = 'ws' | 'wss'
 * @returns Modified response with injected script + augmented CSP, or original response
 */
export async function injectBridge(
  response: Response,
  opts: { previewToken: string; host: string; scheme: 'ws' | 'wss' }
): Promise<Response> {
  const { previewToken, host, scheme } = opts;
  const contentType = response.headers.get('content-type') || '';

  // Only inject for text/html
  if (!contentType.includes('text/html')) {
    return response;
  }

  const scriptTag = `<script src="/__slicc/preview-bridge.js" data-slicc-token="${previewToken}" data-slicc-ws="${scheme}://${host}/__slicc/bridge"></script>`;

  try {
    let newBody: string;

    // Use HTMLRewriter when available (Cloudflare runtime), fallback to string manipulation (tests)
    if (typeof HTMLRewriter !== 'undefined') {
      // HTMLRewriter available - stream-based injection
      let injected = false;
      const rewriter = new HTMLRewriter()
        .on('head', {
          element(element) {
            if (!injected) {
              element.append(scriptTag, { html: true });
              injected = true;
            }
          },
        })
        .transform(response.clone());

      // Read the transformed body
      newBody = await rewriter.text();

      // HTMLRewriter's `head` handler only fires when the served document has a
      // `<head>`. A head-less page (a bare fragment, or a minimal `<body>`-only
      // doc) would otherwise get NO bootstrap injected even though the CSP was
      // augmented — leaving `window.slicc` undefined. Insert at a safe anchor so
      // the bootstrap always loads WITHOUT displacing a leading `<!DOCTYPE>`.
      if (!injected) {
        newBody = insertBootstrapScript(newBody, scriptTag);
      }
    } else {
      // Fallback for test env - string-based injection. Read a CLONE so the
      // original response body stays intact for the catch-path fallback below.
      const html = await response.clone().text();
      newBody = insertBootstrapScript(html, scriptTag);
    }

    // Augment CSP to add connect-src 'self' <scheme>://<host>
    const headers = new Headers(response.headers);
    const existingCsp = headers.get('content-security-policy') || '';
    let newCsp: string;

    // Check if connect-src already exists
    const connectSrcMatch = existingCsp.match(/connect-src\s+([^;]+)/);
    if (connectSrcMatch) {
      // Append to existing connect-src
      const existingConnectSrc = connectSrcMatch[1];
      const augmented = `${existingConnectSrc} ${scheme}://${host}`;
      newCsp = existingCsp.replace(connectSrcMatch[0], `connect-src ${augmented}`);
    } else {
      // No connect-src — add it
      newCsp = existingCsp + (existingCsp ? '; ' : '') + `connect-src 'self' ${scheme}://${host}`;
    }

    headers.set('content-security-policy', newCsp);

    return new Response(newBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Injection failed (stream / parse error). Return the ORIGINAL response so
    // the preview still loads (just non-driveable) rather than 500-ing the whole
    // request. Safe because we only ever read clones of the body above.
    return response;
  }
}
