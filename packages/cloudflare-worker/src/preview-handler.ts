// Worker-side host dispatcher for unified-preview HTTP requests. Shared by
// the hub worker (`index.ts` forwards any preview host here) and the dedicated
// preview worker (`preview-worker.ts`, `*.sliccy.now` / `*.sliccy.dev`).
//
//   1. Validate the host carries a syntactically-valid preview token.
//   2. Fetch the `PreviewRecord` from the tray's Durable Object (resolves the
//      `servedRoot`/`entryPath`/`allowLive` policy that was minted by `serve`).
//   3. `--ttl` snapshots are served from R2; `--bridge` previews answer the
//      `/__slicc/*` bridge routes.
//   4. Map the request path to a VFS path (root → entryPath; anything else →
//      servedRoot + path) and tell the DO to round-trip a `preview.request`
//      with the leader over the controller WS; the DO blocks until
//      `preview.response` chunks arrive or a 30s timeout fires. The visitor's
//      `Range` rides along (see `cachedPreviewFetch`).
//
// The DO is the single owner of the leader WebSocket — the worker thread
// cannot reach the socket directly. All leader I/O is mediated through
// `stub.fetch('https://internal/internal/preview/fetch', …)`.

import { servePersistentPreview } from './persistent-preview-storage.js';
import { PREVIEW_BRIDGE_JS } from './preview-bridge-assets.js';
import { cachedPreviewFetch } from './preview-cache.js';
import { previewTokenFromHost } from './preview-host.js';
import {
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
  type PreviewRecord,
  parseCapabilityToken,
} from './shared.js';

/** The bindings the preview path needs; both workers' envs satisfy it. */
export interface PreviewEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  PREVIEW_STORAGE: R2Bucket;
}

export async function handlePreviewRequest(request: Request, env: PreviewEnv): Promise<Response> {
  const url = new URL(request.url);
  const hostResult = previewTokenFromHost(url.host);
  if (!hostResult) {
    return new Response('Not a preview URL', { status: 404 });
  }
  const { token: previewToken } = hostResult;
  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) {
    return new Response('Invalid preview token', { status: 404 });
  }

  // Resolve the PreviewRecord FIRST — its `bridge` flag gates the `/__slicc/*`
  // routes below. The token is itself the capability, so this call is
  // unauthenticated; a wrong/expired/unknown token yields 404.
  const resolveRes = await env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId)).fetch(
    new Request(
      `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
    )
  );
  if (resolveRes.status !== 200) {
    const unavailable = resolveRes.status >= 500;
    return new Response(unavailable ? 'Preview temporarily unavailable' : 'Preview not found', {
      status: unavailable ? 503 : 404,
    });
  }
  const record = (await resolveRes.json()) as PreviewRecord;
  // A preview carried across a rove is served by the tray that holds it now.
  const servingTrayId = resolveRes.headers.get('x-slicc-preview-tray') ?? parsed.trayId;
  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(servingTrayId));

  if (record.mode === 'persistent') {
    return servePersistentPreview(request, url, record, env.PREVIEW_STORAGE);
  }

  // Bridge routes (bootstrap JS / emit / WS) are served only for bridged previews.
  if (record.bridge) {
    const bridged = await handleBridgeRoute(request, url, stub, previewToken);
    if (bridged) return bridged;
  }

  const response = await fetchLivePreview(request, url, record, stub, previewToken);

  if (record.bridge) {
    const scheme = url.protocol === 'https:' ? 'wss' : 'ws';
    return injectBridge(response, { previewToken, host: url.host, scheme });
  }
  return response;
}

function fetchLivePreview(
  request: Request,
  url: URL,
  record: PreviewRecord,
  stub: DurableObjectStubLike,
  previewToken: string
): Promise<Response> {
  // Map URL path → VFS path. The root URL serves the configured entry file;
  // everything else lives under `servedRoot`. Path traversal is the leader's
  // responsibility (it enforces the `servedRoot` jail) but we still pass a
  // joined path for the leader's normal lookup.
  const path = url.pathname;
  const vfsPath = path === '/' ? record.entryPath : joinUnderRoot(record.servedRoot, path);
  const asText = isTextLikeByExtension(vfsPath);
  // A bridged page gets a script injected into its body, so byte offsets of
  // the stored file no longer describe what the visitor receives: serve such
  // pages whole (always a valid answer to a Range request).
  const honourRange = !(record.bridge && /\.html?$/i.test(vfsPath));

  return cachedPreviewFetch({
    request,
    allowLive: record.allowLive,
    cacheVersion: record.cacheVersion ?? 1,
    fetchFromDO: (range) =>
      stub.fetch(
        new Request('https://internal/internal/preview/fetch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            reqId: crypto.randomUUID(),
            previewToken,
            servedRoot: record.servedRoot,
            vfsPath,
            asText,
            ...(range && honourRange ? { range } : {}),
          }),
        })
      ),
  });
}

// Join `servedRoot` with the URL path. Both are absolute-style with leading
// slashes; collapse a double slash at the seam (`/workspace/dist` + `/foo` →
// `/workspace/dist/foo`).
function joinUnderRoot(servedRoot: string, urlPath: string): string {
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  const tail = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${root}${tail}`;
}

// Cheap heuristic so the leader knows whether to send utf-8 vs base64. Real
// content-type detection happens leader-side; this only steers transport.
function isTextLikeByExtension(path: string): boolean {
  return /\.(html?|css|js|mjs|json|svg|txt|xml|md)$/i.test(path);
}

/**
 * Handle the `/__slicc/*` routes of a `--bridge` preview. Returns null to fall
 * through to normal preview serving — including for an unknown `/__slicc/*`
 * path, so a real file the served directory exposes there is not shadowed.
 * Callers only invoke this for bridged previews: the namespace is reserved
 * for the bridge, and a non-bridged preview must never leak its bootstrap.
 */
export async function handleBridgeRoute(
  request: Request,
  url: URL,
  stub: DurableObjectStubLike,
  previewToken: string
): Promise<Response | null> {
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

  // Only inject into a complete text/html body; never into a 206 window.
  if (response.status !== 200 || !contentType.includes('text/html')) {
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
