import { describe, expect, it } from 'vitest';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import {
  type BiscottoRecord,
  createCapabilityToken,
  TRAY_RECLAIM_TTL_MS,
  type TrayRecord,
} from '../src/shared.js';
import type { FakeWebSocket } from './fake-do-state.js';
import { createFakeWebSocketPair, FakeDurableObjectState } from './fake-do-state.js';

const HOST = 'https://www.sliccy.ai';

interface TestTray {
  durable: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  trayId: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  joinUrl: string;
  webhookUrl: string;
}

async function createTestTray(clockRef: { now: number }): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const durable = new SessionTrayDurableObject(
    state,
    {},
    {
      now: () => clockRef.now,
      webSocketPairFactory: () => createFakeWebSocketPair(state),

      webhookDeliveryWaitMs: 10,
    }
  );
  state.instance = durable;
  const trayId = crypto.randomUUID();
  const joinToken = createCapabilityToken(trayId);
  const controllerToken = createCapabilityToken(trayId);
  const webhookToken = createCapabilityToken(trayId);
  await durable.fetch(
    new Request(`${HOST}/internal/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trayId,
        createdAt: new Date(clockRef.now).toISOString(),
        joinToken,
        controllerToken,
        webhookToken,
      }),
    })
  );
  return {
    durable,
    state,
    trayId,
    joinToken,
    controllerToken,
    webhookToken,
    joinUrl: `${HOST}/join/${joinToken}`,
    webhookUrl: `${HOST}/webhook/${webhookToken}`,
  };
}

async function attachLeader(t: TestTray): Promise<FakeWebSocket> {
  const res = await t.durable.fetch(
    new Request(`${HOST}/controller/${t.controllerToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'leader-1' }),
    })
  );
  const leader = (await res.json()) as { websocket: { url: string } };
  const wsRes = await t.durable.fetch(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
  );
  return (wsRes as unknown as { webSocket: FakeWebSocket }).webSocket;
}

async function supersede(
  old: TestTray,
  by: { joinUrl: string; webhookUrl?: string }
): Promise<Response> {
  return old.durable.fetch(
    new Request(`${HOST}/internal/supersede`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken: old.controllerToken,
        joinUrl: by.joinUrl,
        ...(by.webhookUrl ? { webhookUrl: by.webhookUrl } : {}),
      }),
    })
  );
}

async function joinAttach(t: TestTray, token: string, query = 'json=true'): Promise<Response> {
  return t.durable.fetch(
    new Request(`${HOST}/join/${token}?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: `follower-${token.slice(-6)}`, action: 'attach' }),
    })
  );
}

async function webhookPost(t: TestTray, token: string, webhookId: string): Promise<Response> {
  return t.durable.fetch(
    new Request(`${HOST}/webhook/${token}/${webhookId}?src=ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'render-finished' }),
    })
  );
}

async function mintSeat(t: TestTray, label = 'Anna'): Promise<{ id: string; token: string }> {
  const res = await t.durable.fetch(
    new Request(`${HOST}/internal/biscotto/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerToken: t.controllerToken, label, workerBaseUrl: HOST }),
    })
  );
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
  const record = (tray.biscotti ?? []).find((b: BiscottoRecord) => b.id === id)!;
  return { id, token: record.token };
}

async function mintLivePreview(t: TestTray): Promise<{ previewToken: string; url: string }> {
  const res = await t.durable.fetch(
    new Request(`${HOST}/internal/preview/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken: t.controllerToken,
        servedRoot: '/workspace/site',
        entryPath: '/workspace/site/index.html',
        allowLive: false,
        workerBaseUrl: HOST,
      }),
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { previewToken: string; url: string };
}

async function expireLeader(t: TestTray, clockRef: { now: number }): Promise<void> {
  const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
  expect(tray.leader).not.toBeNull();
  tray.leader!.connected = false;
  tray.leader!.disconnectedAt = new Date(clockRef.now).toISOString();
  await t.state.storage.put('tray', tray);
  clockRef.now += TRAY_RECLAIM_TTL_MS + 1_000;
}

