import { describe, expect, it, vi } from 'vitest';
import worker, { handleWorkerRequest } from '../src/index.js';
import {
  FOLLOWER_ATTACH_RETRY_AFTER_MS,
  wantsJSON,
  TRAY_RECLAIM_TTL_MS,
  type DurableObjectIdLike,
  type DurableObjectStateLike,
  type TrayRecord,
} from '../src/shared.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { TRAY_BOOTSTRAP_TIMEOUT_MS } from '../src/tray-signaling.js';
import { TURN_CREDENTIAL_TTL_MS } from '../src/turn-credentials.js';

class FakeStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

class FakeDurableObjectState implements DurableObjectStateLike {
  readonly storage = new FakeStorage();
}

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly received: string[] = [];
  peer: FakeWebSocket | null = null;
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();

  accept(): void {}

  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: string }) => void
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
    this.peer?.dispatch('message', { data });
  }

  close(): void {
    const peer = this.peer;
    this.peer = null;
    this.dispatch('close', {});
    if (peer) {
      peer.peer = null;
      peer.dispatch('close', {});
    }
  }

  private dispatch(type: 'message' | 'close' | 'error', event: { data?: string }): void {
    if (type === 'message' && event.data) {
      this.received.push(event.data);
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeWebSocketPair(): { client: FakeWebSocket; server: FakeWebSocket } {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class FakeDurableObjectId implements DurableObjectIdLike {
  constructor(private readonly name: string) {}

  toString(): string {
    return this.name;
  }
}

class FakeNamespace {
  private readonly states = new Map<string, FakeDurableObjectState>();
  private readonly instances = new Map<string, SessionTrayDurableObject>();

  constructor(private readonly now: () => number) {}

  idFromName(name: string): DurableObjectIdLike {
    return new FakeDurableObjectId(name);
  }

  get(id: DurableObjectIdLike): {
    fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  } {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      const state = new FakeDurableObjectState();
      this.states.set(key, state);
      instance = new SessionTrayDurableObject(
        state,
        {},
        { now: this.now, webSocketPairFactory: createFakeWebSocketPair }
      );
      this.instances.set(key, instance);
    }

    return {
      fetch: (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        return instance.fetch(request);
      },
    };
  }

  async readTray(trayId: string): Promise<TrayRecord | undefined> {
    return this.states.get(trayId)?.storage.get<TrayRecord>('tray');
  }
}

const MOCK_HTML = '<html><body>SPA</body></html>';
const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response(MOCK_HTML, {
      headers: { 'content-type': 'text/html' },
    }),
};

function createTestHarness(start = Date.parse('2026-03-11T00:00:00.000Z')): {
  env: { TRAY_HUB: FakeNamespace; ASSETS: typeof fakeAssets };
  advance: (ms: number) => void;
  readTray: (trayId: string) => Promise<TrayRecord | undefined>;
} {
  let now = start;
  const namespace = new FakeNamespace(() => now);
  return {
    env: { TRAY_HUB: namespace, ASSETS: fakeAssets },
    advance: (ms: number) => {
      now += ms;
    },
    readTray: (trayId: string) => namespace.readTray(trayId),
  };
}

describe('tray worker skeleton', () => {
  it('creates a tray at /tray and rejects removed create aliases', async () => {
    const { env } = createTestHarness();

    const response = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      trayId: string;
      capabilities: {
        join: { url: string };
        controller: { url: string };
        webhook: { url: string };
      };
    };
    expect(body.capabilities.join.url).toContain(`/join/${body.trayId}.`);
    expect(body.capabilities.controller.url).toContain(`/controller/${body.trayId}.`);
    expect(body.capabilities.webhook.url).toContain(`/webhook/${body.trayId}.`);

    for (const legacyPath of ['/session', '/trays']) {
      const legacy = await handleWorkerRequest(
        new Request(`https://tray.test${legacyPath}`, { method: 'POST' }),
        env
      );
      expect(legacy.status).toBe(410);
      await expect(legacy.json()).resolves.toMatchObject({
        code: 'TRAY_CREATE_ENDPOINT_MOVED',
        canonical: 'POST /tray',
      });
    }
  });

  it('returns an explicit wait instruction when a follower attaches before a live leader exists', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as {
      role: string;
      leaderKey?: string;
      websocket?: { url: string } | null;
    };

    expect(leader.role).toBe('leader');
    expect(leader.leaderKey).toBeTruthy();
    expect(leader.websocket?.url).toContain('wss://tray.test/controller/');

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      }),
      env
    );
    const follower = (await followerAttach.json()) as {
      role: string;
      leader: { controllerId: string; connected: boolean };
      result: { action: string; code: string; retryAfterMs?: number };
    };

    expect(follower.role).toBe('follower');
    expect(follower.leader.controllerId).toBe('cone-1');
    expect(follower.leader.connected).toBe(false);
    expect(follower.result).toEqual({
      action: 'wait',
      code: 'LEADER_NOT_CONNECTED',
      retryAfterMs: FOLLOWER_ATTACH_RETRY_AFTER_MS,
    });
  });

  it('reports follower join readiness until the live leader websocket is available, then exposes signaling metadata', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const waitingForLeader = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`),
      env
    );
    expect(waitingForLeader.status).toBe(409);
    await expect(waitingForLeader.json()).resolves.toMatchObject({
      trayId: session.trayId,
      capability: 'join',
      leader: null,
      code: 'FOLLOWER_JOIN_NOT_READY',
      retryable: true,
    });

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };

    const waitingForSocket = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`),
      env
    );
    expect(waitingForSocket.status).toBe(409);
    await expect(waitingForSocket.json()).resolves.toMatchObject({
      code: 'FOLLOWER_JOIN_NOT_READY',
      leader: { controllerId: 'cone-1', connected: false },
      retryable: true,
    });

    const socketResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(socketResponse.status).toBe(101);

    const signalingReady = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`),
      env
    );
    expect(signalingReady.status).toBe(200);
    await expect(signalingReady.json()).resolves.toMatchObject({
      trayId: session.trayId,
      capability: 'join',
      leader: { controllerId: 'cone-1', connected: true },
      participantCount: 1,
      signaling: {
        transport: 'http-poll',
        timeoutMs: TRAY_BOOTSTRAP_TIMEOUT_MS,
        maxRetries: 3,
        retryAfterMs: FOLLOWER_ATTACH_RETRY_AFTER_MS,
      },
    });
  });

  it('returns CORS headers on join OPTIONS preflight and POST responses', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { join: { url: string } };
    };

    // OPTIONS preflight
    const preflight = await handleWorkerRequest(
      new Request(session.capabilities.join.url, { method: 'OPTIONS' }),
      env
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');

    // GET (non-POST) join probe should also have CORS
    const probe = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`),
      env
    );
    expect(probe.headers.get('access-control-allow-origin')).toBe('*');

    // POST attach should also have CORS
    const attach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cors-test', runtime: 'test' }),
      }),
      env
    );
    expect(attach.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('returns bootstrap metadata and notifies the leader when a follower attaches after the leader websocket is live', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };
    const socketResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(socketResponse.status).toBe(101);
    const clientSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      }),
      env
    );

    expect(followerAttach.status).toBe(200);
    const follower = (await followerAttach.json()) as {
      controllerId: string;
      result: {
        action: string;
        code: string;
        bootstrap: {
          bootstrapId: string;
          attempt: number;
          state: string;
          retriesRemaining: number;
        };
      };
    };
    expect(follower).toMatchObject({
      trayId: expect.any(String),
      controllerId: 'cone-2',
      role: 'follower',
      leader: { controllerId: 'cone-1', connected: true, reconnectDeadline: null },
      result: {
        action: 'signal',
        code: 'LEADER_CONNECTED',
        bootstrap: {
          attempt: 1,
          state: 'pending',
          retriesRemaining: 3,
        },
      },
    });

    expect(JSON.parse(clientSocket.received[1]!)).toMatchObject({
      type: 'follower.join_requested',
      controllerId: 'cone-2',
      bootstrapId: follower.result.bootstrap.bootstrapId,
      attempt: 1,
    });
  });

  it('refreshes cached TURN credentials after their TTL elapses', async () => {
    let now = Date.parse('2026-03-11T00:00:00.000Z');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            iceServers: {
              urls: ['turn:turn-one.example.com:3478?transport=udp'],
              username: 'user-one',
              credential: 'cred-one',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            iceServers: {
              urls: ['turn:turn-two.example.com:3478?transport=udp'],
              username: 'user-two',
              credential: 'cred-two',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const durableObject = new SessionTrayDurableObject(
      new FakeDurableObjectState(),
      {
        CLOUDFLARE_TURN_KEY_ID: 'turn-key-id',
        CLOUDFLARE_TURN_API_TOKEN: 'turn-api-token',
      },
      {
        now: () => now,
        webSocketPairFactory: createFakeWebSocketPair,
        fetchImpl,
      }
    );

    await durableObject.fetch(
      new Request('https://tray.test/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 'tray-turn-test',
          createdAt: new Date(now).toISOString(),
          joinToken: 'join-token',
          controllerToken: 'controller-token',
          webhookToken: 'webhook-token',
        }),
      })
    );

    const leaderAttach = await durableObject.fetch(
      new Request('https://tray.test/controller/controller-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      })
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };
    const socketResponse = await durableObject.fetch(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
    );
    expect(socketResponse.status).toBe(101);

    const firstFollowerAttach = await durableObject.fetch(
      new Request('https://tray.test/join/join-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      })
    );
    const firstFollower = (await firstFollowerAttach.json()) as {
      iceServers?: Array<{ urls: string[]; username: string; credential: string }>;
    };
    expect(firstFollower.iceServers?.[1]).toMatchObject({
      urls: ['turn:turn-one.example.com:3478?transport=udp'],
      username: 'user-one',
      credential: 'cred-one',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 60_000;
    const secondFollowerAttach = await durableObject.fetch(
      new Request('https://tray.test/join/join-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-3', runtime: 'electron' }),
      })
    );
    const secondFollower = (await secondFollowerAttach.json()) as {
      iceServers?: Array<{ urls: string[]; username: string; credential: string }>;
    };
    expect(secondFollower.iceServers?.[1]).toMatchObject({
      urls: ['turn:turn-one.example.com:3478?transport=udp'],
      username: 'user-one',
      credential: 'cred-one',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += TURN_CREDENTIAL_TTL_MS;
    const refreshedFollowerAttach = await durableObject.fetch(
      new Request('https://tray.test/join/join-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-4', runtime: 'electron' }),
      })
    );
    const refreshedFollower = (await refreshedFollowerAttach.json()) as {
      iceServers?: Array<{ urls: string[]; username: string; credential: string }>;
    };
    expect(refreshedFollower.iceServers?.[1]).toMatchObject({
      urls: ['turn:turn-two.example.com:3478?transport=udp'],
      username: 'user-two',
      credential: 'cred-two',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('relays leader offers plus follower answers and ICE candidates over the bootstrap join path', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };
    const socketResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const clientSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      }),
      env
    );
    const follower = (await followerAttach.json()) as {
      result: { bootstrap: { bootstrapId: string } };
    };

    clientSocket.send(
      JSON.stringify({
        type: 'bootstrap.offer',
        controllerId: 'cone-2',
        bootstrapId: follower.result.bootstrap.bootstrapId,
        offer: { type: 'offer', sdp: 'offer-sdp' },
      })
    );
    clientSocket.send(
      JSON.stringify({
        type: 'bootstrap.ice_candidate',
        controllerId: 'cone-2',
        bootstrapId: follower.result.bootstrap.bootstrapId,
        candidate: { candidate: 'leader-candidate' },
      })
    );

    const polled = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'poll',
          controllerId: 'cone-2',
          bootstrapId: follower.result.bootstrap.bootstrapId,
          cursor: 0,
        }),
      }),
      env
    );
    expect(polled.status).toBe(200);
    await expect(polled.json()).resolves.toMatchObject({
      controllerId: 'cone-2',
      bootstrap: {
        bootstrapId: follower.result.bootstrap.bootstrapId,
        state: 'offered',
        cursor: 2,
      },
      events: [
        { type: 'bootstrap.offer', offer: { type: 'offer', sdp: 'offer-sdp' } },
        { type: 'bootstrap.ice_candidate', candidate: { candidate: 'leader-candidate' } },
      ],
    });

    const answered = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'answer',
          controllerId: 'cone-2',
          bootstrapId: follower.result.bootstrap.bootstrapId,
          answer: { type: 'answer', sdp: 'answer-sdp' },
        }),
      }),
      env
    );
    expect(answered.status).toBe(200);
    await expect(answered.json()).resolves.toMatchObject({
      bootstrap: { bootstrapId: follower.result.bootstrap.bootstrapId, state: 'connected' },
    });

    const followerIce = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'ice-candidate',
          controllerId: 'cone-2',
          bootstrapId: follower.result.bootstrap.bootstrapId,
          candidate: { candidate: 'follower-candidate' },
        }),
      }),
      env
    );
    expect(followerIce.status).toBe(200);

    expect(JSON.parse(clientSocket.received[2]!)).toMatchObject({
      type: 'bootstrap.answer',
      controllerId: 'cone-2',
      bootstrapId: follower.result.bootstrap.bootstrapId,
      answer: { type: 'answer', sdp: 'answer-sdp' },
    });
    expect(JSON.parse(clientSocket.received[3]!)).toMatchObject({
      type: 'bootstrap.ice_candidate',
      controllerId: 'cone-2',
      bootstrapId: follower.result.bootstrap.bootstrapId,
      candidate: { candidate: 'follower-candidate' },
    });
  });

  it('marks timed out bootstrap attempts as failed and requires explicit retries', async () => {
    const { env, advance } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };
    const socketResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const clientSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      }),
      env
    );
    const follower = (await followerAttach.json()) as {
      result: { bootstrap: { bootstrapId: string } };
    };

    advance(TRAY_BOOTSTRAP_TIMEOUT_MS + 1);
    const timedOut = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'poll',
          controllerId: 'cone-2',
          bootstrapId: follower.result.bootstrap.bootstrapId,
          cursor: 0,
        }),
      }),
      env
    );
    expect(timedOut.status).toBe(200);
    await expect(timedOut.json()).resolves.toMatchObject({
      bootstrap: {
        bootstrapId: follower.result.bootstrap.bootstrapId,
        state: 'failed',
        failure: {
          code: 'BOOTSTRAP_TIMEOUT',
          retryable: true,
          retryAfterMs: FOLLOWER_ATTACH_RETRY_AFTER_MS,
        },
      },
      events: [{ type: 'bootstrap.failed', failure: { code: 'BOOTSTRAP_TIMEOUT' } }],
    });

    const retried = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'retry',
          controllerId: 'cone-2',
          bootstrapId: follower.result.bootstrap.bootstrapId,
          runtime: 'electron',
        }),
      }),
      env
    );
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as {
      bootstrap: { bootstrapId: string; attempt: number; retriesRemaining: number; state: string };
    };
    expect(retriedBody.bootstrap).toMatchObject({
      attempt: 2,
      retriesRemaining: 2,
      state: 'pending',
    });
    expect(retriedBody.bootstrap.bootstrapId).not.toBe(follower.result.bootstrap.bootstrapId);
    expect(JSON.parse(clientSocket.received[2]!)).toMatchObject({
      type: 'follower.join_requested',
      controllerId: 'cone-2',
      bootstrapId: retriedBody.bootstrap.bootstrapId,
      attempt: 2,
    });
  });

  it('returns an explicit fail instruction when a follower attaches to an expired tray', async () => {
    const { env, advance } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await attach.json()) as { websocket: { url: string } };
    const socketResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const clientSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
    clientSocket.close();

    advance(TRAY_RECLAIM_TTL_MS + 1);
    const expiredAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1', runtime: 'electron' }),
      }),
      env
    );

    expect(expiredAttach.status).toBe(410);
    await expect(expiredAttach.json()).resolves.toMatchObject({
      trayId: expect.any(String),
      controllerId: 'follow-1',
      role: 'follower',
      result: {
        action: 'fail',
        code: 'TRAY_EXPIRED',
        error: 'Tray expired because the leader did not reclaim it within one hour',
      },
    });
  });

  it('allows only the leader to open the tray WebSocket', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { leaderKey: string; websocket: { url: string } };

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.join.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1' }),
      }),
      env
    );
    const follower = (await followerAttach.json()) as { controllerId: string };

    const denied = await handleWorkerRequest(
      new Request(
        `${session.capabilities.controller.url}?controllerId=${follower.controllerId}&leaderKey=wrong`,
        {
          headers: { Upgrade: 'websocket' },
        }
      ),
      env
    );
    expect(denied.status).toBe(403);

    const accepted = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(accepted.status).toBe(101);
    const socket = (accepted as unknown as { webSocket: FakeWebSocket }).webSocket;
    expect(socket).toBeDefined();
    expect(socket.received[0]).toContain('leader.connected');
  });

  it('rejects webhooks without a live leader and does not buffer payload state', async () => {
    const { env, readTray } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };

    await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );

    const rejected = await handleWorkerRequest(
      new Request(`${session.capabilities.webhook.url}/test-webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env
    );

    expect(rejected.status).toBe(410);
    const tray = await readTray(session.trayId);
    expect(tray?.leader?.connected).toBe(false);
    expect(Object.keys(tray ?? {})).not.toContain('pendingWebhooks');
  });

  it('returns 400 when webhook POST has no webhookId suffix', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };

    // Attach leader and connect WebSocket
    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };
    await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );

    const rejected = await handleWorkerRequest(
      new Request(session.capabilities.webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env
    );

    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { code: string };
    expect(body.code).toBe('WEBHOOK_ID_REQUIRED');
  });

  it('forwards webhook POST to the live leader via the control WebSocket', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };

    // Attach leader and connect WebSocket
    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };
    const wsResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const socket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    // POST webhook with a webhookId
    const webhookResponse = await handleWorkerRequest(
      new Request(`${session.capabilities.webhook.url}/my-webhook-123`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'opened', repo: 'test/repo' }),
      }),
      env
    );

    expect(webhookResponse.status).toBe(202);
    const webhookBody = (await webhookResponse.json()) as { ok: boolean; accepted: boolean };
    expect(webhookBody.ok).toBe(true);
    expect(webhookBody.accepted).toBe(true);

    // Verify the leader WebSocket received the webhook event
    // socket.received includes the initial leader.connected message + the webhook.event
    const webhookMessages = socket.received
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((msg) => msg.type === 'webhook.event');
    expect(webhookMessages).toHaveLength(1);
    const forwarded = webhookMessages[0] as {
      type: string;
      webhookId: string;
      headers: Record<string, string>;
      body: unknown;
      timestamp: string;
    };
    expect(forwarded.webhookId).toBe('my-webhook-123');
    expect(forwarded.body).toEqual({ action: 'opened', repo: 'test/repo' });
    expect(forwarded.timestamp).toBeDefined();
    expect(forwarded.headers['content-type']).toBe('application/json');
  });

  it('returns 403 for invalid webhook capability token', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { webhook: { url: string } };
    };

    // Use the correct trayId but a wrong secret to get routed to the right DO
    const rejected = await handleWorkerRequest(
      new Request(`https://tray.test/webhook/${session.trayId}.wrongsecret/wh123`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env
    );

    expect(rejected.status).toBe(403);
    const body = (await rejected.json()) as { code: string };
    expect(body.code).toBe('INVALID_WEBHOOK_CAPABILITY');
  });

  it('wraps non-JSON webhook body in a raw field', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };

    // Attach leader and connect WebSocket
    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };
    const wsResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const socket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    // POST webhook with plain text body
    const webhookResponse = await handleWorkerRequest(
      new Request(`${session.capabilities.webhook.url}/text-wh`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'Hello, plain text webhook!',
      }),
      env
    );

    expect(webhookResponse.status).toBe(202);

    const webhookMessages = socket.received
      .map((raw) => JSON.parse(raw) as { type: string })
      .filter((msg) => msg.type === 'webhook.event');
    expect(webhookMessages).toHaveLength(1);
    const forwarded = webhookMessages[0] as unknown as { body: unknown };
    expect(forwarded.body).toEqual({ raw: 'Hello, plain text webhook!' });
  });

  it('supports leader reconnect with the issued key and expires after one hour without reclaim', async () => {
    const { env, advance } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { capabilities: { controller: { url: string } } };

    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );
    const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };

    const wsResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const clientSocket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
    clientSocket.close();

    const reclaim = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-2', leaderKey: leader.leaderKey }),
      }),
      env
    );
    const reclaimBody = (await reclaim.json()) as {
      role: string;
      leader: { controllerId: string; connected: boolean };
    };
    expect(reclaimBody.role).toBe('leader');
    expect(reclaimBody.leader.controllerId).toBe('lead-2');

    const reclaimedSocketResponse = await handleWorkerRequest(
      new Request(
        `${session.capabilities.controller.url}?controllerId=lead-2&leaderKey=${leader.leaderKey}`,
        {
          headers: { Upgrade: 'websocket' },
        }
      ),
      env
    );
    const reclaimedClientSocket = (
      reclaimedSocketResponse as unknown as { webSocket: FakeWebSocket }
    ).webSocket;
    reclaimedClientSocket.close();

    advance(TRAY_RECLAIM_TTL_MS + 1);
    const expired = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-3' }),
      }),
      env
    );
    expect(expired.status).toBe(410);
  });

  it('advertises /tray as the only create route in service metadata', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://tray.test/?json=true'), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      routes: [
        'POST /tray',
        'GET /download/slicc.dmg',
        'GET /handoff',
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'GET /auth/callback',
        'POST /oauth/token',
        'POST /oauth/revoke',
        'GET /api/runtime-config',
        'ANY /api/fetch-proxy',
      ],
    });
  });

  it('redirects bare apex sliccy.ai to www.sliccy.ai at handleWorkerRequest level', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://sliccy.ai/'), env);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://www.sliccy.ai/');
  });

  it('redirects apex sliccy.ai to www.sliccy.ai with 301 preserving path and query', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://sliccy.ai/some/path?q=1'), env);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://www.sliccy.ai/some/path?q=1');
  });

  it('does not redirect www.sliccy.ai with query params', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/?json=true'),
      env
    );
    expect(response.status).toBe(200);
  });

  it('does not redirect www.sliccy.ai with a path', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/some/path'), env);
    expect(response.status).toBe(200);
  });

  it('does not redirect www.sliccy.ai/handoff', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/handoff'), env);
    expect(response.status).toBe(200);
  });

  it('serves the handoff page without x-slicc header when msg is absent', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/handoff'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('x-slicc')).toBeNull();
    const html = await response.text();
    expect(html).toContain('SLICC handoff');
  });

  it('percent-encodes the msg into the x-slicc header', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request(
        'https://www.sliccy.ai/handoff?msg=upskill%3Ahttps%3A%2F%2Fgithub.com%2Ffoo%2Fbar'
      ),
      env
    );
    expect(response.status).toBe(200);
    // encodeURIComponent preserves ':' and '/' as unreserved-for-components.
    expect(response.headers.get('x-slicc')).toBe('upskill%3Ahttps%3A%2F%2Fgithub.com%2Ffoo%2Fbar');
  });

  it('survives non-Latin1 msg values (emoji, CJK) instead of throwing', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?msg=handoff%3A%F0%9F%9A%80%20%E4%BD%A0%E5%A5%BD'),
      env
    );
    expect(response.status).toBe(200);
    const header = response.headers.get('x-slicc');
    expect(header).toBeTruthy();
    expect(decodeURIComponent(header!)).toBe('handoff:🚀 你好');
  });

  it('neutralises CR/LF header injection attempts', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?msg=handoff%3Afoo%0D%0AX-Injected%3A+bar'),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Injected')).toBeNull();
    // The CRLF bytes are percent-encoded inside the value, not split into
    // a new header line.
    expect(response.headers.get('x-slicc')).toBe('handoff%3Afoo%0D%0AX-Injected%3A%20bar');
  });
});

