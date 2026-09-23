import {
  buildPreviewUrl,
  GITHUB_RELEASES_MAX_PAGES,
  GITHUB_RELEASES_PER_PAGE,
  TRAY_BOOTSTRAP_TIMEOUT_MS,
} from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, {
  buildKnownGoodDmgUrl,
  capabilityCorsHeaders,
  compareReleaseVersions,
  handleDmgDownload,
  handleWorkerRequest,
  parseAllowedCapabilityOrigins,
  resolveCherryFrameAncestors,
  type WorkerEnv,
} from '../src/index.js';
import knownGoodMacos from '../src/known-good-macos.json';
import { previewTokenFromHost } from '../src/preview-host.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import {
  type CreateTrayRequest,
  type DurableObjectIdLike,
  FOLLOWER_ATTACH_RETRY_AFTER_MS,
  HOSTED_TRAY_RECLAIM_TTL_MS,
  reclaimMsForTray,
  TRAY_RECLAIM_TTL_MS,
  type TrayRecord,
  wantsJSON,
} from '../src/shared.js';
import { TURN_CREDENTIAL_TTL_MS } from '../src/turn-credentials.js';
import { WebhookHomeDurableObject } from '../src/webhook-home.js';
import {
  createFakeWebSocketPair,
  FakeDurableObjectState,
  type FakeWebSocket,
} from './fake-do-state.js';
import { makeEnv } from './helpers/fake-env.js';

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
        {
          now: this.now,
          webSocketPairFactory: createFakeWebSocketPair,

          webhookDeliveryWaitMs: 500,
        }
      );
      state.instance = instance;
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

class FakeHomeNamespace {
  private readonly instances = new Map<string, WebhookHomeDurableObject>();

  async alarm(coneId: string): Promise<void> {
    await this.instances.get(coneId)?.alarm();
  }

  constructor(
    private readonly now: () => number,
    private readonly trayNamespace: FakeNamespace
  ) {}

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
      instance = new WebhookHomeDurableObject(
        state,
        {
          TRAY_HUB: this.trayNamespace as unknown as {
            idFromName(n: string): { toString(): string };
            get(i: { toString(): string }): {
              fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
            };
          },
        },
        { now: this.now }
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
}

const MOCK_HTML = '<html><body>SPA</body></html>';
const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response(MOCK_HTML, {
      headers: { 'content-type': 'text/html' },
    }),
};

const fakeCloudSessions = {
  idFromName: (_name: string) => ({ toString: () => 'fake-cloud-id' }),
  idFromString: (_id: string) => ({ toString: () => 'fake-cloud-id' }),
  newUniqueId: () => ({ toString: () => 'fake-cloud-id' }),
  get: (_id: unknown) => ({
    fetch: async (_req: Request) => new Response('cloud DO not stubbed', { status: 501 }),
  }),
};

function createTestHarness(start = Date.parse('2026-03-11T00:00:00.000Z')): {
  env: ReturnType<typeof makeEnv>;
  advance: (ms: number) => void;
  readTray: (trayId: string) => Promise<TrayRecord | undefined>;
  alarmHome: (coneId: string) => Promise<void>;
} {
  let now = start;
  const namespace = new FakeNamespace(() => now);
  const homeNamespace = new FakeHomeNamespace(() => now, namespace);
  return {
    env: makeEnv({
      TRAY_HUB: namespace,
      WEBHOOK_HOMES: homeNamespace as unknown as WorkerEnv['WEBHOOK_HOMES'],
      ASSETS: fakeAssets,
      CLOUD_SESSIONS: fakeCloudSessions,
    }),
    advance: (ms: number) => {
      now += ms;
    },
    readTray: (trayId: string) => namespace.readTray(trayId),
    alarmHome: (coneId: string) => homeNamespace.alarm(coneId),
  };
}

function stableCreateIdentity() {
  return {
    coneId: 'persistent-cone',
    coneSecret: 'delivery',
    rebindSecret: 'management',
    createAttemptId: crypto.randomUUID(),
  };
}

