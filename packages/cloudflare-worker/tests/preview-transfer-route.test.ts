import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from '../src/index.js';
import { makeEnv } from './helpers/fake-env.js';

const target = { targetTrayId: 'target-tray', targetControllerToken: 'target.secret' };

function setup() {
  const fetch = vi.fn(async (_request: Request) => Response.json({ transferred: true, count: 2 }));
  const idFromName = vi.fn((name: string) => ({ toString: () => name }));
  const get = vi.fn(() => ({ fetch }));
  const env = makeEnv({
    TRAY_HUB: { idFromName, get } as unknown as WorkerEnv['TRAY_HUB'],
  });
  return { fetch, idFromName, env };
}

function request(body = JSON.stringify(target), auth: string | null = 'Bearer source.secret') {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (auth !== null) headers.set('authorization', auth);
  return new Request('https://example.com/api/tray/source-tray/preview-transfer', {
    method: 'POST',
    headers,
    body,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public preview transfer route', () => {
  it('routes to the source owner and forwards only the explicit contract', async () => {
    const { fetch, idFromName, env } = setup();
    const response = await handleWorkerRequest(
      request(JSON.stringify({ ...target, controllerToken: 'spoofed', extra: true })),
      env
    );
    expect(await response.json()).toEqual({ transferred: true, count: 2 });
    expect(idFromName).toHaveBeenCalledWith('source-tray');
    const forwarded = fetch.mock.calls[0][0];
    expect(forwarded.url).toBe('https://internal/internal/preview/transfer');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get('authorization')).toBeNull();
    expect(await forwarded.json()).toEqual({ controllerToken: 'source.secret', ...target });
  });

  it.each([null, '', 'Basic source.secret', 'Bearer ', 'Bearer has spaces'])(
    'rejects invalid authorization %s without forwarding',
    async (auth) => {
      const { fetch, env } = setup();
      expect((await handleWorkerRequest(request(undefined, auth), env)).status).toBe(401);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...target, targetTrayId: '../target' }),
    JSON.stringify({ ...target, targetTrayId: 1 }),
    JSON.stringify({ ...target, targetControllerToken: '' }),
    JSON.stringify({ ...target, targetControllerToken: 'x'.repeat(2049) }),
  ])('rejects invalid JSON or target %s', async (body) => {
    const { fetch, env } = setup();
    expect((await handleWorkerRequest(request(body), env)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caps actual streamed bytes even without content-length', async () => {
    const { fetch, env } = setup();
    expect((await handleWorkerRequest(request(' '.repeat(8193)), env)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an invalid source before resolving a durable object', async () => {
    const { idFromName, env } = setup();
    const invalid = new Request(
      'https://example.com/api/tray/bad%20source/preview-transfer',
      request()
    );
    expect((await handleWorkerRequest(invalid, env)).status).toBe(400);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it('bounds a stalled body and cancels its reader', async () => {
    vi.useFakeTimers();
    const { fetch, env } = setup();
    const cancel = vi.fn();
    const stalled = new Request(request(), {
      body: new ReadableStream({ cancel }),
      duplex: 'half',
    } as RequestInit);
    const pending = handleWorkerRequest(stalled, env);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await pending).status).toBe(400);
    expect(cancel).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 409, 503])('preserves owner response %s', async (status) => {
    const { fetch, env } = setup();
    fetch.mockResolvedValue(Response.json({ error: 'owner error' }, { status }));
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'owner error' });
  });

  it('bounds a stalled source RPC even when abort is ignored', async () => {
    vi.useFakeTimers();
    const { fetch, env } = setup();
    fetch.mockImplementation(() => new Promise(() => {}));
    const pending = handleWorkerRequest(request(), env);
    await vi.advanceTimersByTimeAsync(60_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(fetch.mock.calls[0][0].signal.aborted).toBe(true);
    expect(await response.text()).toContain('retry the same target');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not expose or log capability-bearing upstream failures', async () => {
    const { fetch, env } = setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockRejectedValue(new Error('source.secret target.secret'));
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('.secret');
    expect(log).not.toHaveBeenCalled();
  });

  it('does not transfer on GET', async () => {
    const { fetch, env } = setup();
    await handleWorkerRequest(new Request(request().url), env);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('advertises the route in the public API catalog', async () => {
    const { env } = setup();
    const response = await handleWorkerRequest(
      new Request('https://example.com/.well-known/api-catalog'),
      env
    );
    expect(await response.text()).toContain('/api/tray/:trayId/preview-transfer');
  });
});