describe('wantsJSON', () => {
  it('returns true when ?json=true is present', () => {
    const req = new Request('https://example.com/join/token?json=true');
    expect(wantsJSON(req)).toBe(true);
  });

  it('returns false when ?json is absent', () => {
    const req = new Request('https://example.com/join/token');
    expect(wantsJSON(req)).toBe(false);
  });

  it('returns false when ?json has other value', () => {
    const req = new Request('https://example.com/?json=false');
    expect(wantsJSON(req)).toBe(false);
  });
});

describe('browser routing', () => {
  it('serves SPA for plain GET requests to /', async () => {
    const { env } = createTestHarness();
    const req = new Request('https://example.com/');
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves SPA for plain GET requests to /join/:token', async () => {
    const { env } = createTestHarness();
    const trayRes = await handleWorkerRequest(
      new Request('https://example.com/tray', { method: 'POST' }),
      env
    );
    const tray = (await trayRes.json()) as {
      capabilities: { join: { token: string } };
    };
    const joinToken = tray.capabilities.join.token;

    const req = new Request(`https://example.com/join/${joinToken}`);
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves JSON API for requests to /join/:token with ?json=true', async () => {
    const { env } = createTestHarness();
    const trayRes = await handleWorkerRequest(
      new Request('https://example.com/tray', { method: 'POST' }),
      env
    );
    const tray = (await trayRes.json()) as {
      capabilities: { join: { url: string } };
    };

    const req = new Request(`${tray.capabilities.join.url}?json=true`);
    const res = await handleWorkerRequest(req, env);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('serves SPA for plain GET requests to unknown paths', async () => {
    const { env } = createTestHarness();
    const req = new Request('https://example.com/some/random/path');
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves JSON service info for requests to unknown paths with ?json=true', async () => {
    const { env } = createTestHarness();
    const req = new Request('https://example.com/some/random/path?json=true');
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe('slicc-tray-hub');
  });
});

describe('generic OAuth token broker', () => {
  function oauthEnv() {
    return {
      ...createTestHarness().env,
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
    };
  }

  it('exchanges an authorization code for tokens via POST /oauth/token', async () => {
    const env = oauthEnv();
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_test_token_123',
          token_type: 'bearer',
          scope: 'repo,read:user',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'github',
          code: 'test-auth-code',
          redirect_uri: 'https://www.sliccy.ai/auth/callback',
        }),
      }),
      env,
      mockFetch
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    expect(body.access_token).toBe('gho_test_token_123');
    expect(body.token_type).toBe('bearer');
    expect(body.scope).toBe('repo,read:user');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0]!;
    expect(fetchUrl).toBe('https://github.com/login/oauth/access_token');
    expect(fetchInit?.method).toBe('POST');
    expect(fetchInit?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    });
  });

  it('returns 400 for unknown provider', async () => {
    const env = oauthEnv();
    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'nonexistent', code: 'abc' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('unknown_provider');
  });

  it('returns 501 when provider secrets are not configured', async () => {
    const env = createTestHarness().env; // no GITHUB_CLIENT_ID/SECRET
    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', code: 'abc' }),
      }),
      env
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('server_error');
  });

  it('forwards upstream error responses from the token endpoint', async () => {
    const env = oauthEnv();
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', code: 'expired-code' }),
      }),
      env,
      mockFetch
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('bad_verification_code');
  });

  it('returns CORS headers on POST and OPTIONS preflight', async () => {
    const env = oauthEnv();
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
      );

    // OPTIONS preflight
    const preflight = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5710' },
      }),
      env
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBeTruthy();
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    // POST should also have CORS
    const post = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: 'http://localhost:5710' },
        body: JSON.stringify({ provider: 'github', code: 'abc' }),
      }),
      env,
      mockFetch
    );
    expect(post.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('returns 405 with CORS and Allow headers for non-POST requests to /oauth/token', async () => {
    const env = oauthEnv();
    const response = await handleWorkerRequest(new Request('https://tray.test/oauth/token'), env);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('POST');
    expect(response.headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('revokes a token via POST /oauth/revoke (delete-basic method)', async () => {
    const env = oauthEnv();
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', access_token: 'gho_token_to_revoke' }),
      }),
      env,
      mockFetch
    );

    expect(response.status).toBe(204);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0]!;
    expect(fetchUrl).toBe('https://api.github.com/applications/test-client-id/token');
    expect(fetchInit?.method).toBe('DELETE');
    expect(fetchInit?.headers).toMatchObject({
      Authorization: `Basic ${btoa('test-client-id:test-client-secret')}`,
    });
  });

  it('returns 400 for missing provider field', async () => {
    const env = oauthEnv();
    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'abc' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 400 for missing code field', async () => {
    const env = oauthEnv();
    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github' }),
      }),
      env
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });
});