describe('tray worker skeleton', () => {
  it('keeps idempotent tray IDs compatible with preview DNS token routing', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://tray.test/tray', {
        method: 'POST',
        body: JSON.stringify(stableCreateIdentity()),
      }),
      env
    );
    expect(response.status).toBe(201);
    const { trayId } = (await response.json()) as { trayId: string };
    const token = `${trayId}.${'a'.repeat(20)}`;
    const preview = new URL(buildPreviewUrl('http://localhost:8787', token, '/'));
    expect(preview.hostname.split('.')[0].length).toBeLessThanOrEqual(63);
    expect(previewTokenFromHost(preview.host)?.token).toBe(token);
  });

  it.each([403, 429, 503])('retries a stable home bind failure (%s)', async (status) => {
    const { env } = createTestHarness();
    const get = env.WEBHOOK_HOMES.get.bind(env.WEBHOOK_HOMES);
    const stubSpy = vi.spyOn(env.WEBHOOK_HOMES, 'get').mockImplementation((id) => {
      const stub = get(id);
      vi.spyOn(stub, 'fetch').mockResolvedValue(new Response('unavailable', { status }));
      return stub;
    });
    const identity = stableCreateIdentity();
    const trayIds = vi.spyOn(env.TRAY_HUB, 'idFromName');
    const create = () =>
      handleWorkerRequest(
        new Request('https://tray.test/tray', {
          method: 'POST',
          body: JSON.stringify(identity),
        }),
        env
      );
    const failed = await create();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'WEBHOOK_HOME_BIND_FAILED' });
    expect((await create()).status).toBe(503);
    stubSpy.mockRestore();
    const retried = await create();
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({
      coneId: identity.coneId,
      capabilities: { webhook: { url: 'https://tray.test/wh/persistent-cone.delivery' } },
    });
    expect(new Set(trayIds.mock.calls.map(([id]) => id)).size).toBe(1);
  });

  it('replays a lost create response but gives deliberate reset a new tray', async () => {
    const { env, readTray } = createTestHarness();
    const identity = stableCreateIdentity();
    const create = (createAttemptId = identity.createAttemptId) =>
      handleWorkerRequest(
        new Request('https://tray.test/tray', {
          method: 'POST',
          body: JSON.stringify({ ...identity, createAttemptId }),
        }),
        env
      );
    const original = (await (await create()).json()) as {
      trayId: string;
      capabilities: { controller: { token: string }; webhook: { url: string } };
    };
    expect(await (await create()).json()).toEqual(original);
    const concurrent = await Promise.all([create(), create()]);
    expect(await concurrent[0]!.json()).toEqual(original);
    expect(await concurrent[1]!.json()).toEqual(original);
    const reset = (await (await create(crypto.randomUUID())).json()) as typeof original;
    expect(reset.trayId).not.toBe(original.trayId);
    expect(reset.capabilities.webhook).toEqual(original.capabilities.webhook);
    expect(await readTray(original.trayId)).toMatchObject({
      controllerToken: original.capabilities.controller.token,
    });
  });

  it('does not disclose an existing attempt to a caller with the wrong rebind secret', async () => {
    const { env } = createTestHarness();
    const identity = stableCreateIdentity();
    const create = (rebindSecret: string) =>
      handleWorkerRequest(
        new Request('https://tray.test/tray', {
          method: 'POST',
          body: JSON.stringify({ ...identity, rebindSecret }),
        }),
        env
      );
    expect((await create(identity.rebindSecret)).status).toBe(201);
    const trayIds = vi.spyOn(env.TRAY_HUB, 'idFromName');
    const denied = await create('wrong-secret');
    expect(denied.status).toBe(503);
    expect(await denied.json()).not.toHaveProperty('capabilities');
    expect((await create('wrong-secret')).status).toBe(503);
    expect(new Set(trayIds.mock.calls.map(([id]) => id)).size).toBe(1);
  });

  it.each([
    { coneId: 'dotted.id' },
    { coneSecret: 'dotted.secret' },
    { rebindSecret: 'dotted.secret' },
    { coneSecret: 'bad/secret' },
    { coneSecret: 'bad?secret' },
    { createAttemptId: undefined },
    { createAttemptId: 'too-short' },
  ])('rejects invalid stable capability grammar before creating a tray: %j', async (override) => {
    const { env } = createTestHarness();
    const get = vi.spyOn(env.TRAY_HUB, 'get');
    const response = await handleWorkerRequest(
      new Request('https://tray.test/tray', {
        method: 'POST',
        body: JSON.stringify({ ...stableCreateIdentity(), ...override }),
      }),
      env
    );
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '{}', '{"kind":"hosted"}'])(
    'keeps identity-less clients independent of webhook home availability (%s)',
    async (body) => {
      const { env } = createTestHarness();
      const home = vi.spyOn(env.WEBHOOK_HOMES, 'get').mockImplementation(() => {
        throw new Error('home unavailable');
      });
      const response = await handleWorkerRequest(
        new Request('https://tray.test/tray', { method: 'POST', body }),
        env
      );
      expect(response.status).toBe(201);
      const session = (await response.json()) as {
        trayId: string;
        capabilities: { webhook: { url: string } };
      };
      expect(session.capabilities.webhook.url).toContain(`/webhook/${session.trayId}.`);
      expect(session.capabilities.webhook).not.toHaveProperty('rebindToken');
      expect(session).not.toHaveProperty('coneId');
      expect(home).not.toHaveBeenCalled();
    }
  );

  it('creates a tray at /tray and rejects removed create aliases', async () => {
    const { env } = createTestHarness();

    const response = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      trayId: string;
      coneId: string;
      capabilities: {
        join: { url: string };
        controller: { url: string };
        webhook: { url: string; rebindToken?: string };
      };
    };
    expect(body.capabilities.join.url).toContain(`/join/${body.trayId}.`);
    expect(body.capabilities.controller.url).toContain(`/controller/${body.trayId}.`);
    expect(body.coneId).toBeUndefined();
    expect(body.capabilities.webhook.url).toContain(`/webhook/${body.trayId}.`);
    expect(body.capabilities.webhook.rebindToken).toBeUndefined();

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

  it('never emits a wildcard CORS origin on join capability responses', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { join: { url: string } };
    };

    const preflight = await handleWorkerRequest(
      new Request(session.capabilities.join.url, { method: 'OPTIONS' }),
      env
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    const probe = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`),
      env
    );
    expect(probe.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(probe.headers.get('access-control-allow-origin')).toBeNull();

    const attach = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cors-test', runtime: 'test' }),
      }),
      env
    );
    expect(attach.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(attach.headers.get('access-control-allow-origin')).toBeNull();
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

    const doState = new FakeDurableObjectState();
    const durableObject = new SessionTrayDurableObject(
      doState,
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

    const tray = await doState.storage.get<{ leader?: { lastSeenAt: string } }>('tray');
    if (tray?.leader) {
      tray.leader.lastSeenAt = new Date(now).toISOString();
      await doState.storage.put('tray', tray);
    }
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
        error: 'Tray expired because the leader did not reclaim it in time',
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

  it('accepts the elected leader reconnecting over a stale/ghost socket instead of 409', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string } };
    };
    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1' }),
      }),
      env
    );
    const leader = (await leaderAttach.json()) as { websocket: { url: string } };

    const first = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(first.status).toBe(101);

    const reconnect = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    expect(reconnect.status).toBe(101);
    const socket = (reconnect as unknown as { webSocket: FakeWebSocket }).webSocket;
    expect(socket.received[0]).toContain('leader.connected');
  });

  it('queues a stable webhook delivery when no leader is connected, without buffering on the tray', async () => {
    const { env, readTray, alarmHome } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', {
        method: 'POST',
        body: JSON.stringify(stableCreateIdentity()),
      }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };

    const attached = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env
    );

    const queued = await handleWorkerRequest(
      new Request(`${session.capabilities.webhook.url}/test-webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env
    );

    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      accepted: true,
      queued: true,
    });
    const tray = await readTray(session.trayId);
    expect(tray?.leader?.connected).toBe(false);

    expect(Object.keys(tray ?? {})).not.toContain('pendingWebhooks');
    expect(Object.keys(tray ?? {})).not.toContain('queue');

    const leader = (await attached.json()) as { websocket: { url: string } };
    const connected = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const socket = (connected as unknown as { webSocket: FakeWebSocket }).webSocket;
    const coneId = session.capabilities.webhook.url.split('/wh/')[1]!.split('.')[0]!;
    const replay = alarmHome(coneId);
    await vi.waitFor(() =>
      expect(socket.received.some((raw) => raw.includes('"webhook.event"'))).toBe(true)
    );
    const event = socket.received
      .map((raw) => JSON.parse(raw) as { type: string; deliveryId?: string })
      .find((message) => message.type === 'webhook.event');
    socket.send(
      JSON.stringify({
        type: 'webhook.delivery',
        deliveryId: event!.deliveryId,
        disposition: 'delivered',
      })
    );
    await replay;
    const count = socket.received.length;
    await alarmHome(coneId);
    expect(socket.received).toHaveLength(count);
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

  describe('webhook receipt follows the leader disposition (#2524)', () => {
    async function connectLeader(env: ReturnType<typeof makeEnv>) {
      const created = await handleWorkerRequest(
        new Request('https://tray.test/tray', {
          method: 'POST',
          body: JSON.stringify(stableCreateIdentity()),
        }),
        env
      );
      const session = (await created.json()) as {
        capabilities: { controller: { url: string }; webhook: { url: string } };
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
      const wsResponse = await handleWorkerRequest(
        new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
        env
      );
      return {
        socket: (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket,
        webhookUrl: session.capabilities.webhook.url,
      };
    }

    async function postAndAck(disposition: string): Promise<Response> {
      const { env } = createTestHarness();
      const { socket, webhookUrl } = await connectLeader(env);
      const pending = handleWorkerRequest(
        new Request(`${webhookUrl}/wh-ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probe: 1 }),
        }),
        env
      );
      await vi.waitFor(() => {
        expect(
          socket.received.map((raw) => JSON.parse(raw) as { type: string; deliveryId?: string })
        ).toContainEqual(expect.objectContaining({ type: 'webhook.event' }));
      });
      const event = socket.received
        .map((raw) => JSON.parse(raw) as { type: string; deliveryId?: string })
        .find((m) => m.type === 'webhook.event');
      expect(event?.deliveryId).toBeTruthy();
      socket.send(
        JSON.stringify({ type: 'webhook.delivery', deliveryId: event?.deliveryId, disposition })
      );
      return pending;
    }

    it('durably queues an unresolvable target until it can be repaired', async () => {
      const response = await postAndAck('unresolved-target');
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        accepted: true,
        queued: true,
      });
    });

    it('keeps an unregistered event queued rather than silently dropping it', async () => {
      const response = await postAndAck('unknown-webhook');
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, queued: true });
    });

    it.each(['delivered', 'filtered'])('keeps 202 for a %s delivery', async (disposition) => {
      const response = await postAndAck(disposition);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, accepted: true, queued: false });
    });

    it('keeps the event queued when the leader never reports a disposition', async () => {
      const { env } = createTestHarness();
      const { webhookUrl } = await connectLeader(env);
      const response = await handleWorkerRequest(
        new Request(`${webhookUrl}/wh-silent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ probe: 1 }),
        }),
        env
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, accepted: true, queued: true });
    });
  });

  it('strips forged x-slicc-preview-* headers from a webhook POST (attribution cannot be spoofed)', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string }; webhook: { url: string } };
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
    const wsResponse = await handleWorkerRequest(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
      env
    );
    const socket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

    await handleWorkerRequest(
      new Request(`${session.capabilities.webhook.url}/wh-1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-slicc-preview-conn': 'forged-conn',
          'x-slicc-preview-token': 'victim.token',
        },
        body: JSON.stringify({ hi: 1 }),
      }),
      env
    );

    const forwarded = socket.received
      .map((raw) => JSON.parse(raw) as { type: string; headers?: Record<string, string> })
      .find((m) => m.type === 'webhook.event');
    expect(forwarded).toBeDefined();
    expect(forwarded!.headers?.['x-slicc-preview-conn']).toBeUndefined();
    expect(forwarded!.headers?.['x-slicc-preview-token']).toBeUndefined();
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
        'GET /install-cli',
        'GET /install-cli.ps1',
        'GET /download/slicc-cli/:target',
        'GET /handoff',
        'GET /.well-known/api-catalog',
        'GET /.well-known/apple-app-site-association',
        'GET /privacy',
        'GET /llms.txt',
        'GET /status',
        'GET /rel/:name',
        'GET|POST /join/:token',
        'GET|POST /controller/:token',
        'POST /webhook/:token/:webhookId',
        'POST /wh/:token/:webhookId',
        'POST /api/tray/:trayId/preview',
        'PUT /api/tray/:trayId/preview/:previewToken/file',
        'POST /api/tray/:trayId/preview/:previewToken/finalize',
        'POST /api/tray/:trayId/preview/stop',
        'GET /api/tray/:trayId/previews',
        'POST /api/tray/:trayId/preview-transfer',
        'POST /api/tray/:trayId/biscotto',
        'POST /api/tray/:trayId/biscotto/stop',
        'GET /api/tray/:trayId/biscotti',
        'POST /api/tray/:trayId/supersede',
        'POST /api/tray/:trayId/webhook/rotate',
        'POST /webhooks/:coneId/:webhookId/revoke',
        'GET /auth/callback',
        'GET /auth/mcp-callback',
        'POST /oauth/token',
        'POST /oauth/revoke',
        'GET /api/runtime-config',
        'GET /api/flags',
        'GET /api/models/providers/:id',
        'ANY /api/fetch-proxy',
        'GET /api/cloud/config',
        'POST /api/cloud/start',
        'GET /api/cloud/list',
        'POST /api/cloud/pause',
        'POST /api/cloud/resume',
        'POST /api/cloud/kill',
        'GET /api/cloud/cone-config',
        'POST /api/cloud/sign-out',
        'GET /api/cloud/admin/stats',
        'GET /auth/cloud-callback',
        'GET /auth/cloud-callback.js',
        'GET /cloud',
        'GET /cloud/*',
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

  it('serves the handoff page without a Link header when no payload is provided', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/handoff'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Link')).toBeNull();
    expect(response.headers.get('x-slicc')).toBeNull();
    const html = await response.text();
    expect(html).toContain('SLICC handoff');
  });

  it('emits an upskill rel Link when ?upskill=<github-url> is provided', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?upskill=https%3A%2F%2Fgithub.com%2Ffoo%2Fbar'),
      env
    );
    expect(response.status).toBe(200);
    const link = response.headers.get('Link');
    expect(link).toBe('<https://github.com/foo/bar>; rel="https://www.sliccy.ai/rel/upskill"');

    expect(response.headers.get('x-slicc')).toBeNull();
  });

  it('emits a handoff rel Link with title* when ?handoff=<text> is provided', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?handoff=Continue%20the%20signup%20flow'),
      env
    );
    expect(response.status).toBe(200);
    const link = response.headers.get('Link');
    expect(link).toBe(
      '<>; rel="https://www.sliccy.ai/rel/handoff"; title*=UTF-8\'\'Continue%20the%20signup%20flow'
    );
  });

  it('handles non-Latin1 handoff payloads via RFC 8187 title*', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?handoff=%F0%9F%9A%80%20%E4%BD%A0%E5%A5%BD'),
      env
    );
    expect(response.status).toBe(200);
    const link = response.headers.get('Link');
    expect(link).toBeTruthy();
    expect(link).toContain('rel="https://www.sliccy.ai/rel/handoff"');

    expect(link).toContain('%F0%9F%9A%80');
    expect(link).toContain('%E4%BD%A0%E5%A5%BD');
  });

  it('neutralises CR/LF header-injection attempts in the handoff payload', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?handoff=foo%0D%0AX-Injected%3A+bar'),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Injected')).toBeNull();
    const link = response.headers.get('Link');

    expect(link).toContain('%0D%0A');
    expect(link).not.toContain('\r');
    expect(link).not.toContain('\n');
  });

  it('parses the legacy ?msg=verb:payload shape into the new Link form', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request(
        'https://www.sliccy.ai/handoff?msg=upskill%3Ahttps%3A%2F%2Fgithub.com%2Ffoo%2Fbar'
      ),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Link')).toBe(
      '<https://github.com/foo/bar>; rel="https://www.sliccy.ai/rel/upskill"'
    );
  });

  it('rejects upskill payloads that are not parseable URLs', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?upskill=not-a-url'),
      env
    );
    expect(response.status).toBe(200);

    const links = response.headers.get('Link') ?? '';
    expect(links).not.toContain('https://www.sliccy.ai/rel/upskill');
    expect(links).not.toContain('https://www.sliccy.ai/rel/handoff');
  });

  it('rejects upskill payloads on non-https schemes', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?upskill=http%3A%2F%2Fgithub.com%2Ffoo%2Fbar'),
      env
    );
    const links = response.headers.get('Link') ?? '';
    expect(links).not.toContain('https://www.sliccy.ai/rel/upskill');
  });

  it('rejects upskill payloads outside github.com', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/handoff?upskill=https%3A%2F%2Fattacker.example%2Frepo'),
      env
    );
    const links = response.headers.get('Link') ?? '';
    expect(links).not.toContain('https://www.sliccy.ai/rel/upskill');
  });

  it('neutralises CR/LF / >-injection attempts in the upskill payload', async () => {
    const { env } = createTestHarness();

    const response = await handleWorkerRequest(
      new Request(
        'https://www.sliccy.ai/handoff?upskill=https%3A%2F%2Fgithub.com%2Ffoo%0D%0AX-Injected%3A+bar%2F%3E%3Cevil'
      ),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Injected')).toBeNull();
    const link = response.headers.get('Link') ?? '';
    expect(link).not.toContain('\r');
    expect(link).not.toContain('\n');

    if (link.includes('https://www.sliccy.ai/rel/upskill')) {
      const upskillSection = link
        .split(',')
        .map((s) => s.trim())
        .find((s) => s.includes('https://www.sliccy.ai/rel/upskill'));
      expect(upskillSection).toBeDefined();
      const m = upskillSection!.match(/^<([^>]*)>/);
      expect(m).not.toBeNull();
      expect(m![1].startsWith('https://github.com/')).toBe(true);
    }
  });

  it('serves the linkset api-catalog at /.well-known/api-catalog', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/.well-known/api-catalog'),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/linkset+json');
    const body = (await response.json()) as { linkset: Array<{ anchor: string }> };
    expect(Array.isArray(body.linkset)).toBe(true);
    const anchors = body.linkset.map((e) => e.anchor);
    expect(anchors).toContain('https://www.sliccy.ai/handoff');
    expect(anchors).toContain('https://www.sliccy.ai/tray');
    expect(anchors).toContain('https://www.sliccy.ai/status');
  });

  it('serves the llms.txt digest', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/llms.txt'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/markdown');
    const body = await response.text();
    expect(body).toMatch(/^# SLICC/m);
    expect(body).toContain('/.well-known/api-catalog');
    expect(body).toContain('/rel/handoff');
  });

  it('serves dereferenceable rel docs at /rel/handoff, /rel/upskill and /rel/successor-version', async () => {
    const { env } = createTestHarness();
    for (const name of ['handoff', 'upskill', 'successor-version']) {
      const response = await handleWorkerRequest(
        new Request(`https://www.sliccy.ai/rel/${name}`),
        env
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const body = await response.text();
      expect(body).toContain(`rel: ${name}`);
    }
  });

  it('returns 404 for unknown rel docs', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/rel/unknown'),
      env
    );
    expect(response.status).toBe(404);
  });

  it('serves a public health document at GET /status', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/status'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as {
      status: string;
      service: string;
      timestamp: string;
    };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('slicc-tray-hub');
    expect(typeof body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it('reports the deployed worker version from the version_metadata binding', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/status'),
      Object.assign(env, { CF_VERSION_METADATA: { id: 'b8f1c7e2-0000-4a2b-9c3d-000000000001' } })
    );
    const body = (await response.json()) as { version: string };
    expect(body.version).toBe('b8f1c7e2-0000-4a2b-9c3d-000000000001');
  });

  it('falls back to an unknown version when the binding is absent or empty', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/status'), env);
    expect(((await response.json()) as { version: string }).version).toBe('unknown');

    const { env: emptyEnv } = createTestHarness();
    const emptyResponse = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/status'),
      Object.assign(emptyEnv, { CF_VERSION_METADATA: { id: '' } })
    );
    expect(((await emptyResponse.json()) as { version: string }).version).toBe('unknown');
  });

  it('leaks no configuration beyond the documented health fields', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://www.sliccy.ai/status'), env);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['service', 'status', 'timestamp', 'version']);
  });

  it('serves GET /status without any authorization header', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/status', { headers: { Cookie: '' } }),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('WWW-Authenticate')).toBeNull();
  });

  it('responds to HEAD /status with the same headers and no body', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/status', { method: 'HEAD' }),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('advertises GET /status via the status rel on every response', async () => {
    const idx = await import('../src/index.js');
    const { env } = createTestHarness();
    const response = await idx.default.fetch(new Request('https://www.sliccy.ai/llms.txt'), env);
    const linkValues = response.headers.get('Link') ?? '';
    expect(linkValues).toMatch(/<https:\/\/www\.sliccy\.ai\/status>; rel="status"/);
  });
});

