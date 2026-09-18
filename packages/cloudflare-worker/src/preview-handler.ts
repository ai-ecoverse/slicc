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

  const servingTrayId = resolveRes.headers.get('x-slicc-preview-tray') ?? parsed.trayId;
  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(servingTrayId));

  if (record.mode === 'persistent') {
    return servePersistentPreview(request, url, record, env.PREVIEW_STORAGE);
  }

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
  const path = url.pathname;
  const vfsPath = path === '/' ? record.entryPath : joinUnderRoot(record.servedRoot, path);
  const asText = isTextLikeByExtension(vfsPath);

  const honourRange = !record.bridge || /\.(?!html?$)[^./]+$/i.test(vfsPath);

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

function joinUnderRoot(servedRoot: string, urlPath: string): string {
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  const tail = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${root}${tail}`;
}

function isTextLikeByExtension(path: string): boolean {
  return /\.(html?|css|js|mjs|json|svg|txt|xml|md)$/i.test(path);
}

export async function handleBridgeRoute(
  request: Request,
  url: URL,
  stub: DurableObjectStubLike,
  previewToken: string
): Promise<Response | null> {
  if (url.pathname === '/__slicc/preview-bridge.js' && request.method === 'GET') {
    return new Response(PREVIEW_BRIDGE_JS, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

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

  if (
    url.pathname === '/__slicc/bridge' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return stub.fetch(request);
  }

  return null;
}

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

  return scriptTag + html;
}

export async function injectBridge(
  response: Response,
  opts: { previewToken: string; host: string; scheme: 'ws' | 'wss' }
): Promise<Response> {
  const { previewToken, host, scheme } = opts;
  const contentType = response.headers.get('content-type') || '';

  if (response.status !== 200 || !contentType.includes('text/html')) {
    return response;
  }

  const scriptTag = `<script src="/__slicc/preview-bridge.js" data-slicc-token="${previewToken}" data-slicc-ws="${scheme}://${host}/__slicc/bridge"></script>`;

  try {
    let newBody: string;

    if (typeof HTMLRewriter !== 'undefined') {
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

      newBody = await rewriter.text();

      if (!injected) {
        newBody = insertBootstrapScript(newBody, scriptTag);
      }
    } else {
      const html = await response.clone().text();
      newBody = insertBootstrapScript(html, scriptTag);
    }

    const headers = new Headers(response.headers);
    const existingCsp = headers.get('content-security-policy') || '';
    let newCsp: string;

    const connectSrcMatch = existingCsp.match(/connect-src\s+([^;]+)/);
    if (connectSrcMatch) {
      const existingConnectSrc = connectSrcMatch[1];
      const augmented = `${existingConnectSrc} ${scheme}://${host}`;
      newCsp = existingCsp.replace(connectSrcMatch[0], `connect-src ${augmented}`);
    } else {
      newCsp = existingCsp + (existingCsp ? '; ' : '') + `connect-src 'self' ${scheme}://${host}`;
    }

    headers.set('content-security-policy', newCsp);

    return new Response(newBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}
