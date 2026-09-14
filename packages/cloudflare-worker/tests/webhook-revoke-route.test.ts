import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest, type WorkerEnv } from '../src/index.js';
import { WebhookHomeDurableObject } from '../src/webhook-home.js';
import { FakeDurableObjectState } from './fake-do-state.js';
import { makeEnv } from './helpers/fake-env.js';

const origin = 'https://hub.example';
const credentials = {
  rebindSecret: 'management-secret',
  trayId: 'tray',
  controllerToken: 'controller',
};
function request(body: unknown = credentials) {
  return new Request(`${origin}/webhooks/cone/event/revoke`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('public registration revocation', () => {
  it.each([null, {}, { ...credentials, rebindSecret: 1 }, { ...credentials, controllerToken: '' }])(
    'rejects missing/invalid authority before touching a home',
    async (body) => {
      const env = makeEnv();
      const get = vi.spyOn(env.WEBHOOK_HOMES, 'get');
      expect((await handleWorkerRequest(request(body), env)).status).toBe(400);
      expect(get).not.toHaveBeenCalled();
    }
  );

  it.each([403, 500])('sanitizes home errors (%s)', async (status) => {
    const env = makeEnv();
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue({
      fetch: async () => new Response('management-secret', { status }),
    } as never);
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(status === 403 ? 403 : 502);
    expect(await response.text()).not.toContain('management-secret');
  });

  it('bounds the body and rejects non-POST without mutation', async () => {
    const env = makeEnv();
    const get = vi.spyOn(env.WEBHOOK_HOMES, 'get');
    expect(
      (await handleWorkerRequest(request({ ...credentials, extra: 'x'.repeat(65536) }), env)).status
    ).toBe(400);
    expect(
      (await handleWorkerRequest(new Request(`${origin}/webhooks/cone/event/revoke`), env)).status
    ).toBe(405);
    expect(get).not.toHaveBeenCalled();
  });

  it('sanitizes lost responses', async () => {
    const env = makeEnv();
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockImplementation(() => {
      throw new Error('management-secret');
    });
    const response = await handleWorkerRequest(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('management-secret');
  });

  it('revokes through the real home, retries, and permanently rejects valid-secret delivery', async () => {
    const env = makeEnv({
      TRAY_HUB: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: async () => Response.json({ confirmed: true }) }),
      } as unknown as WorkerEnv['TRAY_HUB'],
    });
    const home = new WebhookHomeDurableObject(new FakeDurableObjectState(), env);
    vi.spyOn(env.WEBHOOK_HOMES, 'get').mockReturnValue(home as never);
    await home.fetch(
      new Request(`${origin}/internal/home/bind`, {
        method: 'POST',
        body: JSON.stringify({ ...credentials, coneId: 'cone', secret: 'delivery-secret' }),
      })
    );
    expect(
      (await handleWorkerRequest(request({ ...credentials, rebindSecret: 'delivery-secret' }), env))
        .status
    ).toBe(403);
    expect((await handleWorkerRequest(request(), env)).status).toBe(200);
    expect((await handleWorkerRequest(request(), env)).status).toBe(200);
    const delivered = await handleWorkerRequest(
      new Request(`${origin}/wh/cone.delivery-secret/event`, {
        method: 'POST',
        body: '{}',
      }),
      env
    );
    expect(delivered.status).toBe(410);
    expect(await delivered.json()).toMatchObject({ code: 'WEBHOOK_REVOKED' });
  });
});