describe('preview mint API', () => {
  async function setupTrayWithLeader(env: ReturnType<typeof createTestHarness>['env']): Promise<{
    trayId: string;
    controllerToken: string;
  }> {
    const created = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const controllerUrl = new URL(session.capabilities.controller.url);
    const controllerToken = controllerUrl.pathname.split('/').pop()!;

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    expect(leaderAttach.status).toBe(200);

    return { trayId: session.trayId, controllerToken };
  }

  it('mints a preview token and returns a URL when authorized', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const mintResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({
          servedRoot: '/workspace/site',
          entryPath: '/index.html',
          allowLive: false,
        }),
      }),
      env
    );

    expect(mintResponse.status).toBe(200);
    const minted = (await mintResponse.json()) as { previewToken: string; url: string };
    expect(minted.previewToken).toMatch(/^[^.]+\.[0-9a-f]+$/);
    expect(minted.url).toMatch(/^https:\/\/[0-9a-f]{32}--[0-9a-f]+\.sliccy\.now\//);
  });

  it('rejects with 403 on wrong bearer', async () => {
    const { env } = createTestHarness();
    const { trayId } = await setupTrayWithLeader(env);

    const mintResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer wrong.token`,
        },
        body: JSON.stringify({
          servedRoot: '/workspace/site',
          entryPath: '/index.html',
          allowLive: false,
        }),
      }),
      env
    );

    expect(mintResponse.status).toBe(403);
  });

  it('rejects with 401 when bearer is missing', async () => {
    const { env } = createTestHarness();
    const { trayId } = await setupTrayWithLeader(env);

    const mintResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          servedRoot: '/workspace/site',
          entryPath: '/index.html',
          allowLive: false,
        }),
      }),
      env
    );

    expect(mintResponse.status).toBe(401);
  });

  it('GET /previews lists all active previews', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    for (const entry of ['/a.html', '/b.html']) {
      const r = await handleWorkerRequest(
        new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${controllerToken}`,
          },
          body: JSON.stringify({
            servedRoot: '/workspace/site',
            entryPath: entry,
            allowLive: false,
          }),
        }),
        env
      );
      expect(r.status).toBe(200);
    }

    const listResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/previews`, {
        method: 'GET',
        headers: { authorization: `Bearer ${controllerToken}` },
      }),
      env
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      previews: Array<{ previewToken: string; entryPath: string }>;
    };
    expect(listed.previews).toHaveLength(2);
    expect(listed.previews.map((p) => p.entryPath).sort()).toEqual(['/a.html', '/b.html']);
  });

  it('POST /preview/stop revokes the preview', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const mintResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({
          servedRoot: '/workspace/site',
          entryPath: '/index.html',
          allowLive: true,
        }),
      }),
      env
    );
    const minted = (await mintResponse.json()) as { previewToken: string };

    const stopResponse = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview/stop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ previewToken: minted.previewToken }),
      }),
      env
    );
    expect(stopResponse.status).toBe(200);
    await expect(stopResponse.json()).resolves.toEqual({ revoked: true });

    const stopAgain = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview/stop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ previewToken: minted.previewToken }),
      }),
      env
    );
    expect(stopAgain.status).toBe(200);
    await expect(stopAgain.json()).resolves.toEqual({ revoked: false });
  });

  it('returns 404 when tray is not initialized', async () => {
    const { env } = createTestHarness();

    const mintResponse = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/api/tray/nonexistent-tray/preview', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer nonexistent-tray.deadbeef',
        },
        body: JSON.stringify({
          servedRoot: '/workspace/site',
          entryPath: '/index.html',
          allowLive: false,
        }),
      }),
      env
    );
    expect(mintResponse.status).toBe(404);
  });
});

describe('POST /api/tray/:trayId/supersede', () => {
  async function setupTrayWithLeader(env: ReturnType<typeof createTestHarness>['env']): Promise<{
    trayId: string;
    controllerToken: string;
    joinUrl: string;
  }> {
    const created = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; join: { url: string } };
    };
    const controllerToken = new URL(session.capabilities.controller.url).pathname.split('/').pop()!;

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    expect(leaderAttach.status).toBe(200);

    return { trayId: session.trayId, controllerToken, joinUrl: session.capabilities.join.url };
  }

  async function setupTrayWithWebhook(env: ReturnType<typeof createTestHarness>['env']): Promise<{
    trayId: string;
    controllerToken: string;
    webhookUrl: string;
  }> {
    const created = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };
    const controllerToken = new URL(session.capabilities.controller.url).pathname.split('/').pop()!;
    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env
    );
    expect(leaderAttach.status).toBe(200);
    return {
      trayId: session.trayId,
      controllerToken,
      webhookUrl: session.capabilities.webhook.url,
    };
  }

  it('redirects a LEGACY tray-scoped webhook delivery to the replacement with a 308 (#1957)', async () => {
    const { env, readTray } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithWebhook(env);
    const tray = await readTray(trayId);
    const webhookUrl = `https://www.sliccy.ai/webhook/${tray!.webhookToken}`;
    const freshWebhookUrl = 'https://www.sliccy.ai/webhook/fresh-tray.deadbeef';

    const supersede = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({
          joinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef',
          webhookUrl: freshWebhookUrl,
        }),
      }),
      env
    );
    expect(supersede.status).toBe(200);
    await expect(supersede.json()).resolves.toMatchObject({
      supersededByWebhookUrl: freshWebhookUrl,
    });

    const delivery = await handleWorkerRequest(
      new Request(`${webhookUrl}/h3-render-done`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'completed' }),
      }),
      env
    );

    expect(delivery.status).toBe(308);
    expect(delivery.headers.get('Location')).toBe(`${freshWebhookUrl}/h3-render-done`);
    await expect(delivery.json()).resolves.toMatchObject({ code: 'TRAY_SUPERSEDED' });
  });

  it('a stable cone webhook URL survives a rove invisibly (#2812)', async () => {
    const { env } = createTestHarness();

    const connectLeaderFor = async (controllerUrl: string, controllerId: string): Promise<void> => {
      const attach = await handleWorkerRequest(
        new Request(controllerUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ controllerId }),
        }),
        env
      );
      const leader = (await attach.json()) as { websocket: { url: string } };
      await handleWorkerRequest(
        new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
        env
      );
    };

    const createdA = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        body: JSON.stringify(stableCreateIdentity()),
      }),
      env
    );
    const a = (await createdA.json()) as {
      trayId: string;
      coneId: string;
      capabilities: {
        controller: { url: string };
        webhook: { url: string; rebindToken: string };
      };
    };
    await connectLeaderFor(a.capabilities.controller.url, 'lead-a');
    const stableUrl = a.capabilities.webhook.url;

    const toA = await handleWorkerRequest(
      new Request(`${stableUrl}/wh-render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'a' }),
      }),
      env
    );
    expect(toA.status).toBe(202);

    const coneSecret = new URL(stableUrl).pathname.split('/').pop()!.split('.')[1];
    const rebindSecret = a.capabilities.webhook.rebindToken.split('.')[1];
    const createdB = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          coneId: a.coneId,
          coneSecret,
          rebindSecret,
          createAttemptId: crypto.randomUUID(),
        }),
      }),
      env
    );
    const b = (await createdB.json()) as {
      trayId: string;
      coneId: string;
      capabilities: { controller: { url: string }; webhook: { url: string } };
    };
    expect(b.trayId).not.toBe(a.trayId);
    expect(b.coneId).toBe(a.coneId);

    expect(b.capabilities.webhook.url).toBe(stableUrl);
    await connectLeaderFor(b.capabilities.controller.url, 'lead-b');

    const toB = await handleWorkerRequest(
      new Request(`${stableUrl}/wh-render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'b' }),
      }),
      env
    );
    expect(toB.status).toBe(202);
    expect(toB.headers.get('Location')).toBeNull();
    const body = await toB.text();

    expect(body).not.toContain(a.trayId);
    expect(body).not.toContain(b.trayId);
  });

  it('rejects a supersede whose webhookUrl is not an absolute URL', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const response = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({
          joinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef',
          webhookUrl: '/webhook/fresh-tray.deadbeef',
        }),
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('marks the tray superseded when authorized with the controllerToken', async () => {
    const { env, readTray } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const response = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef' }),
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      trayId,
      supersededByJoinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef',
    });
    const tray = await readTray(trayId);
    expect(tray?.supersededByJoinUrl).toBe('https://www.sliccy.ai/join/fresh-tray.deadbeef');
  });

  it('rejects with 401 when bearer is missing', async () => {
    const { env } = createTestHarness();
    const { trayId } = await setupTrayWithLeader(env);

    const response = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ joinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef' }),
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('rejects with 403 on a wrong bearer', async () => {
    const { env } = createTestHarness();
    const { trayId } = await setupTrayWithLeader(env);

    const response = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong.token',
        },
        body: JSON.stringify({ joinUrl: 'https://www.sliccy.ai/join/fresh-tray.deadbeef' }),
      }),
      env
    );

    expect(response.status).toBe(403);
  });

  it('rejects with 400 when joinUrl is missing or malformed', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const missing = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({}),
      }),
      env
    );
    expect(missing.status).toBe(400);

    const malformed = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: 'not-a-url' }),
      }),
      env
    );
    expect(malformed.status).toBe(400);
  });

  it('rejects with 400 on an invalid JSON body', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken } = await setupTrayWithLeader(env);

    const response = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: '{not json',
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it('redirects a follower join with a 308 once the tray is marked superseded', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);
    const freshJoinUrl = 'https://www.sliccy.ai/join/fresh-tray.deadbeef';

    const supersede = await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: freshJoinUrl }),
      }),
      env
    );
    expect(supersede.status).toBe(200);

    const followerAttach = await handleWorkerRequest(
      new Request(joinUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1', runtime: 'electron' }),
      }),
      env
    );

    expect(followerAttach.status).toBe(308);
    expect(followerAttach.headers.get('Location')).toBe(freshJoinUrl);
    expect(followerAttach.headers.get('Link')).toBe(`<${freshJoinUrl}>; rel="successor-version"`);
    await expect(followerAttach.json()).resolves.toMatchObject({
      trayId,
      controllerId: 'follow-1',
      role: 'follower',
      result: {
        action: 'redirect',
        code: 'TRAY_SUPERSEDED',
        joinUrl: freshJoinUrl,
      },
    });
  });

  it('carries json=true onto the supersede Location but not the successor link', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);
    const freshJoinUrl = 'https://www.sliccy.ai/join/fresh-tray.deadbeef';

    await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: freshJoinUrl }),
      }),
      env
    );

    const attachUrl = new URL(joinUrl);
    attachUrl.searchParams.set('json', 'true');
    const followerAttach = await handleWorkerRequest(
      new Request(attachUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1', runtime: 'electron' }),
      }),
      env
    );

    expect(followerAttach.status).toBe(308);
    expect(followerAttach.headers.get('Location')).toBe(`${freshJoinUrl}?json=true`);
    expect(followerAttach.headers.get('Link')).toBe(`<${freshJoinUrl}>; rel="successor-version"`);
  });

  it('answers ?redirect=manual with the terminal 409 + link, no Location', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);
    const freshJoinUrl = 'https://www.sliccy.ai/join/fresh-tray.deadbeef';

    await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: freshJoinUrl }),
      }),
      env
    );

    const attachUrl = new URL(joinUrl);
    attachUrl.searchParams.set('json', 'true');
    attachUrl.searchParams.set('redirect', 'manual');
    const followerAttach = await handleWorkerRequest(
      new Request(attachUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1', runtime: 'browser' }),
      }),
      env
    );

    expect(followerAttach.status).toBe(409);
    expect(followerAttach.headers.get('Location')).toBeNull();
    expect(followerAttach.headers.get('Link')).toBe(`<${freshJoinUrl}>; rel="successor-version"`);
    const body = (await followerAttach.json()) as {
      result: { action: string; code: string; joinUrl: string };
    };
    expect(body.result).toMatchObject({
      action: 'fail',
      code: 'TRAY_SUPERSEDED',
      joinUrl: freshJoinUrl,
    });
  });

  it('returns a 308 on a plain GET status probe once marked superseded', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);
    const freshJoinUrl = 'https://www.sliccy.ai/join/fresh-tray.deadbeef';

    await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: freshJoinUrl }),
      }),
      env
    );

    const probeUrl = new URL(joinUrl);
    probeUrl.searchParams.set('json', 'true');
    const probe = await handleWorkerRequest(new Request(probeUrl), env);

    expect(probe.status).toBe(308);
    expect(probe.headers.get('Location')).toBe(`${freshJoinUrl}?json=true`);
    expect(probe.headers.get('Link')).toBe(`<${freshJoinUrl}>; rel="successor-version"`);
    await expect(probe.json()).resolves.toMatchObject({
      trayId,
      capability: 'join',
      code: 'TRAY_SUPERSEDED',
      joinUrl: freshJoinUrl,
    });
  });

  it('normalizes the successor-version target so a join URL cannot inject a header', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);

    const hostileJoinUrl = 'https://www.sliccy.ai/join/fresh>evil.deadbeef';

    await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: hostileJoinUrl }),
      }),
      env
    );

    const followerAttach = await handleWorkerRequest(
      new Request(joinUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1', runtime: 'electron' }),
      }),
      env
    );

    expect(followerAttach.status).toBe(308);
    expect(followerAttach.headers.get('Link')).toBe(
      '<https://www.sliccy.ai/join/fresh%3Eevil.deadbeef>; rel="successor-version"'
    );

    expect(followerAttach.headers.get('Location')).toBe(
      'https://www.sliccy.ai/join/fresh%3Eevil.deadbeef'
    );

    await expect(followerAttach.json()).resolves.toMatchObject({
      result: { code: 'TRAY_SUPERSEDED', joinUrl: hostileJoinUrl },
    });
  });

  it('keeps the successor-version link through worker.fetch, without the standard rel set', async () => {
    const { env } = createTestHarness();
    const { trayId, controllerToken, joinUrl } = await setupTrayWithLeader(env);
    const freshJoinUrl = 'https://www.sliccy.ai/join/fresh-tray.deadbeef';

    await handleWorkerRequest(
      new Request(`https://www.sliccy.ai/api/tray/${trayId}/supersede`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${controllerToken}`,
        },
        body: JSON.stringify({ joinUrl: freshJoinUrl }),
      }),
      env
    );

    const probeUrl = new URL(joinUrl);
    probeUrl.searchParams.set('json', 'true');
    const probe = await worker.fetch(new Request(probeUrl), env);

    expect(probe.status).toBe(308);
    const link = probe.headers.get('Link') ?? '';
    expect(link).toBe(`<${freshJoinUrl}>; rel="successor-version"`);
    expect(link).not.toContain('rel="api-catalog"');
  });
});

describe('standard Link header set', () => {
  it('attaches api-catalog, service-desc, service-doc, status, llms-txt rels to every response', async () => {
    const idx = await import('../src/index.js');
    const { env } = createTestHarness();
    const response = await idx.default.fetch(new Request('https://www.sliccy.ai/llms.txt'), env);
    const linkValues = response.headers.get('Link') ?? '';
    expect(linkValues).toContain('rel="api-catalog"');
    expect(linkValues).toContain('rel="service-desc"');
    expect(linkValues).toContain('rel="service-doc"');
    expect(linkValues).toContain('rel="status"');
    expect(linkValues).toContain('rel="https://llmstxt.org/rel/llms-txt"');
    expect(linkValues).toContain('rel="terms-of-service"');
  });

  it('skips the standard rel set on 3xx redirect responses', async () => {
    const { applySliccLinks } = await import('../src/links.js');
    const req = new Request('https://www.sliccy.ai/anywhere');
    const redirect = Response.redirect('https://www.sliccy.ai/elsewhere', 302);
    expect(applySliccLinks(redirect, req).headers.get('Link')).toBeNull();
    const ok = new Response('hi', { status: 200 });
    expect(applySliccLinks(ok, req).headers.get('Link')).toContain('rel="api-catalog"');
  });

  it('successorVersionLink emits no header for a target that is not a URL', async () => {
    const { successorVersionLink, supersededLinkHeaders } = await import('../src/links.js');
    expect(successorVersionLink('https://www.sliccy.ai/join/t.secret')).toBe(
      '<https://www.sliccy.ai/join/t.secret>; rel="successor-version"'
    );

    expect(successorVersionLink('not-a-url')).toBeNull();
    expect(supersededLinkHeaders('not-a-url')).toEqual({});
  });

  it('supersededLocation propagates json=true and refuses a non-URL target', async () => {
    const { supersededLocation } = await import('../src/links.js');
    const fresh = 'https://www.sliccy.ai/join/fresh.deadbeef';

    expect(supersededLocation(fresh, new URL('https://www.sliccy.ai/join/old.beef'))).toBe(fresh);
    expect(
      supersededLocation(fresh, new URL('https://www.sliccy.ai/join/old.beef?json=true'))
    ).toBe(`${fresh}?json=true`);

    expect(supersededLocation(fresh, new URL('https://www.sliccy.ai/join/old.beef?json=1'))).toBe(
      fresh
    );

    expect(supersededLocation('not-a-url', new URL('https://www.sliccy.ai/join/old.beef'))).toBe(
      null
    );
  });

  it('prefersManualRedirect only on the exact redirect=manual opt-out', async () => {
    const { prefersManualRedirect } = await import('../src/links.js');
    const at = (search: string) =>
      prefersManualRedirect(new URL(`https://www.sliccy.ai/join/old.beef${search}`));

    expect(at('?redirect=manual')).toBe(true);
    expect(at('?json=true&redirect=manual')).toBe(true);
    expect(at('')).toBe(false);

    expect(at('?redirect=follow')).toBe(false);
    expect(at('?redirect=1')).toBe(false);
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
          refresh_token: 'ignored-refresh-token',
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
    expect(Object.fromEntries(new URLSearchParams(fetchInit?.body as string))).toEqual({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      code: 'test-auth-code',
      grant_type: 'authorization_code',
      redirect_uri: 'https://www.sliccy.ai/auth/callback',
    });
  });

  it('exchanges a refresh token via POST /oauth/token', async () => {
    const env = oauthEnv();
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'gho_refreshed_token',
          refresh_token: 'ghr_rotated_token',
          expires_in: 28_800,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const response = await handleWorkerRequest(
      new Request('https://tray.test/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'github', refresh_token: 'ghr_existing_token' }),
      }),
      env,
      mockFetch
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: 'gho_refreshed_token',
      refresh_token: 'ghr_rotated_token',
      expires_in: 28_800,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [fetchUrl, fetchInit] = mockFetch.mock.calls[0]!;
    expect(fetchUrl).toBe('https://github.com/login/oauth/access_token');
    expect(Object.fromEntries(new URLSearchParams(fetchInit?.body as string))).toEqual({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      refresh_token: 'ghr_existing_token',
      grant_type: 'refresh_token',
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
    const env = createTestHarness().env;
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

describe('OAuth relay (/auth/callback)', () => {
  it('returns HTML with allowlist injected from env var', async () => {
    const { env } = createTestHarness();
    const testEnv = {
      ...env,
      ALLOWED_CLOUD_DASHBOARD_ORIGINS: 'https://example.com,https://staging.example.com',
    };
    const req = new Request('https://www.sliccy.ai/auth/callback');
    const res = await handleWorkerRequest(req, testEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await res.text();

    expect(html).toContain('["https://example.com","https://staging.example.com"]');

    expect(html).toContain("source === 'remote'");
  });

  it('accepts empty ALLOWED_CLOUD_DASHBOARD_ORIGINS', async () => {
    const { env } = createTestHarness();
    const req = new Request('https://www.sliccy.ai/auth/callback');
    const res = await handleWorkerRequest(req, env);

    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toMatch(/var allowed = \[\];/);
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

  it('uses TRAY_WORKER_BASE_URL_OVERRIDE when set', async () => {
    const env = {
      ...createTestHarness().env,
      GITHUB_CLIENT_ID: 'test-gh-id',
      TRAY_WORKER_BASE_URL_OVERRIDE: 'https://staging.example.com/',
    };
    const req = new Request('https://www.sliccy.ai/api/runtime-config');
    const res = await handleWorkerRequest(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      trayWorkerBaseUrl: string;
      oauth: { github?: string };
    };
    expect(body.trayWorkerBaseUrl).toBe('https://staging.example.com');
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

describe('GET /download/slicc.dmg', () => {
  const DMG_URL = 'https://www.sliccy.ai/download/slicc.dmg';
  const RELEASES_FALLBACK = 'https://github.com/ai-ecoverse/slicc/releases/latest';

  const KNOWN_GOOD_VERSION = knownGoodMacos.version;
  const KNOWN_GOOD_DMG_URL = `https://github.com/ai-ecoverse/slicc/releases/download/v${KNOWN_GOOD_VERSION}/sliccstart-v${KNOWN_GOOD_VERSION}.dmg`;
  const KNOWN_GOOD_DMG_ASSET = `sliccstart-v${KNOWN_GOOD_VERSION}.dmg`;

  const [kgMajor, kgMinor] = KNOWN_GOOD_VERSION.split('.').map(Number);
  const newerThanPointer = (bump: number) => `${kgMajor}.${kgMinor + bump}.0`;
  const olderThanPointer = `${kgMajor}.${kgMinor - 1}.0`;

  it('redirects to the newest release that ships a .dmg, skipping a binary-less latest release', async () => {
    const { env } = createTestHarness();
    const releases = [
      {
        draft: false,
        prerelease: false,
        assets: [{ name: 'notes.txt', browser_download_url: 'x' }],
      },
      {
        draft: false,
        prerelease: false,
        assets: [{ name: KNOWN_GOOD_DMG_ASSET, browser_download_url: KNOWN_GOOD_DMG_URL }],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('api.github.com');
  });

  it('paginates past a full first page of binary-less releases to find a .dmg on page 2', async () => {
    const { env } = createTestHarness();
    const page1 = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, () => ({
      draft: false,
      prerelease: false,
      assets: [{ name: 'notes.txt', browser_download_url: 'x' }],
    }));
    const page2 = [
      {
        draft: false,
        prerelease: false,
        assets: [{ name: KNOWN_GOOD_DMG_ASSET, browser_download_url: KNOWN_GOOD_DMG_URL }],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
      const target = typeof input === 'string' ? input : (input as Request).url;
      const body = target.includes('page=2') ? page2 : page1;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCall = fetchImpl.mock.calls[1]?.[0];
    const secondUrl = typeof secondCall === 'string' ? secondCall : (secondCall as Request).url;
    expect(secondUrl).toContain('page=2');
  });

  it('stops at the MAX_RELEASE_PAGES backstop and redirects to the known-good DMG when tags are unparseable', async () => {
    const { env } = createTestHarness();
    const fullBinaryLessPage = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, () => ({
      draft: false,
      prerelease: false,
      assets: [{ name: 'notes.txt', browser_download_url: 'x' }],
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(fullBinaryLessPage), { status: 200 }))
      );

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_RELEASES_MAX_PAGES);
  });

  it('redirects to the known-good DMG when no release has a .dmg asset', async () => {
    const { env } = createTestHarness();
    const releases = [
      {
        draft: false,
        prerelease: false,
        assets: [{ name: `sliccstart-v${KNOWN_GOOD_VERSION}.zip`, browser_download_url: 'z' }],
      },
      {
        draft: true,
        prerelease: false,
        assets: [{ name: 'sliccstart-v5.38.0.dmg', browser_download_url: 'd' }],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
  });

  it('redirects to the known-good DMG when the API fetch rejects', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
  });

  it('redirects to the known-good DMG when the API returns a non-2xx status', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('boom', { status: 500 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
  });

  it('redirects to the newest release .dmg on page 1 without hitting the pointer floor (happy path)', async () => {
    const { env } = createTestHarness();
    const newestVersion = newerThanPointer(1);
    const newestDmgUrl = `https://github.com/ai-ecoverse/slicc/releases/download/v${newestVersion}/sliccstart-v${newestVersion}.dmg`;
    const releases = [
      {
        draft: false,
        prerelease: false,
        tag_name: `v${newestVersion}`,
        assets: [{ name: `sliccstart-v${newestVersion}.dmg`, browser_download_url: newestDmgUrl }],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(newestDmgUrl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops at the pointer floor and redirects to the known-good DMG after a binary-less streak', async () => {
    const { env } = createTestHarness();
    const releases = [
      { draft: false, prerelease: false, tag_name: `v${newerThanPointer(2)}`, assets: [] },
      { draft: false, prerelease: false, tag_name: `v${newerThanPointer(1)}`, assets: [] },

      { draft: false, prerelease: false, tag_name: `v${KNOWN_GOOD_VERSION}`, assets: [] },

      {
        draft: false,
        prerelease: false,
        tag_name: `v${olderThanPointer}`,
        assets: [
          {
            name: `sliccstart-v${olderThanPointer}.dmg`,
            browser_download_url: 'https://example.com/should-not-be-used.dmg',
          },
        ],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never scans past the pointer version even across full pages', async () => {
    const { env } = createTestHarness();

    const page1 = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, (_unused, i) => ({
      draft: false,
      prerelease: false,
      tag_name: `v${kgMajor}.${kgMinor + 2 - i}.0`,
      assets: [] as unknown[],
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(page1), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to releases/latest with a malformed pointer (bounded search + exhaustion)', async () => {
    const fullBinaryLessPage = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, () => ({
      draft: false,
      prerelease: false,
      tag_name: 'v5.40.0',
      assets: [{ name: 'notes.txt', browser_download_url: 'x' }],
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(fullBinaryLessPage), { status: 200 }))
      );

    const res = await handleDmgDownload(fetchImpl, { version: '' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(RELEASES_FALLBACK);
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_RELEASES_MAX_PAGES);
  });

  it('falls back to releases/latest with a malformed pointer when the API fetch rejects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));

    const res = await handleDmgDownload(fetchImpl, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(RELEASES_FALLBACK);
  });

  describe('buildKnownGoodDmgUrl', () => {
    it('builds the release download URL from a valid pointer', () => {
      expect(buildKnownGoodDmgUrl({ version: KNOWN_GOOD_VERSION })).toBe(KNOWN_GOOD_DMG_URL);
    });

    it('returns null for a missing, blank, or non-string version', () => {
      expect(buildKnownGoodDmgUrl(null)).toBeNull();
      expect(buildKnownGoodDmgUrl(undefined)).toBeNull();
      expect(buildKnownGoodDmgUrl({})).toBeNull();
      expect(buildKnownGoodDmgUrl({ version: '' })).toBeNull();
      expect(buildKnownGoodDmgUrl({ version: '   ' })).toBeNull();
      expect(buildKnownGoodDmgUrl({ version: 123 })).toBeNull();
    });
  });

  describe('compareReleaseVersions', () => {
    it('orders versions, tolerating a leading v and uneven segment counts', () => {
      expect(compareReleaseVersions('v5.38.0', '5.37.0')).toBeGreaterThan(0);
      expect(compareReleaseVersions('5.36.0', '5.37.0')).toBeLessThan(0);
      expect(compareReleaseVersions('v5.37.0', '5.37.0')).toBe(0);
      expect(compareReleaseVersions('5.37', '5.37.0')).toBe(0);
      expect(compareReleaseVersions('5.37.1', '5.37.0')).toBeGreaterThan(0);
    });
  });

  it('handles HEAD requests the same as GET', async () => {
    const { env } = createTestHarness();
    const releases = [
      {
        draft: false,
        prerelease: false,
        assets: [{ name: KNOWN_GOOD_DMG_ASSET, browser_download_url: KNOWN_GOOD_DMG_URL }],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(DMG_URL, { method: 'HEAD' }), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(KNOWN_GOOD_DMG_URL);
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

describe('shared types — hosted tray', () => {
  it('HOSTED_TRAY_RECLAIM_TTL_MS is 30 days', () => {
    expect(HOSTED_TRAY_RECLAIM_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('TRAY_RECLAIM_TTL_MS unchanged at 1 hour', () => {
    expect(TRAY_RECLAIM_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('CreateTrayRequest.kind is an optional string-literal union', () => {
    const desktop: CreateTrayRequest = {
      trayId: 't',
      createdAt: 'now',
      joinToken: 'j',
      controllerToken: 'c',
      webhookToken: 'w',
    };
    const hosted: CreateTrayRequest = { ...desktop, kind: 'hosted' };
    const explicit: CreateTrayRequest = { ...desktop, kind: 'desktop' };
    expect(desktop.kind).toBeUndefined();
    expect(hosted.kind).toBe('hosted');
    expect(explicit.kind).toBe('desktop');
  });

  it('TrayRecord.kind is part of the persisted shape', () => {
    const rec = {
      trayId: 't',
      createdAt: 'now',
      joinToken: 'j',
      controllerToken: 'c',
      webhookToken: 'w',
      controllers: {},
      bootstraps: {},
      leader: null,
      kind: 'hosted',
    } as TrayRecord;
    expect(rec.kind).toBe('hosted');
  });
});

describe('POST /tray — kind plumbing', () => {
  it('accepts an empty body and defaults kind to desktop', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      env
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toHaveProperty('trayId');
  });

  it('rejects malformed JSON with 400', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
      env
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('INVALID_BODY');
  });

  it('treats explicit empty-string body the same as no body (back-compat)', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST', body: '' }),
      env
    );
    expect(response.status).toBe(201);
  });

  it('accepts kind=hosted', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'hosted' }),
      }),
      env
    );
    expect(response.status).toBe(201);
  });

  it('accepts kind=desktop explicitly', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'desktop' }),
      }),
      env
    );
    expect(response.status).toBe(201);
  });

  it('rejects invalid kind with 400', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'invalid' }),
      }),
      env
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('INVALID_KIND');
  });
});

describe('reclaimMsForTray', () => {
  it('returns 30 days for kind=hosted', () => {
    expect(reclaimMsForTray({ kind: 'hosted' } as TrayRecord)).toBe(HOSTED_TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for kind=desktop', () => {
    expect(reclaimMsForTray({ kind: 'desktop' } as TrayRecord)).toBe(TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for absent kind (back-compat)', () => {
    expect(reclaimMsForTray({} as TrayRecord)).toBe(TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for null/undefined (defensive)', () => {
    expect(reclaimMsForTray(null)).toBe(TRAY_RECLAIM_TTL_MS);
    expect(reclaimMsForTray(undefined)).toBe(TRAY_RECLAIM_TTL_MS);
  });
});

describe('SessionTrayDurableObject — kind persistence', () => {
  it('persists kind=hosted on the tray record after /internal/create', async () => {
    const state = new FakeDurableObjectState();
    const tray = new SessionTrayDurableObject(
      state,
      {},
      { now: () => Date.now(), webSocketPairFactory: createFakeWebSocketPair }
    );

    await tray.fetch(
      new Request('https://internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't1',
          createdAt: new Date().toISOString(),
          joinToken: 'j',
          controllerToken: 'c',
          webhookToken: 'w',
          kind: 'hosted',
        }),
      })
    );

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.kind).toBe('hosted');
    expect(reclaimMsForTray(stored)).toBe(HOSTED_TRAY_RECLAIM_TTL_MS);
  });

  it('defaults to kind=desktop when /internal/create payload omits it', async () => {
    const state = new FakeDurableObjectState();
    const tray = new SessionTrayDurableObject(
      state,
      {},
      { now: () => Date.now(), webSocketPairFactory: createFakeWebSocketPair }
    );

    await tray.fetch(
      new Request('https://internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't2',
          createdAt: new Date().toISOString(),
          joinToken: 'j2',
          controllerToken: 'c2',
          webhookToken: 'w2',
        }),
      })
    );

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.kind ?? 'desktop').toBe('desktop');
    expect(reclaimMsForTray(stored)).toBe(TRAY_RECLAIM_TTL_MS);
  });
});

describe('SessionTrayDurableObject — hibernation', () => {
  it('recovers the leader socket from getWebSockets after the object is evicted from memory', async () => {
    const now = Date.parse('2026-03-11T00:00:00.000Z');
    const state = new FakeDurableObjectState();
    const first = new SessionTrayDurableObject(
      state,
      {},
      {
        now: () => now,
        webSocketPairFactory: createFakeWebSocketPair,

        webhookDeliveryWaitMs: 5,
      }
    );
    state.instance = first;

    await first.fetch(
      new Request('https://tray.test/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't-hib',
          createdAt: new Date(now).toISOString(),
          joinToken: 'j',
          controllerToken: 'c',
          webhookToken: 'w',
        }),
      })
    );

    const attach = await first.fetch(
      new Request('https://tray.test/controller/c', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      })
    );
    const leader = (await attach.json()) as { websocket: { url: string } };
    const wsResponse = await first.fetch(
      new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } })
    );
    const clientSocket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
    expect(clientSocket.received[0]).toContain('leader.connected');

    const revived = new SessionTrayDurableObject(
      state,
      {},
      {
        now: () => now,
        webSocketPairFactory: createFakeWebSocketPair,

        webhookDeliveryWaitMs: 5,
      }
    );
    state.instance = revived;

    const webhook = await revived.fetch(
      new Request('https://tray.test/webhook/w/hook-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'opened' }),
      })
    );

    expect(webhook.status).toBe(202);
    const forwarded = clientSocket.received
      .map((raw) => JSON.parse(raw) as { type: string; webhookId?: string })
      .filter((message) => message.type === 'webhook.event');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.webhookId).toBe('hook-1');
  });

  it('ignores a stale leader close when a newer leader socket is already live', async () => {
    const now = Date.parse('2026-03-11T00:00:00.000Z');
    const state = new FakeDurableObjectState();
    const instance = new SessionTrayDurableObject(
      state,
      {},
      { now: () => now, webSocketPairFactory: createFakeWebSocketPair }
    );
    state.instance = instance;

    await instance.fetch(
      new Request('https://tray.test/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't-race',
          createdAt: new Date(now).toISOString(),
          joinToken: 'j',
          controllerToken: 'c',
          webhookToken: 'w',
        }),
      })
    );
    const attach = await instance.fetch(
      new Request('https://tray.test/controller/c', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      })
    );
    const leader = (await attach.json()) as { websocket: { url: string } };
    await instance.fetch(new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }));

    const staleSocket = state.getWebSockets('leader')[0]!;

    const { server: newServer } = createFakeWebSocketPair();
    state.acceptWebSocket(newServer, ['leader']);

    await instance.webSocketClose(staleSocket);

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.leader?.connected).toBe(true);
  });
});