describe('API routes', () => {
  it('returns runtime config with worker base URL and OAuth client IDs', async () => {
    const env = { ...createTestHarness().env, GITHUB_CLIENT_ID: 'test-gh-id' };
    const req = new Request('https://www.sliccy.ai/api/runtime-config');
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trayWorkerBaseUrl: string;
      oauth: { github?: string };
    };
    expect(body.trayWorkerBaseUrl).toBe('https://www.sliccy.ai');
    expect(body.oauth.github).toBe('test-gh-id');
  });

  it('returns 404 for fetch-proxy', async () => {
    const { env } = createTestHarness();
    const req = new Request('https://www.sliccy.ai/api/fetch-proxy', { method: 'POST' });
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not available');
  });
});

describe('X-Robots-Tag header', () => {
  it('does NOT add x-robots-tag to root sliccy.ai redirect', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://sliccy.ai/'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://www.sliccy.com/');
    expect(res.headers.has('x-robots-tag')).toBe(false);
  });

  it('does NOT add x-robots-tag to root www.sliccy.ai redirect', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://www.sliccy.ai/'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://www.sliccy.com/');
    expect(res.headers.has('x-robots-tag')).toBe(false);
  });

  it('adds x-robots-tag: noindex to non-root sliccy.ai redirect', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://sliccy.ai/some/path?q=1'), env);
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('https://www.sliccy.ai/some/path?q=1');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('adds x-robots-tag: noindex to SPA fallback', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://www.sliccy.ai/some/path'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('adds x-robots-tag: noindex to handoff page', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://www.sliccy.ai/handoff'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('adds x-robots-tag: noindex to API routes', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://www.sliccy.ai/api/runtime-config'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('adds x-robots-tag: noindex to tray POST', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('does NOT add x-robots-tag to WebSocket upgrade (101) responses', async () => {
    const { env } = createTestHarness();
    const created = await worker.fetch(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string } };
    };

    const leaderAttach = await worker.fetch(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-ws-test', runtime: 'cli' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };

    const wsResponse = await worker.fetch(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(wsResponse.status).toBe(101);
    expect(wsResponse.headers.has('x-robots-tag')).toBe(false);
    expect((wsResponse as unknown as { webSocket: unknown }).webSocket).toBeDefined();
  });
});
