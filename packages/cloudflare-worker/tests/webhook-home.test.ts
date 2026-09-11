/**
 * WebhookHomeDurableObject — the stable cone-scoped webhook indirection (#2812).
 *
 * Drives the real DO over a fake storage and a fake TRAY_HUB whose stub answers
 * `confirm-controller` and `internal/webhook`, so bind auth, delivery
 * verification, the internal forward, the rebind two-factor gate, revocation,
 * and expiry are all exercised end to end without a workerd runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_HOME_TTL_MS,
  WebhookHomeDurableObject,
  type WebhookHomeEnv,
  type WebhookHomeStateLike,
  type WebhookHomeStorageLike,
} from '../src/webhook-home.js';

const HOST = 'https://www.sliccy.ai';

class FakeHomeStorage implements WebhookHomeStorageLike {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    // Structured-clone the value, like the real DO storage, so a test holding a
    // reference cannot mutate what was persisted.
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

interface TrayBehavior {
  /** controllerToken the tray will confirm. Any other token is refused. */
  controllerToken: string;
  /** Status the tray's internal webhook delivery answers with. */
  deliverStatus?: number;
  /** Body the tray's internal webhook delivery answers with. */
  deliverBody?: unknown;
}

/**
 * A fake TRAY_HUB whose stub answers the two internal routes the home calls.
 * `trays` maps trayId → behavior; an unknown trayId confirms nothing and 500s
 * a delivery, modeling a tray that does not exist.
 */
function makeEnv(trays: Record<string, TrayBehavior>): {
  env: WebhookHomeEnv;
  confirmCalls: Array<{ trayId: string; token: string }>;
  deliverCalls: Array<{ trayId: string; webhookId: string; headers: Headers; body: string }>;
} {
  const confirmCalls: Array<{ trayId: string; token: string }> = [];
  const deliverCalls: Array<{
    trayId: string;
    webhookId: string;
    headers: Headers;
    body: string;
  }> = [];
  const env: WebhookHomeEnv = {
    TRAY_HUB: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        const trayId = id.toString();
        const behavior = trays[trayId];
        return {
          fetch: async (input: Request | string | URL, init?: RequestInit) => {
            const req = input instanceof Request ? input : new Request(input, init);
            const url = new URL(req.url);
            if (url.pathname === '/internal/confirm-controller') {
              const { controllerToken } = (await req.json()) as { controllerToken?: string };
              confirmCalls.push({ trayId, token: controllerToken ?? '' });
              const confirmed = !!behavior && controllerToken === behavior.controllerToken;
              return new Response(JSON.stringify({ confirmed }), { status: 200 });
            }
            const deliverMatch = url.pathname.match(/^\/internal\/webhook\/([^/]+)$/);
            if (deliverMatch) {
              const body = await req.text();
              deliverCalls.push({
                trayId,
                webhookId: decodeURIComponent(deliverMatch[1]!),
                headers: new Headers(req.headers),
                body,
              });
              if (!behavior) return new Response('no tray', { status: 500 });
              return new Response(JSON.stringify(behavior.deliverBody ?? { ok: true }), {
                status: behavior.deliverStatus ?? 202,
              });
            }
            return new Response('unexpected', { status: 404 });
          },
        };
      },
    },
  };
  return { env, confirmCalls, deliverCalls };
}

function makeHome(
  env: WebhookHomeEnv,
  clock: { now: number }
): { home: WebhookHomeDurableObject; storage: FakeHomeStorage } {
  const storage = new FakeHomeStorage();
  const state: WebhookHomeStateLike = { storage };
  const home = new WebhookHomeDurableObject(state, env, { now: () => clock.now });
  return { home, storage };
}