describe('cherry framing policy', () => {
  it('default SPA forbids framing and is not no-store', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://app.example/'), env);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control') ?? '').not.toContain('no-store');
  });

  it('default SPA (leader + join/controller) is cross-origin isolated via DIP', async () => {
    const { env } = createTestHarness();
    for (const path of ['/', '/join/tok-abc', '/controller/tok-abc']) {
      const res = await worker.fetch(new Request(`https://app.example${path}`), env);
      expect(res.headers.get('document-isolation-policy')).toBe('isolate-and-credentialless');
    }
  });

  it('cherry and electron-overlay responses carry NO isolation header', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: '*',
    };
    const cherry = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    expect(cherry.headers.get('document-isolation-policy')).toBeNull();
    const overlay = await worker.fetch(
      new Request('https://app.example/electron?bridge=ws://localhost:9222/cdp&role=leader'),
      env
    );
    expect(overlay.headers.get('document-isolation-policy')).toBeNull();
  });

  it('cherry boot allows configured ancestors and is uncacheable', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: 'https://host.example',
    };
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://host.example');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('vary') ?? '').toContain('Sec-Fetch-Dest');
  });

  it('cherry boot with no configured ancestors falls back to none', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('cherry boot with wildcard ancestor permits arbitrary third-party embedding', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: '*',
    };
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('vary') ?? '').toContain('Sec-Fetch-Dest');
  });

  it('wildcard token wins when mixed with explicit origins', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: 'https://host.example *',
    };
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain('https://host.example');
  });

  it('non-cherry leader/top-level response keeps frame-ancestors none even with wildcard env', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: '*',
    };
    const res = await worker.fetch(new Request('https://app.example/'), env);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control') ?? '').not.toContain('no-store');
  });

  it('electron overlay omits frame-ancestors entirely and is uncacheable', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(
      new Request('https://app.example/electron?bridge=ws://localhost:9222/cdp&role=leader'),
      env
    );
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).not.toContain('frame-ancestors');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('frame-ancestors *');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('vary') ?? '').toContain('Sec-Fetch-Dest');
  });
});

