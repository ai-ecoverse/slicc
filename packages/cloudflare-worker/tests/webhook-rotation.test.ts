import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from '../src/index.js';
import { WEBHOOK_BODY_MAX_BYTES, WEBHOOK_IO_TIMEOUT_MS } from '../src/webhook-body.js';
import { WebhookHomeDurableObject } from '../src/webhook-home.js';
import { FakeDurableObjectState } from './fake-do-state.js';
import { makeEnv } from './helpers/fake-env.js';

const origin = 'https://hub.example';
const credentials = {
  oldConeId: 'cone',
  oldSecret: 'old-secret',
  oldRebindSecret: 'rebind-secret',
  secret: 'a'.repeat(32),
  rebindSecret: 'b'.repeat(32),
};
function request(body: unknown = credentials, token = 'controller') {
  return new Request(`${origin}/api/tray/tray/webhook/rotate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('public webhook rotation', () => {
  it('requires controller authorization before touching a home', async () => {
    const env = makeEnv();
    const get = vi.spyOn(env.WEBHOOK_HOMES, 'get');
    expect((await handleWorkerRequest(request(credentials, ''), env)).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects oversized rotation input before consulting either authority', async () => {
    const env = makeEnv();
    const home = vi.spyOn(env.WEBHOOK_HOMES, 'get');
    const tray = vi.spyOn(env.TRAY_HUB, 'get');
    const response = await handleWorkerRequest(
      request({ ...credentials, padding: 'x'.repeat(WEBHOOK_BODY_MAX_BYTES) }),
      env
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'WEBHOOK_BODY_REJECTED' });
    expect(home).not.toHaveBeenCalled();
    expect(tray).not.toHaveBeenCalled();
  });

  it('counts actual chunked bytes and cancels oversized input without Content-Length', async () => {
    const env = makeEnv();
    const home = vi.spyOn(env.WEBHOOK_HOMES, 'get');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(WEBHOOK_BODY_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const streamed = new Request(`${origin}/api/tray/tray/webhook/rotate`, {
      method: 'POST',
      headers: { authorization: 'Bearer untrusted' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(streamed.headers.has('content-length')).toBe(false);
    const response = await handleWorkerRequest(streamed, env);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(home).not.toHaveBeenCalled();
  });

  it('bounds a stalled rotation body and cancels the reader', async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv();
      const home = vi.spyOn(env.WEBHOOK_HOMES, 'get');
      const cancel = vi.fn();
      const stalled = new Request(`${origin}/api/tray/tray/webhook/rotate`, {
        method: 'POST',
        headers: { authorization: 'Bearer untrusted' },
        body: new ReadableStream<Uint8Array>({ cancel }),
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      const pending = handleWorkerRequest(stalled, env);
      await vi.advanceTimersByTimeAsync(WEBHOOK_IO_TIMEOUT_MS + 1);
      expect((await pending).status).toBe(408);
      expect(cancel).toHaveBeenCalledOnce();
      expect(home).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('echoes only the supplied replacements for exact retries without changing cone identity', async () => {
    const env = makeEnv();
    const rotate = vi.fn(async () => Response.json({ ok: true }));
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue({ fetch: rotate } as never);
    const first = await handleWorkerRequest(request(), env);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const result = await first.json();
    expect(await (await handleWorkerRequest(request(), env)).json()).toEqual(result);
    expect(result).toMatchObject({ coneId: credentials.oldConeId });
    expect(result).toHaveProperty('webhook.rebindToken', `cone.${credentials.rebindSecret}`);
    expect(result).toHaveProperty('webhook.url', `${origin}/wh/cone.${credentials.secret}`);
  });

  it.each([403, 500])('fails closed on home status %s without leaking secrets', async (status) => {
    const env = makeEnv();
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue({
      fetch: async () => new Response('old-secret rebind-secret', { status }),
    } as never);
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(status === 403 ? 403 : 502);
    expect(await response.text()).not.toMatch(/old-secret|rebind-secret/);
  });

  it('fails closed on a lost response', async () => {
    const env = makeEnv();
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockImplementation(() => {
      throw new Error('rebind-secret');
    });
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('rebind-secret');
  });

  it.each([
    null,
    {},
    { ...credentials, oldSecret: 123 },
    { ...credentials, secret: undefined, rebindSecret: undefined },
    { ...credentials, secret: credentials.oldSecret },
    { ...credentials, rebindSecret: credentials.oldRebindSecret },
    { ...credentials, rebindSecret: credentials.secret },
  ])('rejects malformed input', async (body) => {
    const env = makeEnv();
    const get = vi.spyOn(env.WEBHOOK_HOMES, 'get');
    expect((await handleWorkerRequest(request(body), env)).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('rotates through the real home, retries identically, and rejects the old delivery URL', async () => {
    const trayFetch = vi.fn(async (req: Request) => {
      if (
        ['/internal/confirm-controller', '/internal/confirm-controller-ownership'].includes(
          new URL(req.url).pathname
        )
      ) {
        return Response.json({ confirmed: true });
      }
      return Response.json({ delivered: true });
    });
    const env = makeEnv({
      TRAY_HUB: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: trayFetch }),
      } as unknown as WorkerEnv['TRAY_HUB'],
    });
    const home = new WebhookHomeDurableObject(new FakeDurableObjectState(), env);
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue(home as never);
    const bind = await home.fetch(
      new Request(`${origin}/internal/home/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          coneId: 'cone',
          secret: credentials.oldSecret,
          rebindSecret: credentials.oldRebindSecret,
          trayId: 'tray',
          controllerToken: 'controller',
        }),
      })
    );
    expect(bind.status).toBe(200);
    const first = await handleWorkerRequest(request(), env);
    expect(first.status).toBe(200);
    const result = (await first.json()) as { coneId: string; webhook: { url: string } };
    expect(result.coneId).toBe('cone');
    const retry = await handleWorkerRequest(request(), env);
    expect(await retry.json()).toEqual(result);
    for (const body of [
      { ...credentials, secret: 'c'.repeat(32) },
      { ...credentials, rebindSecret: 'd'.repeat(32) },
      { ...credentials, secret: undefined, rebindSecret: undefined },
    ]) {
      const stale = await handleWorkerRequest(request(body), env);
      expect(stale.ok).toBe(false);
      expect(await stale.text()).not.toContain(credentials.secret);
    }
    const revoked = await home.fetch(
      new Request(`${origin}/internal/home/revoke`, {
        method: 'POST',
        body: JSON.stringify({ rebindSecret: credentials.oldRebindSecret }),
      })
    );
    expect(revoked.status).toBe(403);
    const old = await handleWorkerRequest(
      new Request(`${origin}/wh/cone.old-secret/event`, { method: 'POST', body: '{}' }),
      env
    );
    expect(old.ok).toBe(false);
    expect(await old.text()).not.toContain(result.webhook.url);
    const fresh = await handleWorkerRequest(
      new Request(`${result.webhook.url}/event`, { method: 'POST', body: '{}' }),
      env
    );
    expect(fresh.ok).toBe(true);
  });
});
