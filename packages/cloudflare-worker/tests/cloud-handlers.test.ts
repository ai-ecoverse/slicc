import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleStart,
  handleList,
  handlePause,
  handleResume,
  handleKill,
} from '../src/cloud/handlers.js';
import { setCached, clearAll as clearAuthCache } from '../src/cloud/auth-cache.js';
import { clearAll as clearRateLimit } from '../src/cloud/rate-limit.js';
import {
  makeCloudEnv,
  resetMockNamespace,
  getRecordedCalls,
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
      email: 'kpauls@adobe.com',
      workerOrigin: 'https://w.test',
    });
  });

  it('returns 401 without Authorization header', async () => {
    const env = makeCloudEnv();
    const req = new Request('https://w/start', { method: 'POST' });
    const res = await handleStart(req, env);
    expect(res.status).toBe(401);
  });

  it('passes through DO 403 CAP_EXCEEDED', async () => {
    const env = makeCloudEnv();
    setMockResponse(() =>
      Response.json({ error: 'CAP_EXCEEDED', message: 'at running cap' }, { status: 403 })
    );
    const req = await authedRequest('https://w/start', {});
    const res = await handleStart(req, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CAP_EXCEEDED');
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
});
