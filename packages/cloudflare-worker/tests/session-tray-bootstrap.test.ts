/**
 * `BootstrapCoordinator` — the follower WebRTC signaling state machine
 * extracted from the tray DO (issue #2674). Driven directly through its
 * `BootstrapDeps` seam, so the error and retry paths that a full DO handshake
 * never reaches are reachable here.
 */

import type {
  TrayBootstrapEvent,
  TurnIceServer,
  WorkerToLeaderControlMessage,
} from '@slicc/shared-ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { BootstrapCoordinator, type BootstrapDeps } from '../src/session-tray-bootstrap.js';
import type { TrayBootstrapRecord, TrayRecord, TrayWebSocketLike } from '../src/shared.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const ANSWER = { type: 'answer' as const, sdp: 'v=0' };
const OFFER = { type: 'offer' as const, sdp: 'v=0' };
const CANDIDATE = { candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host' };

interface Harness {
  deps: BootstrapDeps;
  coordinator: BootstrapCoordinator;
  tray: TrayRecord;
  sent: WorkerToLeaderControlMessage[];
  persisted: number;
  nowMs: number;
  leaderLive: boolean;
  leaderReachable: boolean;
  iceServers: TurnIceServer[] | undefined;
}

function createTray(overrides: Partial<TrayRecord> = {}): TrayRecord {
  return {
    trayId: 'tray-1',
    createdAt: new Date(NOW).toISOString(),
    joinToken: 'tray-1.join',
    controllerToken: 'tray-1.controller',
    webhookToken: 'tray-1.webhook',
    controllers: {},
    bootstraps: {},
    leader: null,
    ...overrides,
  };
}

function createHarness(tray = createTray()): Harness {
  const harness: Harness = {
    tray,
    sent: [],
    persisted: 0,
    nowMs: NOW,
    leaderLive: true,
    // A live leader whose socket send still fails — the case that turns a
    // signaling relay into a bootstrap failure.
    leaderReachable: true,
    iceServers: undefined,
    deps: undefined as unknown as BootstrapDeps,
    coordinator: undefined as unknown as BootstrapCoordinator,
  };
  harness.deps = {
    requireTray: () => harness.tray,
    persistTray: async () => {
      harness.persisted += 1;
    },
    now: () => harness.nowMs,
    isoNow: () => new Date(harness.nowMs).toISOString(),
    hasLiveLeader: () => harness.leaderLive,
    sendToLeader: (message) => {
      if (!harness.leaderLive || !harness.leaderReachable) return false;
      harness.sent.push(message);
      return true;
    },
    getIceServers: async () => harness.iceServers,
    leaderSummary: async () => null,
  };
  harness.coordinator = new BootstrapCoordinator(harness.deps);
  return harness;
}

/** A socket that only records what the coordinator wrote to it. */
function fakeSocket(): TrayWebSocketLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: (data: string) => sent.push(data),
    close: () => {},
  } as unknown as TrayWebSocketLike & { sent: string[] };
}

describe('BootstrapCoordinator.handleRequest', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('rejects an unrecognized signaling action', async () => {
    const response = await h.coordinator.handleRequest({ action: 'teleport' } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_BOOTSTRAP_REQUEST' });
  });

  it.each(['poll', 'answer', 'ice-candidate', 'retry'] as const)(
    '404s a %s for a bootstrap that does not exist',
    async (action) => {
      const response = await h.coordinator.handleRequest({
        action,
        controllerId: 'ghost',
        bootstrapId: 'nope',
        answer: ANSWER,
        candidate: CANDIDATE,
      } as never);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: 'BOOTSTRAP_NOT_FOUND' });
    }
  );

  it('400s an answer that is not a valid session description', async () => {
    for (const answer of [undefined, OFFER, { type: 'answer' }]) {
      const response = await h.coordinator.handleRequest({
        action: 'answer',
        controllerId: 'c1',
        answer,
      } as never);
      expect(response.status).toBe(400);
    }
  });

  it('400s an ICE candidate without a candidate string', async () => {
    const response = await h.coordinator.handleRequest({
      action: 'ice-candidate',
      controllerId: 'c1',
      candidate: {},
    } as never);
    expect(response.status).toBe(400);
  });
});