async function disconnectLeader(t: TestTray, clockRef: { now: number }): Promise<void> {
  const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
  expect(tray.leader).not.toBeNull();
  tray.leader!.connected = false;
  tray.leader!.disconnectedAt = new Date(clockRef.now).toISOString();
  await t.state.storage.put('tray', tray);
}

interface AttachBody {
  result?: { action?: string; code?: string; joinUrl?: string };
}

describe('roving trays — superseded rove (leader left a forwarding address)', () => {
  async function rovedPair(clock: { now: number }): Promise<{
    a: TestTray;
    b: TestTray;
    seat: { id: string; token: string };
    preview: { previewToken: string; url: string };
  }> {
    const a = await createTestTray(clock);
    await attachLeader(a);
    const seat = await mintSeat(a);
    const preview = await mintLivePreview(a);
    const b = await createTestTray(clock);
    await disconnectLeader(a, clock);
    const res = await supersede(a, { joinUrl: b.joinUrl, webhookUrl: b.webhookUrl });
    expect(res.status).toBe(200);
    return { a, b, seat, preview };
  }

  it('redirects a full follower attach with 308, Location and successor-version', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b } = await rovedPair(clock);

    const res = await joinAttach(a, a.joinToken);
    expect(res.status).toBe(308);

    expect(res.headers.get('Location')).toBe(`${b.joinUrl}?json=true`);

    expect(res.headers.get('Link')).toBe(`<${b.joinUrl}>; rel="successor-version"`);
    const body = (await res.json()) as AttachBody;
    expect(body.result?.action).toBe('redirect');
    expect(body.result?.code).toBe('TRAY_SUPERSEDED');
    expect(body.result?.joinUrl).toBe(b.joinUrl);
  });

  it('answers ?redirect=manual with the pre-#1957 terminal 409 + link', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b } = await rovedPair(clock);

    const res = await joinAttach(a, a.joinToken, 'json=true&redirect=manual');
    expect(res.status).toBe(409);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Link')).toBe(`<${b.joinUrl}>; rel="successor-version"`);
    const body = (await res.json()) as AttachBody;
    expect(body.result?.action).toBe('fail');
    expect(body.result?.code).toBe('TRAY_SUPERSEDED');
  });

  it('never leaks the redirect to an invalid join capability', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await rovedPair(clock);

    const res = await joinAttach(a, createCapabilityToken(a.trayId));
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
  });

  it('never leaks the redirect to a revoked seat', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, seat } = await rovedPair(clock);
    const revoke = await a.durable.fetch(
      new Request(`${HOST}/internal/biscotto/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerToken: a.controllerToken, id: seat.id }),
      })
    );
    expect(revoke.status).toBe(200);

    const res = await joinAttach(a, seat.token);
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('ends a live guest seat with a terminal 410 — never the successor join URL', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b, seat } = await rovedPair(clock);

    const res = await joinAttach(a, seat.token);
    expect(res.status).toBe(410);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    const raw = await res.text();

    expect(raw).not.toContain(b.joinToken);
    const body = JSON.parse(raw) as AttachBody;
    expect(body.result?.action).toBe('fail');
    expect(body.result?.code).toBe('TRAY_EXPIRED');
    expect(body.result?.joinUrl).toBeUndefined();
  });

  it('redirects a webhook delivery with 308, carrying webhookId and query', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b } = await rovedPair(clock);

    const res = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(`${b.webhookUrl}/wh-render?src=ci`);

    expect(res.headers.get('Location')).toContain(b.webhookToken);
  });

  it('never leaks the webhook redirect to an invalid webhook capability', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await rovedPair(clock);

    const res = await webhookPost(a, createCapabilityToken(a.trayId), 'wh-render');
    expect(res.status).toBe(403);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('drops a delivery to a tray superseded WITHOUT a webhook forwarding URL', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const a = await createTestTray(clock);
    await attachLeader(a);
    const b = await createTestTray(clock);
    await disconnectLeader(a, clock);
    await supersede(a, { joinUrl: b.joinUrl });

    const joined = await joinAttach(a, a.joinToken);
    expect(joined.status).toBe(308);

    const res = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NO_LIVE_LEADER');
  });

  it('legacy supersede alone does not authorize a preview transfer', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, preview } = await rovedPair(clock);

    const resolve = await a.durable.fetch(
      new Request(`${HOST}/internal/preview/resolve?token=${preview.previewToken}`)
    );
    expect(resolve.status).toBe(200);

    const fetchRes = await a.durable.fetch(
      new Request(`${HOST}/internal/preview/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reqId: 'req-1',
          servedRoot: '/workspace/site',
          vfsPath: '/workspace/site/index.html',
          asText: true,
        }),
      })
    );
    expect(fetchRes.status).toBe(502);
  });

  it('does not flatten redirect chains: each rove adds one client-side hop', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const a = await createTestTray(clock);
    await attachLeader(a);
    const b = await createTestTray(clock);
    const c = await createTestTray(clock);
    await disconnectLeader(a, clock);
    await supersede(a, { joinUrl: b.joinUrl, webhookUrl: b.webhookUrl });
    await supersede(b, { joinUrl: c.joinUrl, webhookUrl: c.webhookUrl });

    const join = await joinAttach(a, a.joinToken);
    expect(join.headers.get('Location')).toBe(`${b.joinUrl}?json=true`);

    const hook = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(hook.headers.get('Location')).toBe(`${b.webhookUrl}/wh-render?src=ci`);
  });
});