describe('resolveCherryFrameAncestors', () => {
  it('returns none for empty/undefined input', () => {
    expect(resolveCherryFrameAncestors(undefined)).toBe("'none'");
    expect(resolveCherryFrameAncestors('')).toBe("'none'");
    expect(resolveCherryFrameAncestors('   ')).toBe("'none'");
  });

  it('returns the trimmed origin list as configured', () => {
    expect(resolveCherryFrameAncestors('https://a.example')).toBe('https://a.example');
    expect(resolveCherryFrameAncestors('https://a.example https://b.example')).toBe(
      'https://a.example https://b.example'
    );

    expect(resolveCherryFrameAncestors('  https://a.example   https://b.example  ')).toBe(
      'https://a.example https://b.example'
    );
  });

  it('returns * when wildcard token is present (alone or mixed)', () => {
    expect(resolveCherryFrameAncestors('*')).toBe('*');
    expect(resolveCherryFrameAncestors('* https://a.example')).toBe('*');
    expect(resolveCherryFrameAncestors('https://a.example *')).toBe('*');
  });

  it('wildcard keeps chrome-extension origins (CSP * does not authorize extension ancestors)', () => {
    expect(resolveCherryFrameAncestors('* chrome-extension://abc')).toBe(
      '* chrome-extension://abc'
    );
    expect(resolveCherryFrameAncestors('chrome-extension://abc *')).toBe(
      '* chrome-extension://abc'
    );
    expect(resolveCherryFrameAncestors('* https://a.example chrome-extension://abc')).toBe(
      '* chrome-extension://abc'
    );
  });
});

