import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from './index.js';
import { TRAY_RECLAIM_TTL_MS, type DurableObjectIdLike, type DurableObjectStateLike, type TrayRecord } from './shared.js';
import { SessionTrayDurableObject } from './session-tray.js';

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

  addEventListener(type: 'message' | 'close' | 'error', listener: (event: { data?: string }) => void): void {
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

  get(id: DurableObjectIdLike): { fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response> } {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      const state = new FakeDurableObjectState();
      this.states.set(key, state);
      instance = new SessionTrayDurableObject(state, {}, { now: this.now, webSocketPairFactory: createFakeWebSocketPair });
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

function createTestHarness(start = Date.parse('2026-03-11T00:00:00.000Z')): {
  env: { TRAY_HUB: FakeNamespace };
  advance: (ms: number) => void;
  readTray: (trayId: string) => Promise<TrayRecord | undefined>;
} {
  let now = start;
  const namespace = new FakeNamespace(() => now);
  return {
    env: { TRAY_HUB: namespace },
    advance: (ms: number) => {
      now += ms;
    },
    readTray: (trayId: string) => namespace.readTray(trayId),
  };
}

describe('tray worker skeleton', () => {
  it('creates a tray at /tray and rejects removed create aliases', async () => {
    const { env } = createTestHarness();

    const response = await handleWorkerRequest(new Request('https://tray.test/tray', { method: 'POST' }), env);
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      trayId: string;
      capabilities: { join: { url: string }; controller: { url: string }; webhook: { url: string } };
    };
    expect(body.capabilities.join.url).toContain(`/join/${body.trayId}.`);
    expect(body.capabilities.controller.url).toContain(`/controller/${body.trayId}.`);
    expect(body.capabilities.webhook.url).toContain(`/webhook/${body.trayId}.`);

    for (const legacyPath of ['/session', '/trays']) {
      const legacy = await handleWorkerRequest(new Request(`https://tray.test${legacyPath}`, { method: 'POST' }), env);
      expect(legacy.status).toBe(410);
      await expect(legacy.json()).resolves.toMatchObject({
        code: 'TRAY_CREATE_ENDPOINT_MOVED',
        canonical: 'POST /tray',
      });
    }
  });

  it('elects the first controller as leader and leaves later controllers as followers', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(new Request('https://tray.test/tray', { method: 'POST' }), env);
    const session = (await created.json()) as {
      trayId: string;
      capabilities: { controller: { url: string }; join: { url: string } };
    };

    const joinResponse = await handleWorkerRequest(new Request(session.capabilities.join.url), env);
    expect(joinResponse.status).toBe(200);

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-1', runtime: 'cli' }),
      }),
      env,
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
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'cone-2', runtime: 'electron' }),
      }),
      env,
    );
    const follower = (await followerAttach.json()) as { role: string; websocket: unknown; leader: { controllerId: string } };

    expect(follower.role).toBe('follower');
    expect(follower.websocket).toBeNull();
    expect(follower.leader.controllerId).toBe('cone-1');
  });

  it('allows only the leader to open the tray WebSocket', async () => {
    const { env } = createTestHarness();
    const created = await handleWorkerRequest(new Request('https://tray.test/tray', { method: 'POST' }), env);
    const session = (await created.json()) as { capabilities: { controller: { url: string } } };

    const leaderAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env,
    );
    const leader = (await leaderAttach.json()) as { leaderKey: string; websocket: { url: string } };

    const followerAttach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'follow-1' }),
      }),
      env,
    );
    const follower = (await followerAttach.json()) as { controllerId: string };

    const denied = await handleWorkerRequest(
      new Request(`${session.capabilities.controller.url}?controllerId=${follower.controllerId}&leaderKey=wrong`, {
        headers: { Upgrade: 'websocket' },
      }),
      env,
    );
    expect(denied.status).toBe(403);

    const accepted = await handleWorkerRequest(new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }), env);
    expect(accepted.status).toBe(101);
    const socket = (accepted as unknown as { webSocket: FakeWebSocket }).webSocket;
    expect(socket).toBeDefined();
    expect(socket.received[0]).toContain('leader.connected');
  });

  it('rejects webhooks without a live leader and does not buffer payload state', async () => {
    const { env, readTray } = createTestHarness();
    const created = await handleWorkerRequest(new Request('https://tray.test/tray', { method: 'POST' }), env);
    const session = (await created.json()) as { trayId: string; capabilities: { controller: { url: string }; webhook: { url: string } } };

    await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env,
    );

    const rejected = await handleWorkerRequest(
      new Request(session.capabilities.webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      }),
      env,
    );

    expect(rejected.status).toBe(410);
    const tray = await readTray(session.trayId);
    expect(tray?.leader?.connected).toBe(false);
    expect(Object.keys(tray ?? {})).not.toContain('pendingWebhooks');
  });

  it('supports leader reconnect with the issued key and expires after one hour without reclaim', async () => {
    const { env, advance } = createTestHarness();
    const created = await handleWorkerRequest(new Request('https://tray.test/tray', { method: 'POST' }), env);
    const session = (await created.json()) as { capabilities: { controller: { url: string } } };

    const attach = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-1' }),
      }),
      env,
    );
    const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };

    const wsResponse = await handleWorkerRequest(new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }), env);
    const clientSocket = (wsResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
    clientSocket.close();

    const reclaim = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-2', leaderKey: leader.leaderKey }),
      }),
      env,
    );
    const reclaimBody = (await reclaim.json()) as { role: string; leader: { controllerId: string; connected: boolean } };
    expect(reclaimBody.role).toBe('leader');
    expect(reclaimBody.leader.controllerId).toBe('lead-2');

    const reclaimedSocketResponse = await handleWorkerRequest(
      new Request(`${session.capabilities.controller.url}?controllerId=lead-2&leaderKey=${leader.leaderKey}`, {
        headers: { Upgrade: 'websocket' },
      }),
      env,
    );
    const reclaimedClientSocket = (reclaimedSocketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
    reclaimedClientSocket.close();

    advance(TRAY_RECLAIM_TTL_MS + 1);
    const expired = await handleWorkerRequest(
      new Request(session.capabilities.controller.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ controllerId: 'lead-3' }),
      }),
      env,
    );
    expect(expired.status).toBe(410);
  });

  it('advertises /tray as the only create route in service metadata', async () => {
    const { env } = createTestHarness();
    const response = await handleWorkerRequest(new Request('https://tray.test/'), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      routes: ['POST /tray', 'GET|POST /join/:token', 'GET|POST /controller/:token', 'POST /webhook/:token'],
    });
  });
});