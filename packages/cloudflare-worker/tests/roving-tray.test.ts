/**
 * Roving-tray characterization matrix (issue #2812).
 *
 * A tray is an INSTANCE — one SessionTrayDurableObject addressed by
 * `idFromName(trayId)`. This suite drives that DO directly to pin the behavior
 * of each tray-anchored surface across every rove shape.
 *
 * ## What this covers vs. what moved on
 *
 * The WEBHOOK surface no longer anchors on the tray: #2812 put a stable
 * cone-scoped address (`/wh/<coneId>.<secret>`) in front of it via the
 * `WebhookHomeDurableObject`, so a rove is INVISIBLE to an external sender.
 * That path is covered by `webhook-home.test.ts` (the DO) and the
 * `index.test.ts` "survives a rove invisibly" test (end to end). The webhook
 * rows BELOW pin the LEGACY tray-scoped surface (`/webhook/<trayId>...`), which
 * is retained only so an already-cached legacy URL keeps working via its 308
 * migration path — that behavior is unchanged and still worth guarding.
 *
 * The JOIN surface still anchors on the tray (followers are SLICC clients that
 * persist the replacement), so its 308 supersede path is the live contract.
 *
 * The matrix (tray DO surfaces):
 *
 * | surface \ rove         | superseded (forwarding left) | expired (none left)  |
 * |------------------------|------------------------------|----------------------|
 * | join, full token       | 308 → new join URL           | 410 TRAY_EXPIRED     |
 * | join, ?redirect=manual | 409 + successor-version link | 410 TRAY_EXPIRED     |
 * | join, biscotto seat    | 410 TRAY_SUPERSEDED, no URL  | 410 TRAY_EXPIRED     |
 * | join, invalid token    | 403 (no redirect leaked)     | 403                  |
 * | webhook (legacy) valid | 308 → new webhook URL        | 410, delivery lost   |
 * | webhook (legacy) no fwd| 410 NO_LIVE_LEADER, lost     | 410, delivery lost   |
 * | webhook (legacy) bad   | 403 (no redirect leaked)     | 403                  |
 * | live preview URL       | HOLE: no forwarding surface  | 404 (resolve = null) |
 * | supersede after expiry | n/a                          | accepted (recovery)  |
 *
 * The `live preview URL` HOLE remains — previews are a separate surface with
 * its own token family and no forwarding indirection; out of scope for #2812
 * and tracked for follow-up.
 *
 * Not in the matrix because they are structural rather than behavioral:
 * push registrations (`TrayRecord.pushTokens`) die with the tray record, and
 * legacy redirect chains never flatten server-side (pinned below), so a sender
 * on a legacy URL that crosses more roves than the client-side hop cap
 * (`MAX_SUPERSEDE_REDIRECTS` = 5 in `tray-webrtc.ts`) dead-ends — another
 * reason the stable cone address supersedes the legacy shape.
 */
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

/** A real DO instance over fake state, with a controllable clock. */
async function createTestTray(clockRef: { now: number }): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const durable = new SessionTrayDurableObject(
    state,
    {},
    {
      now: () => clockRef.now,
      webSocketPairFactory: () => createFakeWebSocketPair(state),
      // A live-leader delivery test would otherwise wait out the full
      // production ack budget for a leader that never answers.
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

/**
 * The exact call `notifyTraySuperseded` (webapp `tray-leader.ts`) makes when
 * a leader abandons `old` for a replacement: point the old tray at the new
 * tray's join + webhook URLs, authenticated by the OLD controller token.
 */
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

/** Follower attach POST, optionally with extra query params. */
async function joinAttach(t: TestTray, token: string, query = 'json=true'): Promise<Response> {
  return t.durable.fetch(
    new Request(`${HOST}/join/${token}?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: `follower-${token.slice(-6)}`, action: 'attach' }),
    })
  );
}

/** External-sender webhook delivery POST. */
async function webhookPost(t: TestTray, token: string, webhookId: string): Promise<Response> {
  return t.durable.fetch(
    new Request(`${HOST}/webhook/${token}/${webhookId}?src=ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'render-finished' }),
    })
  );
}

/** Mint a guest seat and return its live capability token. */
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

/** Mint a live (non-persistent) preview and return its token. */
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

/**
 * Put the tray in the "leader vanished, reclaim TTL elapsed" state: leader
 * marked disconnected `TRAY_RECLAIM_TTL_MS + 1s` ago. Written straight to
 * storage (the pruning suite's pattern) so the transition is deterministic
 * rather than depending on fake-socket close-event ordering.
 */
