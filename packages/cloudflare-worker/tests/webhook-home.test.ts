/**
 * WebhookHomeDurableObject — the stable cone-scoped webhook indirection (#2812).
 *
 * Drives the real DO over a fake storage and a fake TRAY_HUB whose stub answers
 * `confirm-controller` and `internal/webhook`, so bind auth, delivery
 * verification, the internal forward, the rebind two-factor gate, revocation,
 * and expiry are all exercised end to end without a workerd runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  WEBHOOK_DEAD_LETTER_MAX,
  WEBHOOK_HOME_TTL_MS,
  WEBHOOK_QUEUE_MAX,
  WEBHOOK_QUEUE_RETRY_MS,
  WEBHOOK_QUEUE_TTL_MS,
  type WebhookDeadLetter,
  WebhookHomeDurableObject,
  type WebhookHomeEnv,
  type WebhookHomeRecord,
  type WebhookHomeStateLike,
  type WebhookHomeStorageLike,
} from '../src/webhook-home.js';

const HOST = 'https://www.sliccy.ai';

class FakeHomeStorage implements WebhookHomeStorageLike {
  private readonly data = new Map<string, unknown>();
  alarmAt = 0;
  async setAlarm(time: number): Promise<void> {
    this.alarmAt = time;
  }
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(
    key: string | Record<string, WebhookHomeRecord | WebhookDeadLetter>,
    value?: T
  ): Promise<void> {
    // Structured-clone the value, like the real DO storage, so a test holding a
    // reference cannot mutate what was persisted.
    if (typeof key !== 'string') {
      for (const [entryKey, entry] of Object.entries(structuredClone(key))) {
        this.data.set(entryKey, entry);
      }
      return;
    }
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

interface TrayBehavior {
  /** controllerToken the tray will confirm. Any other token is refused. */
  controllerToken: string;
  active?: boolean;
  /** Status the tray's internal webhook delivery answers with. */
  deliverStatus?: number;
  /** Body the tray's internal webhook delivery answers with. */
  deliverBody?: unknown;
  ack?: string | null;
  failure?: 'throw' | 'hang';
  responseFor?: (webhookId: string) => Response;
}

/**
 * A fake TRAY_HUB whose stub answers the two internal routes the home calls.
 * `trays` maps trayId → behavior; an unknown trayId confirms nothing and 500s
 * a delivery, modeling a tray that does not exist.
 */
function makeEnv(trays: Record<string, TrayBehavior>): {
  env: WebhookHomeEnv;
  trays: Record<string, TrayBehavior>;
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
            if (
              url.pathname === '/internal/confirm-controller' ||
              url.pathname === '/internal/confirm-controller-ownership'
            ) {
              const { controllerToken } = (await req.json()) as { controllerToken?: string };
              confirmCalls.push({ trayId, token: controllerToken ?? '' });
              const confirmed =
                !!behavior &&
                controllerToken === behavior.controllerToken &&
                (url.pathname === '/internal/confirm-controller-ownership' ||
                  behavior.active !== false);
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
              if (behavior.failure === 'throw') throw new Error('transport failure');
              if (behavior.failure === 'hang') return new Promise<Response>(() => {});
              if (behavior.responseFor)
                return behavior.responseFor(decodeURIComponent(deliverMatch[1]!));
              return new Response(JSON.stringify(behavior.deliverBody ?? { ok: true }), {
                status: behavior.deliverStatus ?? 202,
                headers:
                  behavior.ack === null
                    ? {}
                    : { 'x-slicc-webhook-ack': behavior.ack ?? 'delivered' },
              });
            }
            return new Response('unexpected', { status: 404 });
          },
        };
      },
    },
  };
  return { env, trays, confirmCalls, deliverCalls };
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
    expect((await res.json()) as unknown).toEqual({
      coneId: 'cone-1',
      currentTrayId: 'tray-1',
      queued: 0,
    });
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
    expect((await ok.json()) as unknown).toEqual({
      coneId: 'cone-1',
      currentTrayId: 'tray-2',
      queued: 0,
    });
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
    expect((await res.json()) as unknown).toEqual({ ok: true, accepted: true, queued: false });
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

  it('retains a refused delivery durably until registration is repaired', async () => {
    const clock = { now: Date.now() };
    const made = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 404,
        deliverBody: { code: 'WEBHOOK_NOT_REGISTERED' },
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
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, queued: true });
  });
});