describe('roving trays — expired rove (no forwarding address left)', () => {
  async function expiredTray(clock: { now: number }): Promise<{
    a: TestTray;
    seat: { id: string; token: string };
    preview: { previewToken: string; url: string };
  }> {
    const a = await createTestTray(clock);
    await attachLeader(a);
    const seat = await mintSeat(a);
    const preview = await mintLivePreview(a);
    await expireLeader(a, clock);
    return { a, seat, preview };
  }

  it('dead-ends a full follower attach in 410 TRAY_EXPIRED', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await expiredTray(clock);

    const res = await joinAttach(a, a.joinToken);
    expect(res.status).toBe(410);
    const body = (await res.json()) as AttachBody;
    expect(body.result?.code).toBe('TRAY_EXPIRED');
    expect(res.headers.get('Location')).toBeNull();
  });

  it('dead-ends a guest seat in the same 410', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, seat } = await expiredTray(clock);

    const res = await joinAttach(a, seat.token);
    expect(res.status).toBe(410);
  });

  it('drops a webhook delivery in 410 TRAY_EXPIRED — the #1957 event loss', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await expiredTray(clock);

    const res = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('TRAY_EXPIRED');
  });

  it('stops resolving live previews once expired', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, preview } = await expiredTray(clock);

    await joinAttach(a, a.joinToken);

    const resolve = await a.durable.fetch(
      new Request(`${HOST}/internal/preview/resolve?token=${preview.previewToken}`)
    );
    expect(resolve.status).toBe(404);
  });

  it('still accepts a supersede after expiry — the recovery path', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await expiredTray(clock);
    await joinAttach(a, a.joinToken);

    const b = await createTestTray(clock);
    const res = await supersede(a, { joinUrl: b.joinUrl, webhookUrl: b.webhookUrl });
    expect(res.status).toBe(200);

    const join = await joinAttach(a, a.joinToken);
    expect(join.status).toBe(308);
    expect(join.headers.get('Location')).toBe(`${b.joinUrl}?json=true`);

    const hook = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(hook.status).toBe(308);
    expect(hook.headers.get('Location')).toBe(`${b.webhookUrl}/wh-render?src=ci`);
  });
});

describe('roving trays — liveness gap without a rove', () => {
  it('drops a webhook delivery while the leader is merely disconnected', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const a = await createTestTray(clock);
    await attachLeader(a);
    await disconnectLeader(a, clock);

    const res = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NO_LIVE_LEADER');
  });
});
