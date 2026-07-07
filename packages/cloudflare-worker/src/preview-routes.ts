// Worker-side HTTP routes for the unified-preview mint/revoke/list API.
//
// Public surface (handleWorkerRequest in `index.ts` matches these paths):
//   POST /api/tray/:trayId/preview       — mint a preview token (Bearer = controllerToken)
//   POST /api/tray/:trayId/preview/stop  — revoke a preview token
//   GET  /api/tray/:trayId/previews      — list active preview records
//
// These handlers extract the bearer, derive workerBaseUrl from the request URL,
// then forward to the `SessionTrayDurableObject` via the DO stub's `fetch()` —
// the DO is a plain class whose only production surface is `fetch(request)`.
// See session-tray.ts dispatcher for the matching `/internal/preview/...` branches.

import { jsonResponse } from './shared.js';

interface TrayStub {
  fetch(request: Request): Promise<Response>;
}

function extractBearer(request: Request): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export async function handlePreviewMint(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: {
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    bridge?: boolean;
    maxTabs?: number;
    webhookId?: string;
    userHash?: string;
  };
  try {
    body = (await request.json()) as {
      servedRoot: string;
      entryPath: string;
      allowLive: boolean;
      bridge?: boolean;
      maxTabs?: number;
      webhookId?: string;
      userHash?: string;
    };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (body.userHash !== undefined && !/^[0-9a-f]{8}$/.test(body.userHash)) {
    return jsonResponse({ error: 'invalid userHash (expected 8 lowercase hex chars)' }, 400);
  }
  const url = new URL(request.url);
  const workerBaseUrl = `${url.protocol}//${url.host}`;
  return trayStub.fetch(
    new Request('https://internal/internal/preview/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken,
        servedRoot: body.servedRoot,
        entryPath: body.entryPath,
        allowLive: body.allowLive,
        bridge: body.bridge,
        maxTabs: body.maxTabs,
        webhookId: body.webhookId,
        userHash: body.userHash,
        workerBaseUrl,
      }),
    })
  );
}

export async function handlePreviewStop(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  let body: { previewToken: string };
  try {
    body = (await request.json()) as { previewToken: string };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  return trayStub.fetch(
    new Request('https://internal/internal/preview/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken,
        previewToken: body.previewToken,
      }),
    })
  );
}

export async function handlePreviewList(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  return trayStub.fetch(
    new Request('https://internal/internal/preview/list', {
      method: 'GET',
      headers: { 'x-controller-token': controllerToken },
    })
  );
}
