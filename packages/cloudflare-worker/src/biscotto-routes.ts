// Worker-side HTTP routes for the biscotto (guest seat) mint/revoke/list API.
//
// Public surface (handleWorkerRequest in `index.ts` matches these paths):
//   POST   /api/tray/:trayId/biscotto      — mint a guest seat (Bearer = controllerToken)
//   POST   /api/tray/:trayId/biscotto/stop — revoke a seat by id
//   GET    /api/tray/:trayId/biscotti      — list seats (never returns tokens)
//
// Same shape as `preview-routes.ts`: extract the bearer, derive workerBaseUrl
// from the request URL, forward to the `SessionTrayDurableObject` via its
// `fetch()` surface. The matching `/internal/biscotto/...` branches live in
// session-tray.ts.
//
// Every route is authenticated by the tray's CONTROLLER token, i.e. only the
// leader mints and revokes seats. A guest seat is never an issuing authority.

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

function forward(path: string, payload: unknown, trayStub: TrayStub): Promise<Response> {
  return trayStub.fetch(
    new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
}

export async function handleBiscottoMint(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { label?: string; ttlMs?: number; gates?: unknown };
  try {
    body = (await request.json()) as { label?: string; ttlMs?: number; gates?: unknown };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (typeof body.label !== 'string') {
    return jsonResponse({ error: 'label is required' }, 400);
  }

  const url = new URL(request.url);
  return forward(
    '/internal/biscotto/mint',
    {
      controllerToken,
      label: body.label,
      ttlMs: body.ttlMs,
      gates: body.gates,
      workerBaseUrl: `${url.protocol}//${url.host}`,
    },
    trayStub
  );
}

export async function handleBiscottoStop(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: { id?: string };
  try {
    body = (await request.json()) as { id?: string };
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400);
  }
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ error: 'id is required' }, 400);
  }
  return forward('/internal/biscotto/stop', { controllerToken, id: body.id }, trayStub);
}

export async function handleBiscottoList(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) return jsonResponse({ error: 'unauthorized' }, 401);
  // GET carries no body, so the bearer is re-posted to the DO the same way the
  // preview list does — the DO's only production surface is fetch().
  return forward('/internal/biscotto/list', { controllerToken }, trayStub);
}