describe('capability-route CORS', () => {
  const ALLOWED_ORIGIN = 'https://overlay.example';
  const NOT_ALLOWED_ORIGIN = 'https://evil.example';

  function corsEnv(): ReturnType<typeof createTestHarness>['env'] & {
    ALLOWED_CLOUD_DASHBOARD_ORIGINS: string;
  } {
    return {
      ...createTestHarness().env,
      ALLOWED_CLOUD_DASHBOARD_ORIGINS: `${ALLOWED_ORIGIN},https://www.sliccy.ai`,
    };
  }

  it('parseAllowedCapabilityOrigins trims and drops empty entries', () => {
    expect(parseAllowedCapabilityOrigins(undefined)).toEqual([]);
    expect(parseAllowedCapabilityOrigins('')).toEqual([]);
    expect(parseAllowedCapabilityOrigins('  https://a.example , , https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('capabilityCorsHeaders echoes only allowlisted origins, never a wildcard', () => {
    const env = corsEnv();
    const allowed = capabilityCorsHeaders(
      new Request('https://tray.test/join/x', { headers: { Origin: ALLOWED_ORIGIN } }),
      env
    );
    expect(allowed['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN);
    expect(allowed['Access-Control-Allow-Headers']).toBe('content-type');
    expect(allowed['Access-Control-Allow-Methods']).toContain('OPTIONS');

    expect(allowed['Access-Control-Expose-Headers']).toBe('Link');
    expect(allowed.Vary).toBe('Origin');

    const blocked = capabilityCorsHeaders(
      new Request('https://tray.test/join/x', { headers: { Origin: NOT_ALLOWED_ORIGIN } }),
      env
    );
    expect(blocked['Access-Control-Allow-Origin']).toBeUndefined();
    expect(blocked['Access-Control-Expose-Headers']).toBeUndefined();
    expect(blocked.Vary).toBe('Origin');
  });

  it('answers an OPTIONS preflight on /join with allow headers for an allowlisted origin', async () => {
    const env = corsEnv();
    const res = await handleWorkerRequest(
      new Request('https://tray.test/join/tray-1.secret', {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      }),
      env
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('OPTIONS preflight omits allow-origin for a non-allowlisted origin', async () => {
    const env = corsEnv();
    const res = await handleWorkerRequest(
      new Request('https://tray.test/controller/tray-1.secret', {
        method: 'OPTIONS',
        headers: { Origin: NOT_ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
      env
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('POST /join echoes Access-Control-Allow-Origin for an allowlisted origin', async () => {
    const env = corsEnv();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { capabilities: { join: { url: string } } };

    const res = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ controllerId: 'follower-1', runtime: 'cli' }),
      }),
      env
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('POST /join omits Access-Control-Allow-Origin for a non-allowlisted origin', async () => {
    const env = corsEnv();
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { capabilities: { join: { url: string } } };

    const res = await handleWorkerRequest(
      new Request(`${session.capabilities.join.url}?json=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Origin: NOT_ALLOWED_ORIGIN },
        body: JSON.stringify({ controllerId: 'follower-1', runtime: 'cli' }),
      }),
      env
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('POST /tray echoes Access-Control-Allow-Origin for an allowlisted origin', async () => {
    const env = corsEnv();
    const res = await handleWorkerRequest(
      new Request('https://tray.test/tray', {
        method: 'POST',
        headers: { Origin: ALLOWED_ORIGIN },
      }),
      env
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });
});

describe('asset archive fallback (#1330 retention)', () => {
  const HASHED_PATH = '/assets/anthropic-messages-DP3-Xd3J.js';
  const HASHED_URL = `https://www.sliccy.ai${HASHED_PATH}`;
  const ARCHIVE_KEY = 'assets/anthropic-messages-DP3-Xd3J.js';

  class FakeCache {
    readonly store = new Map<string, Response>();
    matchCalls = 0;
    putCalls = 0;
    matchImpl: ((req: Request) => Promise<Response | undefined>) | null = null;
    putImpl: ((req: Request, res: Response) => Promise<void>) | null = null;

    async match(req: Request): Promise<Response | undefined> {
      this.matchCalls++;
      if (this.matchImpl) return this.matchImpl(req);
      const hit = this.store.get(req.url);
      return hit ? hit.clone() : undefined;
    }

    async put(req: Request, res: Response): Promise<void> {
      this.putCalls++;
      if (this.putImpl) return this.putImpl(req, res);
      this.store.set(req.url, res.clone());
    }
  }

  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
    (globalThis as Record<string, unknown>).caches = { default: cache };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).caches;
  });

  function makeCtx(): { ctx: ExecutionContext; settle: () => Promise<unknown> } {
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(Promise.resolve(p));
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    return { ctx, settle: () => Promise.allSettled(waited) };
  }

  function shell(status = 200): Response {
    return new Response(MOCK_HTML, { status, headers: { 'content-type': 'text/html' } });
  }

  interface FakeArchiveObj {
    body: string;
    httpEtag: string;
    size: number;
    uploaded: Date;
    writeHttpMetadata: (headers: Headers) => void;
  }

  function archiveObj(
    body: string,
    opts: { etag?: string; contentType?: string | null; uploaded?: Date } = {}
  ): FakeArchiveObj {
    return {
      body,
      httpEtag: opts.etag ?? '"deadbeef"',
      size: body.length,
      uploaded: opts.uploaded ?? new Date(0),
      writeHttpMetadata: (headers: Headers) => {
        if (opts.contentType) headers.set('content-type', opts.contentType);
      },
    };
  }

  function archiveEnv(opts: {
    assets: (req: Request) => Response | Promise<Response>;
    get?: (key: string) => Promise<unknown>;
  }): {
    env: WorkerEnv;
    assetsSpy: ReturnType<typeof vi.fn>;
    getSpy: ReturnType<typeof vi.fn>;
  } {
    const assetsSpy = vi.fn((req: Request) => Promise.resolve(opts.assets(req)));
    const getSpy = vi.fn(opts.get ?? (async () => null));
    const env = makeEnv({
      ASSETS: { fetch: assetsSpy },
      ASSET_ARCHIVE: { get: getSpy } as unknown as WorkerEnv['ASSET_ARCHIVE'],
    });
    return { env, assetsSpy, getSpy };
  }

  it('serves a present asset unchanged from ASSETS without touching R2', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () =>
        new Response('console.log(1)', {
          status: 200,
          headers: { 'content-type': 'text/javascript' },
        }),
    });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');

    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('serves a present asset carrying Range/conditional via ASSETS, never R2', async () => {
    const { env, getSpy, assetsSpy } = archiveEnv({
      assets: () =>
        new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } }),
    });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/assets/index-a1b2c3d4.css', {
        headers: { range: 'bytes=0-4', 'if-none-match': '"x"' },
      }),
      env,
      undefined,
      ctx
    );
    expect(res.status).toBe(200);
    expect(getSpy).not.toHaveBeenCalled();

    expect(assetsSpy).toHaveBeenCalledTimes(2);
  });

  it('serves an archived asset on an ASSETS miss (GET) with immutable headers, no Accept-Ranges', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript', etag: '"v1"' }),
    });
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.headers.get('last-modified')).toBe(new Date(0).toUTCString());
    expect(res.headers.get('content-length')).toBe(String('ARCHIVED-JS'.length));
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('accept-ranges')).toBeNull();

    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(getSpy).toHaveBeenCalledWith(ARCHIVE_KEY);
  });

  it('serves an archive hit through the default NOOP execution context (2-arg call)', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });

    const res = await handleWorkerRequest(new Request(HASHED_URL), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(getSpy).toHaveBeenCalledWith(ARCHIVE_KEY);
  });

  it('falls back to the MIME map when the archived object has no stored content-type', async () => {
    const { env } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: null }),
    });
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
  });

  it('serves an archived HEAD hit with headers and an empty body, bypassing the edge cache', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(
      new Request(HASHED_URL, { method: 'HEAD' }),
      env,
      undefined,
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript');
    expect(res.headers.get('content-length')).toBe(String('ARCHIVED-JS'.length));
    expect(await res.text()).toBe('');

    expect(cache.matchCalls).toBe(0);
    expect(cache.putCalls).toBe(0);
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores Range/conditional on a miss and serves a full 200, calling get() with no onlyIf/range', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(
      new Request(HASHED_URL, {
        headers: {
          range: 'bytes=0-4',
          'if-none-match': '"x"',
          'if-modified-since': new Date(0).toUTCString(),
          'if-match': '"y"',
        },
      }),
      env,
      undefined,
      ctx
    );
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(res.headers.get('accept-ranges')).toBeNull();

    expect(getSpy.mock.calls[0]).toEqual([ARCHIVE_KEY]);
  });

  it('falls back to the shell on an archive miss (GET → 200 text/html)', async () => {
    const { env } = archiveEnv({ assets: () => shell(), get: async () => null });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(MOCK_HTML);
  });

  it('falls back to a bodyless shell on an archive miss (HEAD)', async () => {
    const { env } = archiveEnv({ assets: () => shell(), get: async () => null });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(
      new Request(HASHED_URL, { method: 'HEAD' }),
      env,
      undefined,
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  });

  it('classifies a 404 from ASSETS as a miss and serves the archived object', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => new Response('nope', { status: 404 }),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(getSpy).toHaveBeenCalledWith(ARCHIVE_KEY);
  });

  it('never 500s when R2 get() throws — falls back to the shell', async () => {
    const { env } = archiveEnv({
      assets: () => shell(),
      get: async () => {
        throw new Error('R2 down');
      },
    });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(MOCK_HTML);
  });

  it('never 500s when the edge cache read throws — falls through to R2', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    cache.matchImpl = async () => {
      throw new Error('cache read boom');
    };
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('never 500s when the edge cache put rejects', async () => {
    const { env } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    cache.putImpl = async () => {
      throw new Error('cache put boom');
    };
    const { ctx, settle } = makeCtx();
    const res = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
  });

  it('populates the edge cache on a GET and serves the second GET from cache (no second R2 read)', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const first = makeCtx();
    const res1 = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, first.ctx);
    await first.settle();
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe('ARCHIVED-JS');
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(cache.putCalls).toBe(1);

    const second = makeCtx();
    const res2 = await handleWorkerRequest(new Request(HASHED_URL), env, undefined, second.ctx);
    await second.settle();
    expect(res2.status).toBe(200);
    expect(await res2.text()).toBe('ARCHIVED-JS');

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('caches under a canonical key that ignores the query string', async () => {
    const { env, getSpy } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const first = makeCtx();
    await handleWorkerRequest(new Request(`${HASHED_URL}?json=true`), env, undefined, first.ctx);
    await first.settle();
    expect(getSpy).toHaveBeenCalledTimes(1);

    const second = makeCtx();
    const res2 = await handleWorkerRequest(
      new Request(`${HASHED_URL}?json=false`),
      env,
      undefined,
      second.ctx
    );
    await second.settle();
    expect(await res2.text()).toBe('ARCHIVED-JS');

    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('falls through (no archive) for a non-hashed /assets path', async () => {
    const { env, getSpy } = archiveEnv({ assets: () => shell() });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/assets/foo.js'),
      env,
      undefined,
      ctx
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('falls through (no archive) for a POST to a hashed /assets path', async () => {
    const { env, getSpy } = archiveEnv({ assets: () => shell() });
    const { ctx } = makeCtx();
    const res = await handleWorkerRequest(
      new Request(HASHED_URL, { method: 'POST' }),
      env,
      undefined,
      ctx
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ service: 'slicc-tray-hub' });
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('archived responses pass through the outer applySliccLinks wrapper (worker.fetch)', async () => {
    const { env } = archiveEnv({
      assets: () => shell(),
      get: async () => archiveObj('ARCHIVED-JS', { contentType: 'text/javascript' }),
    });
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(new Request(HASHED_URL), env, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ARCHIVED-JS');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('link') ?? '').toContain('rel=');

    expect(res.headers.get('content-security-policy')).toBeNull();
  });
});

describe('GET /install-cli', () => {
  it('serves the POSIX installer script with download URLs pinned to the serving origin', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/install-cli'),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/x-shellscript');
    const body = await response.text();
    expect(body).toMatch(/^#!\/bin\/sh/);
    expect(body).toContain('https://www.sliccy.ai/download/slicc-cli/$os-$arch');
    expect(body).toContain('curl -fsSL https://www.sliccy.ai/install-cli | sh');

    expect(body).toContain('Darwin) os="darwin"');
    expect(body).toContain('Linux) os="linux"');
    expect(body).toContain('x86_64 | amd64) arch="amd64"');
    expect(body).toContain('arm64 | aarch64) arch="arm64"');
    expect(body).toContain('install-cli.ps1 | iex');

    expect(body).toContain('SLICC_INSTALL_DIR');
    expect(body).toContain('install_dir="$HOME/.local/bin"');
    expect(body).toContain('[ -w /usr/local/bin ]');
  });

  it('pins the script to a staging origin when served from one', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://slicc-tray-hub-staging.minivelos.workers.dev/install-cli'),
      env
    );
    const body = await response.text();
    expect(body).toContain(
      'https://slicc-tray-hub-staging.minivelos.workers.dev/download/slicc-cli/$os-$arch'
    );
  });

  it('answers HEAD requests', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/install-cli', { method: 'HEAD' }),
      env
    );
    expect(response.status).toBe(200);
  });

  it('maps Git Bash / MSYS unames to the windows .exe and WSL to linux', async () => {
    const { env } = createTestHarness();
    const body = await (
      await handleWorkerRequest(new Request('https://www.sliccy.ai/install-cli'), env)
    ).text();
    expect(body).toContain('MINGW* | MSYS* | CYGWIN*)');
    expect(body).toContain('bin_name="slicc.exe"');

    expect(body).toContain('Linux) os="linux"');

    expect(body).toContain('irm https://www.sliccy.ai/install-cli.ps1 | iex');
  });

  it('serves the PowerShell installer at /install-cli.ps1 pinned to the serving origin', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/install-cli.ps1'),
      env
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/x-powershell');
    const body = await response.text();
    expect(body).toContain('https://www.sliccy.ai/download/slicc-cli/windows-$arch');
    expect(body).toContain("Join-Path $env:LOCALAPPDATA 'Programs\\slicc'");

    expect(body).toContain('& $tmp --version');
    expect(body).toContain("[Environment]::SetEnvironmentVariable('Path'");
    expect(body).toContain('$env:SLICC_INSTALL_DIR');
  });

  it('answers HEAD for the PowerShell installer', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/install-cli.ps1', { method: 'HEAD' }),
      env
    );
    expect(response.status).toBe(200);
  });

  it('locks curl to https on https origins but not on the http dev origin', async () => {
    const { env } = createTestHarness();
    const httpsBody = await (
      await handleWorkerRequest(new Request('https://www.sliccy.ai/install-cli'), env)
    ).text();
    expect(httpsBody).toContain("--proto '=https'");

    const httpBody = await (
      await handleWorkerRequest(new Request('http://www.sliccy.ai/install-cli'), env)
    ).text();
    expect(httpBody).not.toContain('--proto');
    expect(httpBody).toContain('curl -fSL -o');
  });
});

