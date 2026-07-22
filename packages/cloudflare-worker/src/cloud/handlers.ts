import { MAX_CONE_CONFIG_BYTES, validateConeConfigDelta } from '@slicc/cloud-core/cone-config';
import { authenticateRequest } from './auth-middleware.js';
import { errorResponse } from './error-envelope.js';
import { checkRateLimit } from './rate-limit.js';

export interface CloudEnv {
  CLOUD_SESSIONS: DurableObjectNamespaceLike;
  E2B_API_KEY: string;
  IMS_ENVIRONMENT: string;
  IMS_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  BLOCKED_EMAILS: string;
  REQUIRE_OWNER_ORG: string;
}

// Loose typing — version-independent from @cloudflare/workers-types
export interface DurableObjectStubLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
export interface DurableObjectIdLike {
  toString(): string;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

function getDoStub(env: CloudEnv, userId: string): DurableObjectStubLike {
  const id = env.CLOUD_SESSIONS.idFromName(userId);
  return env.CLOUD_SESSIONS.get(id);
}

async function forwardToDo(
  stub: DurableObjectStubLike,
  endpoint: string,
  body: Record<string, unknown>
): Promise<Response> {
  try {
    return await stub.fetch(`https://do${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[cloud] DO RPC failed:', endpoint, err);
    return errorResponse(503, 'DO_UNREACHABLE', err instanceof Error ? err.message : String(err));
  }
}

export async function handleStart(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'start');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many start requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const bearer = request.headers.get('Authorization')!.slice(7);
  const body = (await request.json().catch(() => ({}))) as { name?: string; coneConfig?: unknown };
  try {
    validateStartBody(body);
  } catch (e) {
    return errorResponse(400, 'BAD_REQUEST', (e as Error).message);
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/start-cone', {
    bearer,
    name: body.name,
    coneConfig: body.coneConfig,
    userId: auth.userId,
    workerOrigin: new URL(request.url).origin,
  });
}

export async function handleList(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'list');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many list requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/list-cones', { userId: auth.userId });
}

export async function handlePause(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'pause');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many pause requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const body = (await request.json().catch(() => ({}))) as { sandboxId?: string };
  if (!body.sandboxId) {
    return errorResponse(400, 'BAD_REQUEST', 'sandboxId is required');
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/pause-cone', { sandboxId: body.sandboxId });
}

export async function handleResume(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'resume');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many resume requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const bearer = request.headers.get('Authorization')!.slice(7);
  const body = (await request.json().catch(() => ({}))) as {
    sandboxId?: string;
    coneConfigDelta?: unknown;
  };
  if (!body.sandboxId) {
    return errorResponse(400, 'BAD_REQUEST', 'sandboxId is required');
  }
  try {
    validateResumeBody(body);
  } catch (e) {
    return errorResponse(400, 'BAD_REQUEST', (e as Error).message);
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/resume-cone', {
    bearer,
    sandboxId: body.sandboxId,
    coneConfigDelta: body.coneConfigDelta,
    localSliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
    userId: auth.userId,
  });
}

export async function handleKill(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'kill');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many kill requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const body = (await request.json().catch(() => ({}))) as { sandboxId?: string };
  if (!body.sandboxId) {
    return errorResponse(400, 'BAD_REQUEST', 'sandboxId is required');
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/kill-cone', { sandboxId: body.sandboxId });
}

export function validateStartBody(body: { name?: string; coneConfig?: unknown }): void {
  if (body.coneConfig !== undefined) {
    const size = new TextEncoder().encode(JSON.stringify(body.coneConfig)).length;
    if (size > MAX_CONE_CONFIG_BYTES) {
      throw new Error(`coneConfig too large: ${size} > ${MAX_CONE_CONFIG_BYTES}`);
    }
  }
}

export function validateResumeBody(body: { coneConfigDelta?: unknown }): void {
  if (body.coneConfigDelta === undefined) return;
  const size = new TextEncoder().encode(JSON.stringify(body.coneConfigDelta)).length;
  if (size > MAX_CONE_CONFIG_BYTES) {
    throw new Error(`coneConfigDelta too large: ${size} > ${MAX_CONE_CONFIG_BYTES}`);
  }
  // Shape/hygiene validation (env-name, single-line values, etc.). Errors are
  // redacted (shape only, never values) — safe to surface as a 400.
  validateConeConfigDelta(body.coneConfigDelta);
}

export async function handleConeConfig(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const sandboxId = new URL(request.url).searchParams.get('sandboxId');
  if (!sandboxId) return errorResponse(400, 'BAD_REQUEST', 'sandboxId is required');
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/cone-config-index', { sandboxId, userId: auth.userId });
}