describe('WebhookHome — queue on no live leader (#2812)', () => {
  /** Bind a home to a tray whose leader is currently DOWN (410 NO_LIVE_LEADER). */
  async function homeWithLeaderlessTray(clock: { now: number }) {
    const made = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 410,
        deliverBody: { code: 'NO_LIVE_LEADER' },
      },
    });
    const { home, storage } = makeHome(made.env, clock);
    await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-1',
        controllerToken: 'ctrl-1',
      })
    );
    return { home, storage, ...made };
  }

  it('queues a delivery instead of losing it, answering 202 queued', async () => {
    const clock = { now: Date.now() };
    const { home } = await homeWithLeaderlessTray(clock);

    const res = await home.fetch(deliverReq('sec', 'wh-render', { event: 'held' }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued?: boolean; code?: string };
    expect(body.queued).toBe(true);
  });

  it('replays queued deliveries in order when the leader returns (via a later delivery)', async () => {
    const clock = { now: Date.now() };
    const { home, trays, deliverCalls } = await homeWithLeaderlessTray(clock);

    // Two deliveries arrive while the leader is down — both queued.
    await home.fetch(deliverReq('sec', 'wh-1', { n: 1 }));
    await home.fetch(deliverReq('sec', 'wh-2', { n: 2 }));

    // Leader reconnects: the tray now accepts deliveries.
    trays['tray-1']!.deliverStatus = 202;
    trays['tray-1']!.deliverBody = { ok: true };

    // Fresh arrivals never jump ahead of accepted deliveries.
    const res = await home.fetch(deliverReq('sec', 'wh-3', { n: 3 }));
    expect(res.status).toBe(202);
    await home.alarm();
    await home.alarm();

    // All three reached the tray; the two queued ones replayed in FIFO order.
    const ids = deliverCalls.map((c) => c.webhookId);
    expect(ids).toEqual(['wh-1', 'wh-1', 'wh-1', 'wh-2', 'wh-3']);
  });

  it('drains the queue on a rebind (the fresh tray has a live leader)', async () => {
    const clock = { now: Date.now() };
    const made = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 410,
        deliverBody: { code: 'NO_LIVE_LEADER' },
      },
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
    await home.fetch(deliverReq('sec', 'wh-queued', { held: true }));

    // Rebind to a fresh, live tray — the queue drains to it immediately.
    const rebind = await home.fetch(
      bindReq({
        coneId: 'cone-1',
        secret: 'sec',
        rebindSecret: 'reb',
        trayId: 'tray-2',
        controllerToken: 'ctrl-2',
      })
    );
    expect(rebind.status).toBe(200);

    const drained = made.deliverCalls.filter((c) => c.trayId === 'tray-2');
    expect(drained.map((c) => c.webhookId)).toEqual(['wh-queued']);
    expect(JSON.parse(drained[0]!.body)).toEqual({ held: true });
  });

  it('bounds the queue with backpressure, never dropping an accepted delivery', async () => {
    const clock = { now: Date.now() };
    const { home, storage } = await homeWithLeaderlessTray(clock);

    for (let i = 0; i < WEBHOOK_QUEUE_MAX + 5; i++) {
      const res = await home.fetch(deliverReq('sec', `wh-${i}`, { n: i }));
      expect(res.status).toBe(i < WEBHOOK_QUEUE_MAX ? 202 : 429);
    }
    const record = (await storage.get('webhook-home')) as {
      queue?: unknown[];
      droppedCount?: number;
    };
    expect(record.queue).toHaveLength(WEBHOOK_QUEUE_MAX);
    expect(record.droppedCount).toBeUndefined();
    expect(record.queue?.[0]).toMatchObject({ webhookId: 'wh-0' });
  });

  it('never ages out an accepted delivery', async () => {
    const clock = { now: Date.now() };
    const { home, trays, deliverCalls } = await homeWithLeaderlessTray(clock);
    await home.fetch(deliverReq('sec', 'wh-stale', { old: true }));

    // Age past the TTL, then bring the leader back and deliver something fresh.
    clock.now += WEBHOOK_QUEUE_TTL_MS + 1000;
    trays['tray-1']!.deliverStatus = 202;
    trays['tray-1']!.deliverBody = { ok: true };
    await home.fetch(deliverReq('sec', 'wh-fresh', { fresh: true }));
    await home.alarm();

    const delivered = deliverCalls.filter((c) => c.webhookId === 'wh-stale');
    expect(delivered).toHaveLength(2);
    expect(deliverCalls.some((c) => c.webhookId === 'wh-fresh')).toBe(true);
  });
});

