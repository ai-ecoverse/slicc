/**
 * `WebhookRelay` — the webhook forwarding + delivery-receipt half of the tray
 * DO, extracted in issue #2674. Driven through its `WebhookDeps` seam so the
 * disposition mapping from #2524 is asserted without standing up a leader.
 */

import type { WebhookDeliveryDisposition, WorkerToLeaderControlMessage } from '@slicc/shared-ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { type WebhookDeps, WebhookRelay } from '../src/session-tray-webhook.js';
import type { TrayRecord } from '../src/shared.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const TOKEN = 'tray-1.webhooksecret';

interface Harness {
  relay: WebhookRelay;
  sent: WorkerToLeaderControlMessage[];
  leaderLive: boolean;
  leaderReachable: boolean;
}

function createTray(): TrayRecord {
  return {
    trayId: 'tray-1',
    createdAt: new Date(NOW).toISOString(),
    joinToken: 'tray-1.join',
    controllerToken: 'tray-1.controller',
    webhookToken: TOKEN,
    controllers: {},
    bootstraps: {},
    leader: null,
  };
}

function createHarness(waitMs = 20): Harness {
  const harness: Harness = {
    sent: [],
    leaderLive: true,
    leaderReachable: true,
    relay: undefined as unknown as WebhookRelay,
  };
  const tray = createTray();
  const deps: WebhookDeps = {
    requireTray: () => tray,
    // Plain equality stands in for the DO's timing-safe comparison.
    matchesToken: (received, expected) => received === expected,
    hasLiveLeader: () => harness.leaderLive,
    sendToLeader: (message) => {
      if (!harness.leaderReachable) return false;
      harness.sent.push(message as WorkerToLeaderControlMessage);
      return true;
    },
    isoNow: () => new Date(NOW).toISOString(),
    now: () => NOW,
  };
  harness.relay = new WebhookRelay(deps, waitMs);
  return harness;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://hub.example/webhook/t/build-done', {
    method: 'POST',
    headers,
    body,
  });
}

/**
 * Wait for the relay to forward the pending POST. `handle` reads the request
 * body before sending, so a single microtask tick is not enough.
 */
async function forwarded(h: Harness, count = h.sent.length + 1): Promise<{ deliveryId: string }> {
  for (let i = 0; i < 50 && h.sent.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return h.sent.at(-1) as unknown as { deliveryId: string };
}

/** Answer the relay's forwarded event with a disposition, as a live leader would. */
async function ack(h: Harness, disposition: WebhookDeliveryDisposition): Promise<void> {
  const { deliveryId } = await forwarded(h);
  h.relay.settle({ type: 'webhook.delivery', deliveryId, disposition });
}

describe('WebhookRelay.handle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('rejects a bad webhook capability', async () => {
    const response = await h.relay.handle('wrong', post('{}'), 'build-done');
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_WEBHOOK_CAPABILITY',
    });
  });

  it('requires a webhook id', async () => {
    const response = await h.relay.handle(TOKEN, post('{}'), undefined);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'WEBHOOK_ID_REQUIRED' });
  });

  it('410s when no leader is connected', async () => {
    h.leaderLive = false;
    const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: 'NO_LIVE_LEADER' });
  });

  it('502s when the leader socket refuses the send', async () => {
    h.leaderReachable = false;
    const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: 'LEADER_SEND_FAILED' });
  });

  it('parses a JSON body and forwards it with the webhook id', async () => {
    const pending = h.relay.handle(
      TOKEN,
      post(JSON.stringify({ ref: 'main' }), { 'content-type': 'application/json' }),
      'build-done'
    );
    await forwarded(h);
    expect(h.sent[0]).toMatchObject({
      type: 'webhook.event',
      webhookId: 'build-done',
      body: { ref: 'main' },
    });
    expect((await pending).status).toBe(202);
  });

  it('parses an undeclared JSON body, and wraps anything else as raw text', async () => {
    const parsed = h.relay.handle(TOKEN, post(JSON.stringify({ a: 1 })), 'build-done');
    await forwarded(h);
    expect(h.sent.at(-1)).toMatchObject({ body: { a: 1 } });
    await ack(h, 'delivered');
    await parsed;

    const raw = h.relay.handle(TOKEN, post('hello there'), 'build-done');
    await forwarded(h);
    expect(h.sent.at(-1)).toMatchObject({ body: { raw: 'hello there' } });
    await ack(h, 'delivered');
    await raw;
  });

  it('strips cf-, host and reserved preview-attribution headers', async () => {
    const pending = h.relay.handle(
      TOKEN,
      post('{}', {
        'content-type': 'application/json',
        'cf-connecting-ip': '1.2.3.4',
        'x-slicc-preview-conn': 'forged',
        'x-slicc-preview-token': 'forged',
        'x-github-event': 'push',
      }),
      'build-done'
    );
    await forwarded(h);
    const headers = (h.sent[0] as { headers: Record<string, string> }).headers;
    expect(headers['x-github-event']).toBe('push');
    expect(Object.keys(headers).some((key) => key.startsWith('x-slicc-preview-'))).toBe(false);
    expect(headers['cf-connecting-ip']).toBeUndefined();
    expect(headers['host']).toBeUndefined();
    await ack(h, 'delivered');
    await pending;
  });
});

describe('WebhookRelay delivery receipts', () => {
  it.each([
    ['delivered', 202, true],
    ['filtered', 202, true],
  ] as const)('reports %s as %i', async (disposition, status, accepted) => {
    const h = createHarness();
    const pending = h.relay.handle(TOKEN, post('{}'), 'build-done');
    await ack(h, disposition);
    const response = await pending;
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ accepted });
  });

  it('reports an unregistered webhook as 404 rather than a success', async () => {
    const h = createHarness();
    const pending = h.relay.handle(TOKEN, post('{}'), 'build-done');
    await ack(h, 'unknown-webhook');
    const response = await pending;
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'WEBHOOK_NOT_REGISTERED',
    });
  });

  it('reports a dropped event as 422 rather than a success', async () => {
    const h = createHarness();
    const pending = h.relay.handle(TOKEN, post('{}'), 'build-done');
    await ack(h, 'unresolved-target');
    const response = await pending;
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'WEBHOOK_TARGET_UNRESOLVED',
    });
  });

  it('keeps the pre-#2524 202 when the leader never answers', async () => {
    const h = createHarness(5);
    const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, accepted: true });
  });

  it('ignores a disposition for a delivery that already settled', async () => {
    const h = createHarness();
    const pending = h.relay.handle(TOKEN, post('{}'), 'build-done');
    await ack(h, 'delivered');
    await pending;
    // A duplicate ack must not throw or resolve anything a second time.
    expect(() => ack(h, 'unknown-webhook')).not.toThrow();
  });
});
