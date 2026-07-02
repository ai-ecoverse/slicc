/**
 * Dedicated preview worker — serves `*.sliccy.dev` (staging) and
 * `*.sliccy.now` (prod) preview URLs. No static assets binding, so
 * Cloudflare's asset CDN can't intercept requests before the worker runs.
 *
 * References the TRAY_HUB Durable Object from the main `slicc-tray-hub`
 * worker via `script_name` in wrangler.jsonc.
 */

import { handleBridgeRoute } from './preview-bridge-routes.js';
import { cachedPreviewFetch } from './preview-cache.js';
import { previewTokenFromHost } from './preview-host.js';
import { type DurableObjectNamespaceLike, parseCapabilityToken } from './shared.js';

interface PreviewWorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
}

export default {
  async fetch(request: Request, env: PreviewWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const previewToken = previewTokenFromHost(url.host);
    if (!previewToken) {
      return new Response('Not a preview URL', { status: 404 });
    }
    const parsed = parseCapabilityToken(previewToken);
    if (!parsed) {
      return new Response('Invalid preview token', { status: 404 });
    }

    // Check for bridge routes before resolving preview
    const bridged = await handleBridgeRoute(request, url, env, previewToken);
    if (bridged) return bridged;

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));

    const resolveRes = await stub.fetch(
      new Request(
        `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
      )
    );
    if (resolveRes.status !== 200) {
      return new Response('Preview not found', { status: 404 });
    }
    const record = (await resolveRes.json()) as {
      servedRoot: string;
      entryPath: string;
      allowLive: boolean;
      cacheVersion: number;
      bridge: boolean;
      maxTabs: number;
      webhookId?: string;
    };

    const path = url.pathname;
    const vfsPath = path === '/' ? record.entryPath : joinUnderRoot(record.servedRoot, path);
    const asText = /\.(html?|css|js|mjs|json|svg|txt|xml|md)$/i.test(vfsPath);

    const response = await cachedPreviewFetch({
      request,
      allowLive: record.allowLive,
      cacheVersion: record.cacheVersion ?? 1,
      fetchFromDO: () =>
        stub.fetch(
          new Request('https://internal/internal/preview/fetch', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reqId: crypto.randomUUID(),
              servedRoot: record.servedRoot,
              vfsPath,
              asText,
            }),
          })
        ),
    });

    // Inject bridge bootstrap if record.bridge && text/html
    if (record.bridge) {
      const { injectBridge } = await import('./preview-bridge-routes.js');
      const scheme = url.protocol === 'https:' ? 'wss' : 'ws';
      return injectBridge(response, { previewToken, host: url.host, scheme });
    }

    return response;
  },
};

function joinUnderRoot(servedRoot: string, urlPath: string): string {
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  const tail = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${root}${tail}`;
}
