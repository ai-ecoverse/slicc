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

async function readJsonObject<T>(request: Request): Promise<T | null> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
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

  const body = await readJsonObject<{ label?: string; ttlMs?: number; gates?: unknown }>(request);
  if (!body) return jsonResponse({ error: 'invalid body' }, 400);
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

  const body = await readJsonObject<{ id?: string }>(request);
  if (!body) return jsonResponse({ error: 'invalid body' }, 400);
  if (typeof body.id !== 'string' || body.id.length === 0) {
    return jsonResponse({ error: 'id is required' }, 400);
  }
  return forward('/internal/biscotto/stop', { controllerToken, id: body.id }, trayStub);
}

export async function handleBiscottoList(request: Request, trayStub: TrayStub): Promise<Response> {
  const controllerToken = extractBearer(request);
  if (!controllerToken) return jsonResponse({ error: 'unauthorized' }, 401);

  return forward('/internal/biscotto/list', { controllerToken }, trayStub);
}
