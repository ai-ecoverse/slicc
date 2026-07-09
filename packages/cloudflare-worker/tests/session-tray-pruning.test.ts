/**
 * Tests for session-tray DO state pruning (issue #1433):
 * - Terminal bootstrap records are pruned after a grace window
 * - Bootstrap events[] are capped
 * - Stale controllers are pruned
 */
import { describe, expect, it } from 'vitest';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { createCapabilityToken, type TrayRecord } from '../src/shared.js';
import type { FakeWebSocket } from './fake-do-state.js';
import { createFakeWebSocketPair, FakeDurableObjectState } from './fake-do-state.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const HOST = 'https://www.sliccy.ai';

interface TestTray {
  durable: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  trayId: string;
  joinUrl: string;
  controllerUrl: string;
  controllerToken: string;
}

/** Create a DO instance with a controllable clock and initialize a tray. */
async function createTestTray(clockRef: { now: number }): Promise<TestTray> {
  const state = new FakeDurableObjectState();
  const durable = new SessionTrayDurableObject(
    state,
    {},
    {
      now: () => clockRef.now,
      webSocketPairFactory: () => createFakeWebSocketPair(state),
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
    joinUrl: `${HOST}/join/${joinToken}`,
    controllerUrl: `${HOST}/controller/${controllerToken}`,
    controllerToken,
  };
}

/** Attach a leader and open the WebSocket. Returns the leader-side socket. */
async function attachLeader(
  t: TestTray,
  controllerId = 'leader-1'
): Promise<{ leaderKey: string; socket: FakeWebSocket }> {
  const attachRes = await t.durable.fetch(
    new Request(t.controllerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId }),
    })
  );
  const leader = (await attachRes.json()) as {
    leaderKey: string;
    websocket: { url: string };
  };
  const wsRes = await t.durable.fetch(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
  );
  const socket = (wsRes as unknown as { webSocket: FakeWebSocket }).webSocket;
  return { leaderKey: leader.leaderKey, socket };
}

