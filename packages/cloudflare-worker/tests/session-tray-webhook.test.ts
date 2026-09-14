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

  tray: TrayRecord;

  expiredResponse: Response | null;
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
    tray: createTray(),
    expiredResponse: null,
  };
  const tray = harness.tray;
  const deps: WebhookDeps = {
    requireTray: () => tray,
    ensureTrayIsActive: () => Promise.resolve(harness.expiredResponse),

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

async function forwarded(h: Harness, count = h.sent.length + 1): Promise<{ deliveryId: string }> {
  for (let i = 0; i < 50 && h.sent.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return h.sent.at(-1) as unknown as { deliveryId: string };
}

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

  describe('superseded tray (#1957)', () => {
    const replacement = 'https://hub.example/webhook/fresh-tray.deadbeef';

    it('redirects the delivery to the replacement webhook URL with a 308', async () => {
      h.tray.supersededByWebhookUrl = replacement;
      const response = await h.relay.handle(TOKEN, post('{"ref":"v2"}'), 'build-done');

      expect(response.status).toBe(308);
      expect(response.headers.get('Location')).toBe(`${replacement}/build-done`);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      await expect(response.json()).resolves.toMatchObject({
        code: 'TRAY_SUPERSEDED',
        webhookUrl: `${replacement}/build-done`,
      });

      expect(h.sent).toEqual([]);
    });

    it('carries the delivery query string onto the redirect', async () => {
      h.tray.supersededByWebhookUrl = replacement;
      const request = new Request('https://hub.example/webhook/t/build-done?attempt=2', {
        method: 'POST',
        body: '{}',
      });
      const response = await h.relay.handle(TOKEN, request, 'build-done');
      expect(response.headers.get('Location')).toBe(`${replacement}/build-done?attempt=2`);
    });

    it('redirects even when the delivery carries ?redirect=manual', async () => {
      h.tray.supersededByWebhookUrl = replacement;
      const request = new Request('https://hub.example/webhook/t/build-done?redirect=manual', {
        method: 'POST',
        body: '{}',
      });
      const response = await h.relay.handle(TOKEN, request, 'build-done');
      expect(response.status).toBe(308);
      expect(response.headers.get('Location')).toBe(`${replacement}/build-done?redirect=manual`);
    });

    it('redirects even once the tray has expired', async () => {
      h.tray.supersededByWebhookUrl = replacement;
      h.leaderLive = false;
      h.expiredResponse = new Response('{"code":"TRAY_EXPIRED"}', { status: 410 });
      const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
      expect(response.status).toBe(308);
    });

    it('never redirects on a bad webhook capability', async () => {
      h.tray.supersededByWebhookUrl = replacement;
      const response = await h.relay.handle('wrong', post('{}'), 'build-done');
      expect(response.status).toBe(403);
      expect(response.headers.get('Location')).toBeNull();
    });

    it('keeps the expiry answer when the leader named no webhook replacement', async () => {
      h.tray.supersededByJoinUrl = 'https://hub.example/join/fresh-tray.deadbeef';
      h.expiredResponse = new Response('{"code":"TRAY_EXPIRED"}', { status: 410 });
      const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ code: 'TRAY_EXPIRED' });
    });

    it('keeps the terminal answer when the stored replacement does not parse', async () => {
      h.tray.supersededByWebhookUrl = 'not-a-url';
      h.expiredResponse = new Response('{"code":"TRAY_EXPIRED"}', { status: 410 });
      const response = await h.relay.handle(TOKEN, post('{}'), 'build-done');
      expect(response.status).toBe(410);
    });
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

  it('marks only explicit delivered/filtered receipts as durable queue acknowledgements', async () => {
    for (const disposition of ['delivered', 'filtered'] as const) {
      const pending = h.relay.handleInternal('wh', post('{}'));
      await ack(h, disposition);
      expect((await pending).headers.get('x-slicc-webhook-ack')).toBe(disposition);
    }
    const legacy = await h.relay.handleInternal('wh', post('{}'));
    expect(legacy.status).toBe(202);
    expect(legacy.headers.get('x-slicc-webhook-ack')).toBeNull();
  });

  it('preserves non-UTF8 binary bytes as base64 with original headers', async () => {
    const pending = h.relay.handleInternal(
      'wh',
      new Request('https://internal/internal/webhook/wh', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-signature': 'sig' },
        body: new Uint8Array([0, 255, 128, 1]),
      })
    );
    await forwarded(h);
    expect(h.sent.at(-1)).toMatchObject({
      body: { raw: 'AP+AAQ==', encoding: 'base64' },
      headers: { 'content-type': 'application/octet-stream', 'x-signature': 'sig' },
    });
    await ack(h, 'delivered');
    await pending;
  });

  it('rejects oversized payloads without sending them to the leader', async () => {
    const response = await h.relay.handleInternal('wh', post('x'.repeat(65_537)));
    expect(response.status).toBe(413);
    expect(h.sent).toHaveLength(0);
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

    expect(() => ack(h, 'unknown-webhook')).not.toThrow();
  });
});