describe('WebhookHome — lifecycle', () => {
  const identity = {
    coneId: 'cone-1',
    secret: 'sec',
    rebindSecret: 'reb',
    trayId: 'tray-1',
    controllerToken: 'ctrl-1',
  };

  it.each([
    [404, 'WEBHOOK_NOT_REGISTERED'],
    [422, 'WEBHOOK_TARGET_UNRESOLVED'],
  ])(
    'dead-letters repeated explicit %s failures and unblocks legitimate work after restart',
    async (status, code) => {
      const clock = { now: Date.now() };
      const { env, trays, deliverCalls } = makeEnv({
        'tray-1': {
          controllerToken: 'ctrl-1',
          deliverStatus: status as number,
          deliverBody: { accepted: false, code },
          ack: null,
        },
      });
      const { home, storage } = makeHome(env, clock);
      await home.fetch(bindReq(identity));
      await home.fetch(deliverReq('sec', 'typo', { preserved: true }));
      // Arrivals and repeated alarms cannot spend the grace period early.
      await home.alarm();
      expect(deliverCalls).toHaveLength(1);
      clock.now += WEBHOOK_QUEUE_RETRY_MS;
      await home.alarm();
      const restarted = new WebhookHomeDurableObject({ storage }, env, { now: () => clock.now });
      clock.now += WEBHOOK_QUEUE_RETRY_MS;
      await restarted.alarm();
      expect(await storage.get('webhook-dead-letter:0')).toMatchObject({
        sequence: 1,
        outcome: 'rejected',
        reason: code,
        attempts: 3,
        delivery: { webhookId: 'typo', bodyB64: btoa('{"preserved":true}') },
      });
      trays['tray-1']!.deliverStatus = 202;
      trays['tray-1']!.ack = 'delivered';
      await restarted.fetch(deliverReq('sec', 'legitimate', {}));
      expect(deliverCalls.at(-1)!.webhookId).toBe('legitimate');
      expect(await storage.get('webhook-home')).toMatchObject({ deadLetterCount: 1 });
      expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
    }
  );

  it('bypasses a typo during backoff while preserving same-ID order across restart', async () => {
    const clock = { now: Date.now() };
    let repaired = false;
    const { env, deliverCalls } = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        responseFor: (id) =>
          id === 'typo' && !repaired
            ? new Response(JSON.stringify({ accepted: false, code: 'WEBHOOK_NOT_REGISTERED' }), {
                status: 404,
              })
            : new Response(null, { status: 202, headers: { 'x-slicc-webhook-ack': 'delivered' } }),
      },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'typo', { n: 1 }));
    await home.fetch(deliverReq('sec', 'typo', { n: 2 }));
    await home.fetch(deliverReq('sec', 'legitimate', {}));
    expect(deliverCalls.map((call) => call.webhookId)).toEqual(['typo', 'legitimate']);
    const restarted = new WebhookHomeDurableObject({ storage }, env, { now: () => clock.now });
    await restarted.alarm();
    expect(deliverCalls).toHaveLength(2);
    repaired = true;
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    await restarted.alarm();
    await restarted.alarm();
    expect(
      deliverCalls.filter((call) => call.webhookId === 'typo').map((call) => call.body)
    ).toEqual(['{"n":1}', '{"n":1}', '{"n":2}']);
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
  });

  it('delivers an unknown registration repaired during the retry grace period', async () => {
    const clock = { now: Date.now() };
    const { env, trays } = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 404,
        deliverBody: { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' },
        ack: null,
      },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'soon-registered', {}));
    trays['tray-1']!.deliverStatus = 202;
    trays['tray-1']!.ack = 'delivered';
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    await home.alarm();
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
    expect(await storage.get('webhook-dead-letter:0')).toBeUndefined();
  });

  it.each([
    [404, { accepted: false, code: 'OTHER_ERROR' }],
    [404, { code: 'WEBHOOK_NOT_REGISTERED' }],
    [422, { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' }],
    [503, { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' }],
    [202, { accepted: true }],
    [404, 'not an object'],
  ])('retains ambiguous %s responses without spending a terminal budget', async (status, body) => {
    const clock = { now: Date.now() };
    const { env } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1', deliverStatus: status, deliverBody: body, ack: null },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'keep', {}));
    for (let i = 0; i < 5; i++) {
      clock.now += WEBHOOK_QUEUE_RETRY_MS;
      await home.alarm();
    }
    expect(await storage.get('webhook-home')).toHaveProperty('queue');
    expect(await storage.get('webhook-home')).not.toHaveProperty('deadLetterCount');
  });

  it('atomically retains work when dead-letter persistence fails, and revocation still wins', async () => {
    const clock = { now: Date.now() };
    const { env, deliverCalls } = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 404,
        deliverBody: { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' },
        ack: null,
      },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'typo', {}));
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    await home.alarm();
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('atomic put failed'));
    await expect(home.alarm()).rejects.toThrow('atomic put failed');
    expect(await storage.get('webhook-dead-letter:0')).toBeUndefined();
    expect(await storage.get('webhook-home')).toHaveProperty('queue');
    const restarted = new WebhookHomeDurableObject({ storage }, env, { now: () => clock.now });
    expect((await restarted.fetch(deliverReq('wrong', 'typo', {}))).status).toBe(403);
    const revoke = (rebindSecret: string) =>
      new Request(`${HOST}/internal/home/revoke-registration`, {
        method: 'POST',
        body: JSON.stringify({ ...identity, webhookId: 'typo', rebindSecret }),
      });
    expect((await restarted.fetch(revoke('wrong'))).status).toBe(403);
    expect((await restarted.fetch(revoke('reb'))).status).toBe(200);
    const calls = deliverCalls.length;
    await restarted.alarm();
    expect(deliverCalls).toHaveLength(calls);
    expect((await restarted.fetch(deliverReq('sec', 'typo', {}))).status).toBe(410);
    expect(await storage.get('webhook-dead-letter:0')).toBeUndefined();
  });

  it('resets the rejection streak on an ambiguous transport outcome', async () => {
    const clock = { now: Date.now() };
    const { env, trays } = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 404,
        deliverBody: { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' },
        ack: null,
      },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'keep', {}));
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    await home.alarm();
    trays['tray-1']!.failure = 'throw';
    clock.now += WEBHOOK_QUEUE_RETRY_MS;
    await home.alarm();
    expect((await storage.get<WebhookHomeRecord>('webhook-home'))!.queue![0]).not.toHaveProperty(
      'rejection'
    );
    trays['tray-1']!.failure = undefined;
    await home.alarm();
    expect((await storage.get<WebhookHomeRecord>('webhook-home'))!.queue![0]).toMatchObject({
      rejection: { attempts: 1 },
    });
    expect(await storage.get('webhook-dead-letter:0')).toBeUndefined();
  });

  it('recovers full queue capacity and bounds terminal storage independently of pending work', async () => {
    const clock = { now: Date.now() };
    const { env, trays } = makeEnv({
      'tray-1': {
        controllerToken: 'ctrl-1',
        deliverStatus: 404,
        deliverBody: { accepted: false, code: 'WEBHOOK_NOT_REGISTERED' },
        ack: null,
      },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    for (let i = 0; i < WEBHOOK_QUEUE_MAX; i++) {
      expect((await home.fetch(deliverReq('sec', `typo-${i}`, {}))).status).toBe(202);
    }
    expect((await home.fetch(deliverReq('sec', 'legitimate', {}))).status).toBe(429);
    for (let i = 0; i < WEBHOOK_QUEUE_MAX * 3; i++) {
      clock.now += WEBHOOK_QUEUE_RETRY_MS;
      await home.alarm();
    }
    // One more terminal outcome wraps the bounded archive, without blocking admission.
    await home.fetch(deliverReq('sec', 'last-typo', {}));
    for (let i = 0; i < 2; i++) {
      clock.now += WEBHOOK_QUEUE_RETRY_MS;
      await home.alarm();
    }
    expect(await storage.get('webhook-dead-letter:0')).toMatchObject({
      sequence: WEBHOOK_DEAD_LETTER_MAX + 1,
      delivery: { webhookId: 'last-typo' },
    });
    expect(await storage.get(`webhook-dead-letter:${WEBHOOK_DEAD_LETTER_MAX}`)).toBeUndefined();
    trays['tray-1']!.deliverStatus = 202;
    trays['tray-1']!.ack = 'delivered';
    expect((await home.fetch(deliverReq('sec', 'legitimate', {}))).status).toBe(202);
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
  });

  it('persists per-registration revocation before removing queued deliveries and never replays them', async () => {
    const { env, trays, deliverCalls } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1', ack: null },
    });
    const clock = { now: Date.now() };
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'deleted', {}));
    await home.fetch(deliverReq('sec', 'keep', {}));
    const revoke = (overrides = {}) =>
      home.fetch(
        new Request(`${HOST}/internal/home/revoke-registration`, {
          method: 'POST',
          body: JSON.stringify({ ...identity, webhookId: 'deleted', ...overrides }),
        })
      );
    for (const overrides of [
      { rebindSecret: 'bad' },
      { controllerToken: 'bad' },
      { trayId: 'other' },
    ]) {
      expect((await revoke(overrides)).status).toBe(403);
    }
    // Simulate a crash after tombstone persistence but before queue cleanup.
    const put = storage.put.bind(storage);
    vi.spyOn(storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'webhook-home') throw new Error('queue write failed');
      return put(key, value);
    });
    await expect(revoke()).rejects.toThrow('queue write failed');
    vi.mocked(storage.put).mockRestore();
    const restarted = new WebhookHomeDurableObject({ storage }, env, { now: () => clock.now });
    trays['tray-1']!.ack = 'delivered';
    deliverCalls.length = 0;
    await Promise.all([restarted.alarm(), restarted.alarm()]);
    expect(deliverCalls.map((call) => call.webhookId)).toEqual(['keep']);
    expect((await restarted.fetch(deliverReq('bad', 'deleted', {}))).status).toBe(403);
    expect((await restarted.fetch(deliverReq('sec', 'deleted', {}))).status).toBe(410);
    expect((await revoke()).status).toBe(200);
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
  });

  it('replays accepted events after home expiry, but never after whole-home revocation', async () => {
    const clock = { now: Date.now() };
    const { env, trays, deliverCalls } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1', ack: null },
    });
    const { home } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'before-expiry', {}));
    await home.fetch(deliverReq('sec', 'never-replay', {}));
    clock.now += WEBHOOK_HOME_TTL_MS + 1;
    trays['tray-1']!.ack = 'delivered';
    deliverCalls.length = 0;
    await home.alarm();
    expect(deliverCalls.map((call) => call.webhookId)).toEqual(['before-expiry']);
    await home.fetch(
      new Request(`${HOST}/internal/home/revoke`, {
        method: 'POST',
        body: JSON.stringify({ rebindSecret: 'reb' }),
      })
    );
    await home.alarm();
    expect(deliverCalls).toHaveLength(1);
  });

  it('fails closed if scheduling replay fails before acceptance', async () => {
    const { env, deliverCalls } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home, storage } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    vi.spyOn(storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm unavailable'));
    await expect(home.fetch(deliverReq('sec', 'wh', {}))).rejects.toThrow('alarm unavailable');
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
    expect(deliverCalls).toHaveLength(0);
  });

  it('replays exact binary bytes and signature headers after storage reconstruction', async () => {
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1', ack: null } });
    const { home, storage } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    const bytes = new Uint8Array([0, 255, 128, 1, 239, 187, 191]);
    await home.fetch(
      new Request(`${HOST}/internal/home/deliver`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-signature': 'signature-over-original-bytes',
          'x-slicc-cone-secret': 'sec',
          'x-slicc-webhook-id': 'binary',
        },
        body: bytes,
      })
    );
    const replay = vi.fn(async (input: Request | string | URL) => {
      const request = input as Request;
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      expect(request.headers.get('content-type')).toBe('application/octet-stream');
      expect(request.headers.get('x-signature')).toBe('signature-over-original-bytes');
      expect(request.headers.has('x-slicc-cone-secret')).toBe(false);
      return new Response(null, { status: 202, headers: { 'x-slicc-webhook-ack': 'delivered' } });
    });
    vi.spyOn(env.TRAY_HUB, 'get').mockReturnValue({ fetch: replay });
    await new WebhookHomeDurableObject({ storage }, env).alarm();
    expect(replay).toHaveBeenCalledOnce();
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
  });

  it('rotates atomically and retries without changing identity or queued work', async () => {
    const { env, trays } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1', ack: null } });
    const { home, storage } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'wh', {}));
    const before = await storage.get('webhook-home');
    const rotate = (overrides = {}) =>
      home.fetch(
        new Request(`${HOST}/internal/home/rotate`, {
          method: 'POST',
          body: JSON.stringify({ ...identity, oldSecret: 'sec', secret: 'new', ...overrides }),
        })
      );
    for (const overrides of [
      { rebindSecret: 'bad' },
      { controllerToken: 'bad' },
      { trayId: 'other' },
      { oldSecret: 'bad' },
    ]) {
      expect((await rotate(overrides)).status).toBe(403);
      expect(await storage.get('webhook-home')).toEqual(before);
    }
    expect((await rotate()).status).toBe(200);
    const rotated = await storage.get('webhook-home');
    expect((await rotate()).status).toBe(200);
    expect(await storage.get('webhook-home')).toEqual(rotated);
    expect((await home.fetch(deliverReq('sec', 'wh', {}))).status).toBe(403);
    expect((await home.fetch(bindReq(identity))).status).toBe(403);
    trays['tray-1']!.ack = 'delivered';
    await home.alarm();
    expect((await home.fetch(deliverReq('new', 'wh', {}))).status).toBe(202);
  });

  it('finishes uncommitted rotation on an expired source but cannot bind to that expired target', async () => {
    const { env, trays } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1' },
    });
    const { home } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    trays['tray-1']!.active = false;
    expect(
      (
        await home.fetch(
          new Request(`${HOST}/internal/home/rotate`, {
            method: 'POST',
            body: JSON.stringify({ ...identity, oldSecret: 'sec', secret: 'new' }),
          })
        )
      ).status
    ).toBe(200);
    expect((await home.fetch(bindReq({ ...identity, secret: 'new' }))).status).toBe(403);
  });

  it('recovers an exact committed receipt after rebind without consulting the expired source, but refuses stale mutations', async () => {
    const { env, trays } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1' },
      'tray-2': { controllerToken: 'ctrl-2' },
    });
    const { home, storage } = makeHome(env, { now: Date.now() });
    const rotate = (overrides = {}) =>
      new Request(`${HOST}/internal/home/rotate`, {
        method: 'POST',
        body: JSON.stringify({ ...identity, oldSecret: 'sec', secret: 'new', ...overrides }),
      });
    await home.fetch(bindReq(identity));
    expect((await home.fetch(rotate())).status).toBe(200);
    expect(
      (
        await home.fetch(
          bindReq({
            ...identity,
            secret: 'new',
            trayId: 'tray-2',
            controllerToken: 'ctrl-2',
          })
        )
      ).status
    ).toBe(200);
    trays['tray-1']!.active = false;
    const before = await storage.get('webhook-home');
    const lookup = vi.spyOn(env.TRAY_HUB, 'get').mockImplementation(() => {
      throw new Error('old source unavailable');
    });
    const restarted = new WebhookHomeDurableObject({ storage }, env);
    expect((await restarted.fetch(rotate())).status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    for (const overrides of [
      { oldSecret: 'wrong' },
      { controllerToken: 'wrong' },
      { rebindSecret: 'wrong' },
      { oldSecret: 'new', secret: 'third' },
    ]) {
      expect((await restarted.fetch(rotate(overrides))).status).toBe(403);
    }
    expect(await storage.get('webhook-home')).toEqual(before);
  });

  it('does not disclose revoked or expired state to an invalid secret', async () => {
    const clock = { now: Date.now() };
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    clock.now += WEBHOOK_HOME_TTL_MS + 1;
    expect((await home.fetch(deliverReq('bad', 'wh', {}))).status).toBe(403);
    await home.fetch(
      new Request(`${HOST}/internal/home/revoke`, {
        method: 'POST',
        body: JSON.stringify({ rebindSecret: 'reb' }),
      })
    );
    expect((await home.fetch(deliverReq('bad', 'wh', {}))).status).toBe(403);
    expect((await home.fetch(bindReq({ ...identity, rebindSecret: 'bad' }))).status).toBe(403);
  });

  it('replays from independent storage after restart, including legacy 202 and transport failures', async () => {
    const clock = { now: Date.now() };
    const { env, trays, deliverCalls } = makeEnv({
      'tray-1': { controllerToken: 'ctrl-1', ack: null },
    });
    const { home, storage } = makeHome(env, clock);
    await home.fetch(bindReq(identity));
    await home.fetch(deliverReq('sec', 'one', { n: 1 }));
    await home.fetch(deliverReq('sec', 'two', { n: 2 }));
    expect(storage.alarmAt).toBeGreaterThan(clock.now);
    const restarted = new WebhookHomeDurableObject({ storage }, env, { now: () => clock.now });
    trays['tray-1']!.failure = 'throw';
    await restarted.alarm();
    trays['tray-1']!.failure = undefined;
    trays['tray-1']!.ack = 'filtered';
    deliverCalls.length = 0;
    await Promise.all([restarted.alarm(), restarted.alarm()]);
    expect(deliverCalls.map((c) => c.webhookId)).toEqual(['one', 'two']);
    expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
  });

  it('does not accept a failed persistence write or retain its phantom mutation', async () => {
    const { env, deliverCalls } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1' } });
    const { home, storage } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(home.fetch(deliverReq('sec', 'lost', {}))).rejects.toThrow('storage unavailable');
    await home.alarm();
    expect(deliverCalls).toHaveLength(0);
  });

  it('bounds a hung forward and retries without treating a legacy receipt as acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const { env, trays, deliverCalls } = makeEnv({
        'tray-1': { controllerToken: 'ctrl-1', failure: 'hang' },
      });
      const { home, storage } = makeHome(env, { now: Date.now() });
      await home.fetch(bindReq(identity));
      const accepted = home.fetch(deliverReq('sec', 'wh', {}));
      // WebCrypto runs outside fake timers: wait until the forward has begun.
      await vi.waitFor(() => expect(deliverCalls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await accepted).status).toBe(202);
      trays['tray-1']!.failure = undefined;
      trays['tray-1']!.ack = null;
      await home.alarm();
      expect(await storage.get('webhook-home')).toHaveProperty('queue');
      trays['tray-1']!.ack = 'delivered';
      await home.alarm();
      expect(await storage.get('webhook-home')).not.toHaveProperty('queue');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds raw bodies and encoded queue bytes with backpressure', async () => {
    const { env } = makeEnv({ 'tray-1': { controllerToken: 'ctrl-1', ack: null } });
    const { home, storage } = makeHome(env, { now: Date.now() });
    await home.fetch(bindReq(identity));
    expect((await home.fetch(deliverReq('sec', 'huge', 'x'.repeat(65_536)))).status).toBe(413);
    expect((await home.fetch(deliverReq('sec', 'first', 'x'.repeat(60_000)))).status).toBe(202);
    expect((await home.fetch(deliverReq('sec', 'second', 'x'.repeat(60_000)))).status).toBe(429);
    expect((await storage.get<{ queue: unknown[] }>('webhook-home'))!.queue).toHaveLength(1);
  });

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