/** Join a follower and return bootstrap info. */
async function joinFollower(
  t: TestTray,
  controllerId: string
): Promise<{ bootstrapId: string; state: string }> {
  const res = await t.durable.fetch(
    new Request(`${t.joinUrl}?json=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId, action: 'attach' }),
    })
  );
  const body = (await res.json()) as {
    result?: { bootstrap?: { bootstrapId: string; state: string } };
  };
  return {
    bootstrapId: body.result?.bootstrap?.bootstrapId ?? '',
    state: body.result?.bootstrap?.state ?? '',
  };
}

/** Read the persisted TrayRecord from fake storage. */
async function readTray(t: TestTray): Promise<TrayRecord> {
  return (await t.state.storage.get<TrayRecord>('tray'))!;
}

/** Overwrite the persisted TrayRecord. */
async function writeTray(t: TestTray, tray: TrayRecord): Promise<void> {
  await t.state.storage.put('tray', tray);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('session-tray state pruning', () => {
  describe('terminal bootstrap pruning', () => {
    it('prunes completed bootstrap after grace window', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      await attachLeader(t);

      // Join follower 1 — creates a bootstrap
      const { bootstrapId: bid1 } = await joinFollower(t, 'follower-1');

      // Mark bootstrap as connected
      const tray = await readTray(t);
      tray.bootstraps[bid1].state = 'connected';
      await writeTray(t, tray);

      // Advance past grace window (expiresAt + 5min + 1s)
      clock.now += 30_000 + 5 * 60 * 1000 + 1000;

      // Join follower 2 — triggers pruning via ensureBootstrap
      await joinFollower(t, 'follower-2');

      const updated = await readTray(t);
      expect(updated.bootstraps[bid1]).toBeUndefined();
      expect(Object.keys(updated.bootstraps).length).toBe(1);
    });

    it('keeps retryable failed bootstrap until non-retryable', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      await attachLeader(t);

      const { bootstrapId: bid } = await joinFollower(t, 'follower-1');

      // Mark as failed but retryable
      const tray = await readTray(t);
      const bootstrap = tray.bootstraps[bid];
      bootstrap.state = 'failed';
      bootstrap.failure = {
        code: 'BOOTSTRAP_TIMEOUT',
        message: 'Timeout',
        retryable: true,
        retryAfterMs: 1000,
        failedAt: new Date(clock.now).toISOString(),
      };
      await writeTray(t, tray);

      // Advance well past grace window
      clock.now += 30_000 + 5 * 60 * 1000 + 60_000;

      // Trigger pruning via new follower
      await joinFollower(t, 'follower-2');

      const updated = await readTray(t);
      // Retryable bootstrap should NOT be pruned
      expect(updated.bootstraps[bid]).toBeDefined();
    });

    it('prunes failed non-retryable bootstrap after grace window', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      await attachLeader(t);

      const { bootstrapId: bid } = await joinFollower(t, 'follower-1');

      // Mark as failed AND non-retryable (maxRetries exhausted)
      const tray = await readTray(t);
      const bootstrap = tray.bootstraps[bid];
      bootstrap.state = 'failed';
      bootstrap.retryCount = bootstrap.maxRetries;
      bootstrap.failure = {
        code: 'BOOTSTRAP_TIMEOUT',
        message: 'Timeout',
        retryable: false,
        retryAfterMs: null,
        failedAt: new Date(clock.now).toISOString(),
      };
      await writeTray(t, tray);

      // Advance past grace window
      clock.now += 30_000 + 5 * 60 * 1000 + 1000;

      // Trigger pruning
      await joinFollower(t, 'follower-2');

      const updated = await readTray(t);
      expect(updated.bootstraps[bid]).toBeUndefined();
    });
  });

  describe('bootstrap events cap', () => {
    it('caps events at 20 per bootstrap', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      const { socket } = await attachLeader(t);

      const { bootstrapId } = await joinFollower(t, 'follower-1');

      // Send 30 ICE candidates → 30 events appended
      for (let i = 0; i < 30; i++) {
        socket.send(
          JSON.stringify({
            type: 'bootstrap.ice_candidate',
            bootstrapId,
            candidate: {
              candidate: `candidate:${i}`,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          })
        );
        await new Promise((r) => setTimeout(r, 0));
      }

      const tray = await readTray(t);
      const bootstrap = tray.bootstraps[bootstrapId];
      expect(bootstrap.events.length).toBeLessThanOrEqual(20);
      // nextSequence reflects all appended events (1 initial + 30 candidates)
      expect(bootstrap.nextSequence).toBeGreaterThan(20);
      // Last event should be the most recent
      const lastEvent = bootstrap.events[bootstrap.events.length - 1];
      expect(lastEvent.sequence).toBe(bootstrap.nextSequence - 1);
    });

    it('preserves bootstrap.offer when ICE candidates exceed cap', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      const { socket } = await attachLeader(t);

      const { bootstrapId } = await joinFollower(t, 'follower-1');

      // Leader sends offer first
      socket.send(
        JSON.stringify({
          type: 'bootstrap.offer',
          bootstrapId,
          offer: { type: 'offer', sdp: 'v=0\r\n...' },
        })
      );
      await new Promise((r) => setTimeout(r, 0));

      // Then 30 ICE candidates (exceeds the 20-event cap)
      for (let i = 0; i < 30; i++) {
        socket.send(
          JSON.stringify({
            type: 'bootstrap.ice_candidate',
            bootstrapId,
            candidate: {
              candidate: `candidate:${i}`,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          })
        );
        await new Promise((r) => setTimeout(r, 0));
      }

      const tray = await readTray(t);
      const bootstrap = tray.bootstraps[bootstrapId];
      expect(bootstrap.events.length).toBeLessThanOrEqual(20);

      // The offer must survive at the head despite 30+ candidates
      const offerEvent = bootstrap.events.find(
        (e: { type: string }) => e.type === 'bootstrap.offer'
      );
      expect(offerEvent).toBeDefined();
      expect(bootstrap.events[0].type).toBe('bootstrap.offer');
    });
  });

  describe('stale controller pruning', () => {
    it('prunes controllers older than 2h while keeping active ones', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      await attachLeader(t);

      // Join follower-old at the current time
      await joinFollower(t, 'follower-old');

      // Advance time by 3h (past the 2h stale threshold)
      clock.now += 3 * 60 * 60 * 1000;

      // Join follower-new — triggers pruning
      await joinFollower(t, 'follower-new');

      const tray = await readTray(t);
      expect(tray.controllers['follower-old']).toBeUndefined();
      expect(tray.controllers['follower-new']).toBeDefined();
      // leader always survives
      expect(tray.controllers['leader-1']).toBeDefined();
    });

    it('never prunes the current leader controller', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      const { leaderKey } = await attachLeader(t);

      // Advance time way past stale threshold
      clock.now += 10 * 60 * 60 * 1000;

      // Controller attach (leader reclaim) triggers pruning
      await t.durable.fetch(
        new Request(t.controllerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            controllerId: 'leader-1',
            leaderKey,
          }),
        })
      );

      const tray = await readTray(t);
      expect(tray.controllers['leader-1']).toBeDefined();
    });

    it('keeps controllers within reclaim window', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      await attachLeader(t);

      // Join follower 90 minutes ago (within the 2h window)
      await joinFollower(t, 'follower-recent');

      // Advance by 90 minutes (< 2h threshold)
      clock.now += 90 * 60 * 1000;

      // Join another follower — triggers pruning
      await joinFollower(t, 'follower-trigger');

      const tray = await readTray(t);
      expect(tray.controllers['follower-recent']).toBeDefined();
    });
  });

  describe('bounded record under load', () => {
    it('100-join / 100-event tray stays bounded', async () => {
      const clock = { now: Date.now() };
      const t = await createTestTray(clock);
      const { socket } = await attachLeader(t);

      for (let i = 0; i < 100; i++) {
        const { bootstrapId } = await joinFollower(t, `follower-${i}`);

        // Send ICE candidate for each bootstrap
        socket.send(
          JSON.stringify({
            type: 'bootstrap.ice_candidate',
            bootstrapId,
            candidate: {
              candidate: `candidate:${i}`,
              sdpMid: '0',
              sdpMLineIndex: 0,
            },
          })
        );
        await new Promise((r) => setTimeout(r, 0));

        // Mark previous bootstraps as connected
        if (i > 0) {
          const tray = await readTray(t);
          for (const b of Object.values(tray.bootstraps)) {
            if (b.controllerId !== `follower-${i}` && b.state === 'pending') {
              b.state = 'connected';
            }
          }
          await writeTray(t, tray);
        }

        // Advance time (10 min per follower = 1000 min total)
        clock.now += 10 * 60 * 1000;
      }

      const tray = await readTray(t);

      // Bootstrap count should be bounded
      const bootstrapCount = Object.keys(tray.bootstraps).length;
      expect(bootstrapCount).toBeLessThan(100);

      // Controller count should be bounded
      const controllerCount = Object.keys(tray.controllers).length;
      expect(controllerCount).toBeLessThan(100);

      // Events per bootstrap should be capped
      for (const bootstrap of Object.values(tray.bootstraps)) {
        expect(bootstrap.events.length).toBeLessThanOrEqual(20);
      }

      // Record size should be well under 128KB DO limit
      const recordSize = JSON.stringify(tray).length;
      expect(recordSize).toBeLessThan(128 * 1024);
    });
  });
});
