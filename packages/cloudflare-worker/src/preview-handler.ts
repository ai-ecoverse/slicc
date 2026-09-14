import type { WorkerEnv } from './index.js';
import { servePersistentPreview } from './persistent-preview-storage.js';
import { handleBridgeRoute, injectBridge } from './preview-bridge-routes.js';
import { cachedPreviewFetch } from './preview-cache.js';
import { previewTokenFromHost } from './preview-host.js';
import { type PreviewRecord, parseCapabilityToken } from './shared.js';

export async function handlePreviewRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const hostResult = previewTokenFromHost(url.host);
  if (!hostResult) {
    return new Response('Not found', { status: 404 });
  }
  const { token: previewToken } = hostResult;
  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) {
    return new Response('Not found', { status: 404 });
  }

  let stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));

  const resolveRes = await stub.fetch(
    new Request(
      `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
    )
  );
  if (resolveRes.status !== 200) {
    return new Response(
      resolveRes.status >= 500 ? 'Preview temporarily unavailable' : 'Not found',
      {
        status: resolveRes.status >= 500 ? 503 : 404,
      }
    );
  }
  const record = (await resolveRes.json()) as PreviewRecord;
  const servingTrayId = resolveRes.headers.get('x-slicc-preview-tray') ?? parsed.trayId;
  stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(servingTrayId));

  if (record.mode === 'persistent') {
    return servePersistentPreview(request, url, record, env.PREVIEW_STORAGE);
  }

  const bridged = await handleBridgeRoute(
    request,
    url,
    env,
    previewToken,
    record.bridge,
    servingTrayId
  );
  if (bridged) return bridged;

  const path = url.pathname;
  const vfsPath = path === '/' ? record.entryPath : joinUnderRoot(record.servedRoot, path);

  const asText = isTextLikeByExtension(vfsPath);

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
            previewToken,
            servedRoot: record.servedRoot,
            vfsPath,
            asText,
          }),
        })
      ),
  });

  if (record.bridge) {
    const scheme = url.protocol === 'https:' ? 'wss' : 'ws';
    return injectBridge(response, { previewToken, host: url.host, scheme });
  }

  return response;
}

function joinUnderRoot(servedRoot: string, urlPath: string): string {
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  const tail = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  return `${root}${tail}`;
}

function isTextLikeByExtension(path: string): boolean {
  return /\.(html?|css|js|mjs|json|svg|txt|xml|md)$/i.test(path);
}