async function expireLeader(t: TestTray, clockRef: { now: number }): Promise<void> {
  const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
  expect(tray.leader).not.toBeNull();
  tray.leader!.connected = false;
  tray.leader!.disconnectedAt = new Date(clockRef.now).toISOString();
  await t.state.storage.put('tray', tray);
  clockRef.now += TRAY_RECLAIM_TTL_MS + 1_000;
}

/** Mark the leader disconnected without advancing past the reclaim TTL. */
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
  /** Tray A superseded by tray B, with a guest seat and a live preview on A. */
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
    // `json=true` is carried onto Location so a platform-followed redirect
    // stays an API probe instead of landing on the SPA fallback.
    expect(res.headers.get('Location')).toBe(`${b.joinUrl}?json=true`);
    // The link keeps the bare URL — it is what followers persist.
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
    // Seats die with their tray (nothing re-mints them on the replacement), so
    // a rove ENDS a guest's access rather than forwarding it. The successor URL
    // carries the replacement's FULL join token, which a guest has no claim on;
    // redirecting a seat there would silently promote it to a full follower of
    // the new tray (the guest→full escalation this closes). The answer is
    // terminal and leaks nothing about the replacement — no Location, no link.
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b, seat } = await rovedPair(clock);

    const res = await joinAttach(a, seat.token);
    expect(res.status).toBe(410);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Link')).toBeNull();
    const raw = await res.text();
    // The replacement's full join token appears nowhere in the response.
    expect(raw).not.toContain(b.joinToken);
    const body = JSON.parse(raw) as AttachBody;
    expect(body.result?.action).toBe('fail');
    expect(body.result?.code).toBe('TRAY_SUPERSEDED');
    expect(body.result?.joinUrl).toBeUndefined();
  });

  it('redirects a webhook delivery with 308, carrying webhookId and query', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, b } = await rovedPair(clock);

    const res = await webhookPost(a, a.webhookToken, 'wh-render');
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(`${b.webhookUrl}/wh-render?src=ci`);
    // The cost #2812 names: the replacement's webhook capability (a secret)
    // rides in a response header to anyone holding the OLD webhook URL.
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
    // A leader that predates `supersededByWebhookUrl` (or a supersede call
    // that failed halfway) leaves the join surface redirecting but the
    // webhook surface dead: the delivery answers 410 and the event is gone.
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

  it('HOLE: live preview URLs have no forwarding surface at all', async () => {
    // The preview host resolves `<token>.sliccy.now` through the OLD tray's
    // DO. After a rove the record still resolves (the tray is superseded, not
    // expired), but serving needs the leader socket — which will never
    // reconnect here. There is no `supersededByPreviewUrl`; every shared
    // preview link dies with a 502, silently.
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a, preview } = await rovedPair(clock);

    const resolve = await a.durable.fetch(
      new Request(`${HOST}/internal/preview/resolve?token=${preview.previewToken}`)
    );
    expect(resolve.status).toBe(200); // still resolves — the host will try to serve

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
    expect(fetchRes.status).toBe(502); // leader gone for good — no redirect, no recovery
  });

  it('does not flatten redirect chains: each rove adds one client-side hop', async () => {
    // A → B → C. A delivery to A names B, never C: the worker never chases
    // the chain, so every rove costs the holder one more round trip and the
    // browser follower gives up at MAX_SUPERSEDE_REDIRECTS (5) hops even
    // though every tray in the chain still answers.
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
  /** Tray A whose leader vanished without superseding; reclaim TTL elapsed. */
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

    // The expiry tombstone is written lazily by the first gated request.
    await joinAttach(a, a.joinToken);

    const resolve = await a.durable.fetch(
      new Request(`${HOST}/internal/preview/resolve?token=${preview.previewToken}`)
    );
    expect(resolve.status).toBe(404);
  });

  it('still accepts a supersede after expiry — the recovery path', async () => {
    // The webapp's stale-session recovery (`shouldRecreateTray`) reuses the
    // stored controller token to supersede the corpse AFTER it expired. The
    // internal route dispatches before the expiry gate, so the forwarding
    // address can still be written and both surfaces come back as redirects.
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const { a } = await expiredTray(clock);
    await joinAttach(a, a.joinToken); // write the expiry tombstone first

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
    // Stable addressing alone would not have saved this delivery: the tray is
    // alive and correctly addressed, but with no leader socket there is no
    // queue — the sender gets a 410 a fire-and-forget caller ignores. This is
    // the liveness half #2812 defers (deliberately) to a separate decision.
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