function bindReq(body: unknown): Request {
  return new Request(`${HOST}/internal/home/bind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deliverReq(secret: string, webhookId: string, payload: unknown): Request {
  return new Request(`${HOST}/internal/home/deliver`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slicc-cone-secret': secret,
      'x-slicc-webhook-id': webhookId,
    },
    body: JSON.stringify(payload),
  });
}

describe('WebhookHome — bind', () => {
  it('claims the home on first bind after the tray confirms the controller', async () => {
    const { env, confirmCalls } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, { now: Date.now() });

    const res = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ coneId: 'cone-1', currentTrayId: 'tray-1' });
    expect(confirmCalls).toEqual([{ trayId: 'tray-1', token: 'ctrl-1' }]);
  });

  it('refuses first bind when the target tray does not confirm the controller', async () => {
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home, storage } = makeHome(env, { now: Date.now() });

    const res = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'WRONG',
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: 'CONTROLLER_UNCONFIRMED',
    });
    // Nothing persisted — the home was never claimed.
    expect(await storage.get('webhook-home')).toBeUndefined();
  });

  it('rebind requires BOTH the rebind secret AND the new tray confirming control', async () => {
    const { env } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1' },
      'tray-2': { controllerToken: 'ctrl-2' },
    });
    const { home } = makeHome(env, { now: Date.now() });
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );

    // Wrong rebind secret, even with a tray the caller controls: refused.
    const badSecret = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'WRONG',
        trayId: 'tray-2',
        controllerToken: 'ctrl-2',
      })
    );
    expect(badSecret.status).toBe(403);
    expect((await badSecret.json()) as { code?: string }).toMatchObject({ code: 'INVALID_REBIND' });

    // Right rebind secret but a tray the caller does NOT control: refused. A
    // leaked coneId + rebind secret alone cannot steer deliveries elsewhere.
    const badTray = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-2',
        controllerToken: 'WRONG',
      })
    );
    expect(badTray.status).toBe(403);
    expect((await badTray.json()) as { code?: string }).toMatchObject({
      code: 'CONTROLLER_UNCONFIRMED',
    });

    // Both factors present: rebind succeeds and repoints the home.
    const ok = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-2',
        controllerToken: 'ctrl-2',
      })
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as unknown).toEqual({ coneId: 'cone-1', currentTrayId: 'tray-2' });
  });
});

describe('WebhookHome — deliver', () => {
  async function boundHome(clock: { now: number }) {
    const made = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1', deliverStatus: 202, deliverBody: { ok: true } },
      'tray-2': { controllerToken: 'ctrl-2', deliverStatus: 202, deliverBody: { ok: true } },
    });
    const { home } = makeHome(made.env, clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    return { home, ...made };
  }

  it('verifies the secret and forwards to the current tray, relaying its answer', async () => {
    const clock = { now: Date.now() };
    const { home, deliverCalls } = await boundHome(clock);

    const res = await home.fetch(deliverReq('sec', 'wh-render', { event: 'done' }));
    expect(res.status).toBe(202);
    expect((await res.json()) as unknown).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');

    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]!.trayId).toBe('tray-1');
    expect(deliverCalls[0]!.webhookId).toBe('wh-render');
    // The sender's body reaches the tray verbatim…
    expect(JSON.parse(deliverCalls[0]!.body)).toEqual({ event: 'done' });
    // …and the reserved routing headers never do.
    expect(deliverCalls[0]!.headers.get('x-slicc-cone-secret')).toBeNull();
    expect(deliverCalls[0]!.headers.get('x-slicc-webhook-id')).toBeNull();
  });

  it('follows a rebind: the SAME delivery URL reaches the new tray', async () => {
    const clock = { now: Date.now() };
    const { home, deliverCalls } = await boundHome(clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-2',
        controllerToken: 'ctrl-2',
      })
    );

    const res = await home.fetch(deliverReq('sec', 'wh-render', { event: 'again' }));
    expect(res.status).toBe(202);
    expect(deliverCalls.at(-1)!.trayId).toBe('tray-2');
  });

  it('rejects a bad delivery secret with 403 and forwards nothing', async () => {
    const clock = { now: Date.now() };
    const { home, deliverCalls } = await boundHome(clock);

    const res = await home.fetch(deliverReq('WRONG', 'wh-render', { event: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({
      code: 'INVALID_WEBHOOK_CAPABILITY',
    });
    expect(deliverCalls).toHaveLength(0);
  });

  it('403s a delivery to a home that was never bound', async () => {
    const { env } = makeEnv({});
    const { home } = makeHome(env, { now: Date.now() });
    const res = await home.fetch(deliverReq('sec', 'wh', {}));
    expect(res.status).toBe(403);
  });

  it('relays the tray answer verbatim (a dropped delivery is not laundered to 202)', async () => {
    const clock = { now: Date.now() };
    const made = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 410,
        deliverBody: { code: 'NO_LIVE_LEADER' },
      },
    });
    const { home } = makeHome(made.env, clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    const res = await home.fetch(deliverReq('sec', 'wh', {}));
    expect(res.status).toBe(410);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'NO_LIVE_LEADER' });
  });
});

describe('WebhookHome — lifecycle', () => {
  it('revokes with the rebind secret, then answers a permanent 410 and never resurrects', async () => {
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, { now: Date.now() });
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );

    const revoke = await home.fetch(
      new Request(`${HOST}/internal/home/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rebindSecret: 'reb' }),
      })
    );
    expect(revoke.status).toBe(200);

    // Delivery is now a permanent 410.
    const delivered = await home.fetch(deliverReq('sec', 'wh', {}));
    expect(delivered.status).toBe(410);
    expect((await delivered.json()) as { code?: string }).toMatchObject({ code: 'HOME_REVOKED' });

    // A revoked home can never be re-bound — a tombstoned coneId is dead for good.
    const rebind = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    expect(rebind.status).toBe(410);
  });

  it('refuses revoke with a wrong rebind secret', async () => {
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, { now: Date.now() });
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    const res = await home.fetch(
      new Request(`${HOST}/internal/home/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rebindSecret: 'WRONG' }),
      })
    );
    expect(res.status).toBe(403);
  });

  it('expires after the TTL with no rebind, then delivery 410s HOME_EXPIRED', async () => {
    const clock = { now: Date.now() };
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );

    // Just inside the window: still delivers.
    clock.now += WEBHOOK_HOME_TTL_MS - 1000;
    expect((await home.fetch(deliverReq('sec', 'wh', {}))).status).toBe(202);

    // Past the window: expired.
    clock.now += 2000;
    const res = await home.fetch(deliverReq('sec', 'wh', {}));
    expect(res.status).toBe(410);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'HOME_EXPIRED' });
  });

  it('a rebind resets the expiry clock', async () => {
    const clock = { now: Date.now() };
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    clock.now += WEBHOOK_HOME_TTL_MS - 1000;
    // Rebind to the same tray (re-confirms control) resets lastReboundAt.
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    clock.now += WEBHOOK_HOME_TTL_MS - 1000;
    // Would have expired under the original clock; the rebind kept it alive.
    expect((await home.fetch(deliverReq('sec', 'wh', {}))).status).toBe(202);
  });
});
