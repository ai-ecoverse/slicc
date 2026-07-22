import { beforeEach, describe, expect, it } from 'vitest';
import { clearAll as clearAuthCache, getCached, setCached } from '../src/cloud/auth-cache.js';
import { handleAdminStats } from '../src/cloud/handler-admin.js';
import { handleSignOut } from '../src/cloud/handler-signout.js';
import {
  handleKill,
  handleList,
  handlePause,
  handleResume,
  handleStart,
} from '../src/cloud/handlers.js';
import { clearAll as clearRateLimit } from '../src/cloud/rate-limit.js';
import {
  getRecordedCalls,
  makeCloudEnv,
  resetMockNamespace,
  setMockResponse,
} from './cloud-handlers-helpers.js';

beforeEach(() => {
  clearAuthCache();
  clearRateLimit();
  resetMockNamespace();
});

async function authedRequest(url: string, body?: unknown): Promise<Request> {
  await setCached('test-bearer', {
    userId: 'u1',
    email: 'kpauls@adobe.com',
    userName: 'Karl',
  });
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-bearer',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('handleStart', () => {
  it('forwards to DO /start-cone with bearer + userId + workerOrigin', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w.test/api/cloud/start', { name: 'smoke' });
    const res = await handleStart(req, env);
    expect(res.status).toBe(200);
    const calls = getRecordedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.endpoint).toBe('/start-cone');
    expect(calls[0]!.body).toMatchObject({
      bearer: 'test-bearer',
      name: 'smoke',
      userId: 'u1',
      workerOrigin: 'https://w.test',
    });
    // Email must NOT be forwarded to the DO — it's PII and the e2b sandbox
    // metadata is third-party-visible. Only userId (opaque IMS sub) flows.
    expect(calls[0]!.body).not.toHaveProperty('email');
  });

  it('returns 401 without Authorization header', async () => {
    const env = makeCloudEnv();
    const req = new Request('https://w/start', { method: 'POST' });
    const res = await handleStart(req, env);
    expect(res.status).toBe(401);
  });

  it('passes through DO 409 NAME_TAKEN', async () => {
    const env = makeCloudEnv();
    setMockResponse(() =>
      Response.json(
        { error: 'NAME_TAKEN', message: 'cloud session name already exists' },
        { status: 409 }
      )
    );
    const req = await authedRequest('https://w/start', {});
    const res = await handleStart(req, env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NAME_TAKEN');
  });

  it('maps DO stub throw to 503 DO_UNREACHABLE', async () => {
    const env = makeCloudEnv();
    setMockResponse(() => {
      throw new Error('Durable Object eviction or network error');
    });
    const req = await authedRequest('https://w/start', {});
    const res = await handleStart(req, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('DO_UNREACHABLE');
    expect(body.message).toContain('Durable Object');
  });

  it('returns 429 after 30 start requests in the same window', async () => {
    const env = makeCloudEnv();
    for (let i = 0; i < 30; i++) {
      const req = await authedRequest('https://w/start', {});
      const r = await handleStart(req, env);
      expect(r.status).toBe(200);
    }
    const req = await authedRequest('https://w/start', {});
    const res = await handleStart(req, env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; details?: { retryAfterSec: number } };
    expect(body.error).toBe('RATE_LIMITED');
  });
});

describe('handleList', () => {
  it('forwards to DO /list-cones with userId', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/list');
    const res = await handleList(req, env);
    expect(res.status).toBe(200);
    const calls = getRecordedCalls();
    expect(calls[0]!.endpoint).toBe('/list-cones');
    expect(calls[0]!.body).toEqual({ userId: 'u1' });
  });
});

describe('handlePause', () => {
  it('forwards sandboxId to DO /pause-cone', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/pause', { sandboxId: 'sbx-1' });
    const res = await handlePause(req, env);
    expect(res.status).toBe(200);
    expect(getRecordedCalls()[0]!.endpoint).toBe('/pause-cone');
    expect(getRecordedCalls()[0]!.body).toEqual({ sandboxId: 'sbx-1' });
  });

  it('returns 400 BAD_REQUEST when sandboxId is missing', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/pause', {});
    const res = await handlePause(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });
});

describe('handleResume', () => {
  it('forwards bearer + sandboxId + localSliccVersion + userId to DO /resume-cone', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/resume', { sandboxId: 'sbx-1' });
    const res = await handleResume(req, env);
    expect(res.status).toBe(200);
    const call = getRecordedCalls()[0]!;
    expect(call.endpoint).toBe('/resume-cone');
    expect(call.body).toMatchObject({
      bearer: 'test-bearer',
      sandboxId: 'sbx-1',
      userId: 'u1',
    });
    expect(typeof call.body.localSliccVersion).toBe('string');
  });

  it('returns 400 BAD_REQUEST when sandboxId is missing', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/resume', {});
    const res = await handleResume(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });
});

describe('handleKill', () => {
  it('forwards sandboxId to DO /kill-cone', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/kill', { sandboxId: 'sbx-1' });
    const res = await handleKill(req, env);
    expect(res.status).toBe(200);
    expect(getRecordedCalls()[0]!.endpoint).toBe('/kill-cone');
    expect(getRecordedCalls()[0]!.body).toEqual({ sandboxId: 'sbx-1' });
  });

  it('returns 400 BAD_REQUEST when sandboxId is missing', async () => {
    const env = makeCloudEnv();
    const req = await authedRequest('https://w/kill', {});
    const res = await handleKill(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });
});

describe('handleSignOut', () => {
  it('invalidates the auth cache for the bearer', async () => {
    await setCached('drop', { userId: 'u', email: 'k@adobe.com', userName: 'K' });
    const req = new Request('https://w/api/cloud/sign-out', {
      method: 'POST',
      headers: { Authorization: 'Bearer drop' },
    });
    const res = await handleSignOut(req);
    expect(res.status).toBe(200);
    expect(await getCached('drop')).toBeNull();
  });

  it('returns 401 without Authorization header', async () => {
    const req = new Request('https://w/api/cloud/sign-out', { method: 'POST' });
    const res = await handleSignOut(req);
    expect(res.status).toBe(401);
  });
});

describe('handleAdminStats', () => {
  it('returns 403 for non-admin users', async () => {
    await setCached('bearer', { userId: 'not-admin', email: 'k@adobe.com', userName: 'K' });
    const env = { ...makeCloudEnv(), ADMIN_USER_IDS: 'someone-else' };
    const req = new Request('https://w/api/cloud/admin/stats', {
      headers: { Authorization: 'Bearer bearer' },
    });
    const res = await handleAdminStats(req, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('NOT_ADMIN');
  });

  it('returns 200 for admin users', async () => {
    await setCached('bearer', { userId: 'admin-1', email: 'k@adobe.com', userName: 'K' });
    const env = { ...makeCloudEnv(), ADMIN_USER_IDS: 'admin-1, admin-2' };
    const req = new Request('https://w/api/cloud/admin/stats', {
      headers: { Authorization: 'Bearer bearer' },
    });
    const res = await handleAdminStats(req, env);
    expect(res.status).toBe(200);
  });
});