describe('GET /download/slicc-cli/:target', () => {
  const CLI_DOWNLOAD_URL = 'https://www.sliccy.ai/download/slicc-cli/darwin-arm64';
  const ASSET_URL =
    'https://github.com/ai-ecoverse/slicc/releases/download/v5.71.1/slicc-darwin-arm64';

  function cliRelease(assets: Array<{ name: string; url: string }>, extra = {}) {
    return {
      draft: false,
      prerelease: false,
      ...extra,
      assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url })),
    };
  }

  it('redirects to the newest release carrying the target binary, skipping binary-less releases', async () => {
    const { env } = createTestHarness();
    const releases = [
      cliRelease([{ name: 'sliccy-5.72.0.tgz', url: 'x' }]),
      cliRelease([
        { name: 'slicc-darwin-arm64', url: ASSET_URL },
        { name: 'slicc-linux-amd64', url: 'y' },
      ]),
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(ASSET_URL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('api.github.com');
  });

  it('skips draft and prerelease releases', async () => {
    const { env } = createTestHarness();
    const releases = [
      cliRelease([{ name: 'slicc-darwin-arm64', url: 'draft' }], { draft: true }),
      cliRelease([{ name: 'slicc-darwin-arm64', url: 'pre' }], { prerelease: true }),
      cliRelease([{ name: 'slicc-darwin-arm64', url: ASSET_URL }]),
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.headers.get('Location')).toBe(ASSET_URL);
  });

  it('maps windows targets to the .exe asset name', async () => {
    const { env } = createTestHarness();
    const exeUrl =
      'https://github.com/ai-ecoverse/slicc/releases/download/v5.71.1/slicc-windows-amd64.exe';
    const releases = [cliRelease([{ name: 'slicc-windows-amd64.exe', url: exeUrl }])];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(releases), { status: 200 }));

    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/download/slicc-cli/windows-amd64'),
      env,
      fetchImpl
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(exeUrl);
  });

  it('404s an unknown target without calling GitHub', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi.fn<typeof fetch>();
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/download/slicc-cli/freebsd-amd64'),
      env,
      fetchImpl
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('darwin-arm64');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404s a typo-cased target instead of falling through to the SPA 200 page', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi.fn<typeof fetch>();
    const res = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/download/slicc-cli/DARWIN-ARM64'),
      env,
      fetchImpl
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('404s with an explanation when no recent release carries the binary (sparse releases)', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify([cliRelease([{ name: 'notes.txt', url: 'x' }])]), {
          status: 200,
        })
    );

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('slicc-darwin-arm64');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paginates past a full page of binary-less releases', async () => {
    const { env } = createTestHarness();
    const page1 = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, () =>
      cliRelease([{ name: 'notes.txt', url: 'x' }])
    );
    const page2 = [cliRelease([{ name: 'slicc-darwin-arm64', url: ASSET_URL }])];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(ASSET_URL);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('page=2');
  });

  it('gives up after the page cap with a 404 instead of unbounded GitHub calls', async () => {
    const { env } = createTestHarness();
    const fullPage = Array.from({ length: GITHUB_RELEASES_PER_PAGE }, () =>
      cliRelease([{ name: 'notes.txt', url: 'x' }])
    );
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(fullPage), { status: 200 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(GITHUB_RELEASES_MAX_PAGES);
  });

  it('502s when the GitHub API responds non-OK so curl -f fails loudly', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('rate limited', { status: 403 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('403');
  });

  it('502s when the GitHub API throws', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('network down');
  });

  it('502s on unparseable GitHub JSON', async () => {
    const { env } = createTestHarness();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    const res = await handleWorkerRequest(new Request(CLI_DOWNLOAD_URL), env, fetchImpl);
    expect(res.status).toBe(502);
  });
});
