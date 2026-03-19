import {
  createCapabilityToken,
  jsonResponse,
  parseCapabilityToken,
  type CreateTrayRequest,
  type DurableObjectNamespaceLike,
} from './shared.js';
import { SessionTrayDurableObject } from './session-tray.js';

export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
}

export async function handleWorkerRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/tray' && request.method === 'POST') {
    return createTray(request, env);
  }

  if ((url.pathname === '/session' || url.pathname === '/trays') && request.method === 'POST') {
    return jsonResponse(
      {
        error: 'Tray creation moved to POST /tray',
        code: 'TRAY_CREATE_ENDPOINT_MOVED',
        canonical: 'POST /tray',
      },
      410,
    );
  }

  const tokenMatch = url.pathname.match(/^\/(join|controller|webhook)\/([^/]+?)(?:\/([^/]+))?$/);
  if (tokenMatch) {
    const token = tokenMatch[2];
    const parsed = parseCapabilityToken(token);
    if (!parsed) {
      return jsonResponse({ error: 'Malformed capability token', code: 'MALFORMED_CAPABILITY' }, 400);
    }
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(parsed.trayId));
    const webhookId = tokenMatch[1] === 'webhook' ? tokenMatch[3] : undefined;
    if (webhookId) {
      const doUrl = new URL(request.url);
      doUrl.pathname = `/webhook/${token}/${webhookId}`;
      return stub.fetch(new Request(doUrl, request));
    }
    return stub.fetch(request);
  }

  return jsonResponse(
    {
      service: 'slicc-tray-hub',
      phase: 1,
      routes: ['POST /tray', 'GET|POST /join/:token', 'GET|POST /controller/:token', 'POST /webhook/:token/:webhookId'],
    },
    200,
  );
}

async function createTray(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const trayId = crypto.randomUUID();
  const payload: CreateTrayRequest = {
    trayId,
    createdAt: new Date().toISOString(),
    joinToken: createCapabilityToken(trayId),
    controllerToken: createCapabilityToken(trayId),
    webhookToken: createCapabilityToken(trayId),
  };

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(trayId));
  const initResponse = await stub.fetch(
    new Request(new URL('/internal/create', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

  if (initResponse.status >= 400) {
    return initResponse;
  }

  return jsonResponse(
    {
      trayId,
      createdAt: payload.createdAt,
      capabilities: {
        join: {
          token: payload.joinToken,
          url: `${url.origin}/join/${payload.joinToken}`,
        },
        controller: {
          token: payload.controllerToken,
          url: `${url.origin}/controller/${payload.controllerToken}`,
        },
        webhook: {
          token: payload.webhookToken,
          url: `${url.origin}/webhook/${payload.webhookToken}`,
        },
      },
    },
    201,
  );
}

const worker = {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
};

export default worker;
export { SessionTrayDurableObject };