describe('BootstrapCoordinator.ensure', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('mints a bootstrap and announces a full-trust follower to the leader', async () => {
    h.iceServers = [{ urls: ['turn:example'], username: 'u', credential: 'c' }];
    const bootstrap = await h.coordinator.ensure('c1', 'ios');

    expect(h.tray.bootstraps[bootstrap.bootstrapId]).toBe(bootstrap);
    expect(bootstrap).toMatchObject({ state: 'pending', attempt: 1, retryCount: 0 });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: 'follower.join_requested',
      controllerId: 'c1',
      runtime: 'ios',
      trust: 'full',
      iceServers: h.iceServers,
    });
  });

  it('reuses an open bootstrap for the same capability', async () => {
    const first = await h.coordinator.ensure('c1', 'ios');
    const second = await h.coordinator.ensure('c1', 'ios');
    expect(second).toBe(first);
    expect(h.sent).toHaveLength(1);
  });

  it('mints a fresh bootstrap when the same controllerId arrives under a different capability', async () => {
    const full = await h.coordinator.ensure('c1', 'ios');
    const guest = await h.coordinator.ensure('c1', 'ios', 'seat1');
    expect(guest.bootstrapId).not.toBe(full.bootstrapId);
    expect(guest.biscottoId).toBe('seat1');
  });

  it('announces a guest seat with its label and gates', async () => {
    h.tray.biscotti = [
      {
        id: 'seat1',
        token: 'tray-1.seat',
        label: 'Anna',
        createdAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 1000).toISOString(),
        gates: { message: { approver: 'cone' }, tool: { approver: 'user' } },
      },
    ];
    await h.coordinator.ensure('c1', 'ios', 'seat1');
    expect(h.sent[0]).toMatchObject({
      trust: 'biscotto',
      biscotto: {
        id: 'seat1',
        label: 'Anna',
        gates: { message: { approver: 'cone' }, tool: { approver: 'user' } },
      },
    });
  });

  it('still announces a seat revoked between attach and announcement as a guest, not as full trust', async () => {
    await h.coordinator.ensure('c1', 'ios', 'vanished');
    expect(h.sent[0]).toMatchObject({
      trust: 'biscotto',
      biscotto: { id: 'vanished', label: '' },
    });
  });
});

describe('BootstrapCoordinator signaling relay', () => {
  let h: Harness;
  let bootstrap: TrayBootstrapRecord;

  beforeEach(async () => {
    h = createHarness();
    bootstrap = await h.coordinator.ensure('c1', 'ios');
    h.sent.length = 0;
  });

  it('relays an answer and moves the bootstrap to connected', async () => {
    const response = await h.coordinator.handleRequest({
      action: 'answer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      answer: ANSWER,
    });
    expect(response.status).toBe(200);
    expect(h.sent[0]).toMatchObject({ type: 'bootstrap.answer', answer: ANSWER });
    expect(bootstrap.state).toBe('connected');
  });

  it('relays a trickled ICE candidate without completing the handshake', async () => {
    const response = await h.coordinator.handleRequest({
      action: 'ice-candidate',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      candidate: CANDIDATE,
    });
    expect(response.status).toBe(200);
    expect(h.sent[0]).toMatchObject({ type: 'bootstrap.ice_candidate', candidate: CANDIDATE });
    expect(bootstrap.state).toBe('pending');
  });

  it('fails the bootstrap retryably when the leader send does not land', async () => {
    h.leaderReachable = false;
    const response = await h.coordinator.handleRequest({
      action: 'answer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      answer: ANSWER,
    });
    expect(response.status).toBe(409);
    expect(bootstrap.state).toBe('failed');
    expect(bootstrap.failure).toMatchObject({ code: 'LEADER_NOT_CONNECTED', retryable: true });
  });

  it('409s further signaling once the bootstrap has failed', async () => {
    h.leaderLive = false;
    // The first poll notices the dead control channel and fails the record.
    const failed = await h.coordinator.handleRequest({
      action: 'poll',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
    });
    expect(failed.status).toBe(200);
    expect(bootstrap.state).toBe('failed');

    const answer = await h.coordinator.handleRequest({
      action: 'answer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      answer: ANSWER,
    });
    expect(answer.status).toBe(409);
  });

  it('fails an attempt that outlived its window', async () => {
    h.nowMs = NOW + 10 * 60 * 1000;
    await h.coordinator.handleRequest({
      action: 'poll',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
    });
    expect(bootstrap.failure).toMatchObject({ code: 'BOOTSTRAP_TIMEOUT' });
  });
});

