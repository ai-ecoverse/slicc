// Worker-side host dispatcher for unified-preview HTTP requests.
//
// Routing entry point: `index.ts` checks `previewTokenFromHost(url.host)` very
// early in `handleWorkerRequest` and forwards here. Steps below:
//
//   1. Validate the host carries a syntactically-valid preview token.
//   2. Fetch the `PreviewRecord` from the tray's Durable Object (resolves the
//      `servedRoot`/`entryPath`/`allowLive` policy that was minted by `serve`).
//   3. Map the request path to a VFS path (root → entryPath; anything else →
//      servedRoot + path).
//   4. Tell the DO to round-trip a `preview.request` with the leader over the
//      controller WS; the DO blocks until `preview.response` chunks arrive or
//      a 30s timeout fires.
//
// The DO is the single owner of the leader WebSocket — the worker thread
// cannot reach the socket directly. All leader I/O is mediated through
// `stub.fetch('https://internal/internal/preview/fetch', …)`.

import type { WorkerEnv } from './index.js';
import { previewTokenFromHost } from './preview-host.js';
import { parseCapabilityToken } from './shared.js';

export async function handlePreviewRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const previewToken = previewTokenFromHost(url.host);
  if (!previewToken) {
    return new Response('Not found', { status: 404 });
  }
  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) {
    return new Response('Not found', { status: 404 });
  }

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));

  // Resolve the PreviewRecord. The token is itself the capability, so this
  // call is unauthenticated; a wrong/expired/unknown token yields 404.
  const resolveRes = await stub.fetch(
    new Request(
      `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
    )
  );
  if (resolveRes.status !== 200) {
    return new Response('Not found', { status: 404 });
  }
  const record = (await resolveRes.json()) as {
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
  };

  // Map URL path → VFS path. The root URL serves the configured entry file;
  // everything else lives under `servedRoot`. Path traversal is the leader's
  // responsibility (it enforces the `servedRoot` jail) but we still pass a
  // joined path for the leader's normal lookup.
  const path = url.pathname;
  const vfsPath = path === '/' ? record.entryPath : joinUnderRoot(record.servedRoot, path);

  const asText = isTextLikeByExtension(vfsPath);

  const fetchRes = await stub.fetch(
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
  );
  return fetchRes;
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
