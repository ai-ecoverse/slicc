/**
 * End-to-end join-path tests for biscotto guest seats, driven through the real
 * SessionTrayDurableObject rather than the lifecycle helpers — the trust
 * decisions that matter live in the join/bootstrap plumbing, not in the pure
 * functions.
 */
import { describe, expect, it } from 'vitest';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { type BiscottoRecord, createCapabilityToken, type TrayRecord } from '../src/shared.js';
import type { FakeWebSocket } from './fake-do-state.js';
import { createFakeWebSocketPair, FakeDurableObjectState } from './fake-do-state.js';

const HOST = 'https://www.sliccy.ai';

interface TestTray {
  durable: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  trayId: string;
  joinToken: string;
  controllerToken: string;
}

async function createTestTray(clockRef: { now: number }): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const durable = new SessionTrayDurableObject(
    state,
    {},
    { now: () => clockRef.now, webSocketPairFactory: () => createFakeWebSocketPair(state) }
  );
  state.instance = durable;
  const trayId = crypto.randomUUID();
  const joinToken = createCapabilityToken(trayId);
  const controllerToken = createCapabilityToken(trayId);
  await durable.fetch(
    new Request(`${HOST}/internal/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        trayId,
        createdAt: new Date(clockRef.now).toISOString(),
        joinToken,
        controllerToken,
        webhookToken: createCapabilityToken(trayId),
      }),
    })
  );
  return { durable, state, trayId, joinToken, controllerToken };
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

async function join(t: TestTray, token: string, controllerId: string): Promise<Response> {
  return t.durable.fetch(
    new Request(`${HOST}/join/${token}?json=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId, action: 'attach' }),
    })
  );
}

async function mintSeat(t: TestTray, label = 'Anna'): Promise<{ id: string; token: string }> {
  const res = await t.durable.fetch(
    new Request(`${HOST}/internal/biscotto/mint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken: t.controllerToken,
        label,
        workerBaseUrl: HOST,
      }),
    })
  );
  const { id } = (await res.json()) as { id: string };
  const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
  const record = (tray.biscotti ?? []).find((b: BiscottoRecord) => b.id === id)!;
  return { id, token: record.token };
}

/** Every `follower.join_requested` the leader socket received. */
function joinAnnouncements(socket: FakeWebSocket) {
  // `wsRes.webSocket` is the CLIENT end; what the DO pushes to the leader
  // arrives as `received` on it (the DO holds the server end).
  return socket.received
    .map((raw) => JSON.parse(raw) as { type: string; trust?: string; biscotto?: { id: string } })
    .filter((m) => m.type === 'follower.join_requested');
}

describe('biscotto join path', () => {
  it('announces a guest to the leader as biscotto, and the owner as full', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const t = await createTestTray(clock);
    const socket = await attachLeader(t);
    const seat = await mintSeat(t);

    await join(t, t.joinToken, 'owner-device');
    await join(t, seat.token, 'guest-device');

    const announced = joinAnnouncements(socket);
    expect(announced).toHaveLength(2);
    expect(announced[0].trust).toBe('full');
    expect(announced[1].trust).toBe('biscotto');
    expect(announced[1].biscotto?.id).toBe(seat.id);
  });

  it('403s a revoked seat at the join door', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const t = await createTestTray(clock);
    await attachLeader(t);
    const seat = await mintSeat(t);

    await t.durable.fetch(
      new Request(`${HOST}/internal/biscotto/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerToken: t.controllerToken, id: seat.id }),
      })
    );

    const res = await join(t, seat.token, 'guest-device');
    expect(res.status).toBe(403);
  });

  it('409s a controllerId replayed under a different capability', async () => {
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const t = await createTestTray(clock);
    await attachLeader(t);
    const seat = await mintSeat(t);

    await join(t, t.joinToken, 'shared-id');
    const res = await join(t, seat.token, 'shared-id');

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('JOIN_CAPABILITY_MISMATCH');
  });

  it('never lets a guest inherit a stale full-trust bootstrap', async () => {
    // The escalation: a full follower's CONTROLLER record is pruned while its
    // non-terminal bootstrap survives (controllers and bootstraps are reaped by
    // different rules). A guest presenting that controllerId then passes the
    // mismatch check against a freshly-created controller record, and would
    // adopt the surviving bootstrap — whose `biscottoId` is absent — getting
    // announced to the leader as `trust: 'full'`.
    const clock = { now: Date.parse('2026-08-27T12:00:00.000Z') };
    const t = await createTestTray(clock);
    const socket = await attachLeader(t);
    const seat = await mintSeat(t);

    await join(t, t.joinToken, 'recycled-id');

    // Drop only the controller record, exactly as pruneStaleControllers would.
    const tray = (await t.state.storage.get<TrayRecord>('tray'))!;
    delete tray.controllers['recycled-id'];
    await t.state.storage.put('tray', tray);

    await join(t, seat.token, 'recycled-id');

    const announced = joinAnnouncements(socket);
    const guestAnnouncements = announced.filter((m) => m.trust === 'biscotto');
    expect(guestAnnouncements).toHaveLength(1);
    expect(guestAnnouncements[0].biscotto?.id).toBe(seat.id);

    // And the guest must not be sitting on the owner's bootstrap record.
    const after = (await t.state.storage.get<TrayRecord>('tray'))!;
    const guestBootstraps = Object.values(after.bootstraps).filter(
      (b) => b.controllerId === 'recycled-id' && b.biscottoId === seat.id
    );
    expect(guestBootstraps).toHaveLength(1);
  });
});