describe('BootstrapCoordinator.handleRequest retry', () => {
  let h: Harness;
  let bootstrap: TrayBootstrapRecord;

  beforeEach(async () => {
    h = createHarness();
    bootstrap = await h.coordinator.ensure('c1', 'ios', 'seat1');
    h.sent.length = 0;
  });

  it('409s a retry while the attempt is still open', async () => {
    const response = await h.coordinator.handleRequest({
      action: 'retry',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
    });
    expect(response.status).toBe(409);
  });

  it('mints the next attempt and carries the guest seat forward', async () => {
    h.leaderReachable = false;
    await h.coordinator.handleRequest({
      action: 'answer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      answer: ANSWER,
    });
    h.leaderReachable = true;

    const response = await h.coordinator.handleRequest({
      action: 'retry',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      runtime: 'macos',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { bootstrap: { attempt: number; bootstrapId: string } };
    expect(body.bootstrap.attempt).toBe(2);
    expect(body.bootstrap.bootstrapId).not.toBe(bootstrap.bootstrapId);
    expect(h.tray.bootstraps[body.bootstrap.bootstrapId]).toMatchObject({
      retryCount: 1,
      runtime: 'macos',
      biscottoId: 'seat1',
    });
    expect(h.sent.at(-1)).toMatchObject({ trust: 'biscotto', attempt: 2 });
  });

  it('refuses a retry once the leader is gone', async () => {
    h.leaderLive = false;
    await h.coordinator.handleRequest({
      action: 'poll',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
    });
    const response = await h.coordinator.handleRequest({
      action: 'retry',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
    });
    expect(response.status).toBe(409);
  });

  it('stops retrying once the attempt budget is spent', async () => {
    const spent = await h.coordinator.ensure('c2', 'ios');
    spent.retryCount = spent.maxRetries;
    h.leaderReachable = false;
    await h.coordinator.handleRequest({
      action: 'answer',
      controllerId: 'c2',
      bootstrapId: spent.bootstrapId,
      answer: ANSWER,
    });
    expect(spent.failure).toMatchObject({ retryable: false, retryAfterMs: null });
    expect(h.coordinator.buildStatus(spent)).toMatchObject({
      retriesRemaining: 0,
      retryAfterMs: null,
    });
  });
});

describe('BootstrapCoordinator leader control messages', () => {
  let h: Harness;
  let bootstrap: TrayBootstrapRecord;
  let socket: ReturnType<typeof fakeSocket>;

  beforeEach(async () => {
    h = createHarness();
    bootstrap = await h.coordinator.ensure('c1', 'ios');
    socket = fakeSocket();
  });

  it('records the leader offer and advances the state', () => {
    h.coordinator.onLeaderOffer(socket, {
      type: 'bootstrap.offer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      offer: OFFER,
    });
    expect(bootstrap.state).toBe('offered');
    expect(bootstrap.events).toHaveLength(1);
  });

  it.each(['bootstrap.offer', 'bootstrap.ice_candidate', 'bootstrap.failed'] as const)(
    'tells the leader when %s names a bootstrap that is gone',
    (type) => {
      const message = {
        type,
        controllerId: 'c1',
        bootstrapId: 'vanished',
        offer: OFFER,
        candidate: CANDIDATE,
        code: 'PEER_FAILED',
        message: 'gone',
      } as never;
      if (type === 'bootstrap.offer') h.coordinator.onLeaderOffer(socket, message);
      else if (type === 'bootstrap.ice_candidate')
        h.coordinator.onLeaderIceCandidate(socket, message);
      else h.coordinator.onLeaderFailed(socket, message);

      expect(JSON.parse(socket.sent[0])).toMatchObject({
        code: 'BOOTSTRAP_NOT_FOUND',
        bootstrapId: 'vanished',
      });
    }
  );

  it('honours an explicit non-retryable failure from the leader', () => {
    h.coordinator.onLeaderFailed(socket, {
      type: 'bootstrap.failed',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      code: 'PEER_UNSUPPORTED',
      message: 'no webrtc',
      retryable: false,
    });
    expect(bootstrap.failure).toMatchObject({ retryable: false, retryAfterMs: null });
  });

  it('ignores leader signaling for an already-failed bootstrap', () => {
    h.leaderLive = false;
    h.coordinator.onLeaderIceCandidate(socket, {
      type: 'bootstrap.ice_candidate',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      candidate: CANDIDATE,
    });
    // The refresh failed it; only the synthesized failure event was recorded.
    expect(bootstrap.state).toBe('failed');
    expect(bootstrap.events.map((event) => event.type)).toEqual(['bootstrap.failed']);
  });

  it('caps the event log but keeps the offer at the head', () => {
    h.coordinator.onLeaderOffer(socket, {
      type: 'bootstrap.offer',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      offer: OFFER,
    });
    for (let i = 0; i < 40; i++) {
      h.coordinator.onLeaderIceCandidate(socket, {
        type: 'bootstrap.ice_candidate',
        controllerId: 'c1',
        bootstrapId: bootstrap.bootstrapId,
        candidate: { candidate: `candidate:${i}` },
      });
    }
    expect(bootstrap.events.length).toBeLessThanOrEqual(20);
    expect(bootstrap.events[0]?.type).toBe('bootstrap.offer');
  });
});

describe('BootstrapCoordinator record selection and pruning', () => {
  it('resolves a controller to its highest attempt', async () => {
    const h = createHarness();
    const first = await h.coordinator.ensure('c1', 'ios');
    first.state = 'failed';
    first.failure = {
      code: 'X',
      message: 'x',
      retryable: true,
      retryAfterMs: 1,
      failedAt: new Date(NOW).toISOString(),
    };
    const retried = await h.coordinator.handleRequest({
      action: 'retry',
      controllerId: 'c1',
      bootstrapId: first.bootstrapId,
    });
    const body = (await retried.json()) as { bootstrap: { bootstrapId: string; attempt: number } };
    expect(body.bootstrap.attempt).toBe(2);

    // A poll that names only the controller must find the newest attempt.
    const polled = await h.coordinator.handleRequest({ action: 'poll', controllerId: 'c1' });
    const polledBody = (await polled.json()) as { bootstrap: { bootstrapId: string } };
    expect(polledBody.bootstrap.bootstrapId).toBe(body.bootstrap.bootstrapId);
  });

  it('refuses a bootstrapId that belongs to a different controller', async () => {
    const h = createHarness();
    const bootstrap = await h.coordinator.ensure('c1', 'ios');
    const response = await h.coordinator.handleRequest({
      action: 'poll',
      controllerId: 'someone-else',
      bootstrapId: bootstrap.bootstrapId,
    });
    expect(response.status).toBe(404);
  });

  it('reaps terminal bootstraps once the grace window has passed', async () => {
    const h = createHarness();
    const bootstrap = await h.coordinator.ensure('c1', 'ios');
    bootstrap.state = 'connected';
    h.nowMs = NOW + 6 * 60 * 1000;
    await h.coordinator.ensure('c2', 'ios');
    expect(h.tray.bootstraps[bootstrap.bootstrapId]).toBeUndefined();
  });

  it('replays only the events after the follower cursor', async () => {
    const h = createHarness();
    const bootstrap = await h.coordinator.ensure('c1', 'ios');
    const socket = fakeSocket();
    for (let i = 0; i < 3; i++) {
      h.coordinator.onLeaderIceCandidate(socket, {
        type: 'bootstrap.ice_candidate',
        controllerId: 'c1',
        bootstrapId: bootstrap.bootstrapId,
        candidate: { candidate: `candidate:${i}` },
      });
    }
    const response = await h.coordinator.handleRequest({
      action: 'poll',
      controllerId: 'c1',
      bootstrapId: bootstrap.bootstrapId,
      cursor: 2,
    });
    const body = (await response.json()) as { events: TrayBootstrapEvent[] };
    expect(body.events.map((event) => event.sequence)).toEqual([3]);
  });
});
