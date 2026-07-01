import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import type { DurableObjectIdLike, DurableObjectStateLike } from '../src/shared.js';

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
  instance: SessionTrayDurableObject | null = null;
  private readonly sockets: Array<{ ws: FakeWebSocket; tags: string[] }> = [];

  acceptWebSocket(ws: FakeWebSocket, tags: string[] = []): void {
    this.sockets.push({ ws, tags });
    ws.addEventListener('message', (event) => {
      void this.instance?.webSocketMessage(ws, event.data ?? '');
    });
    ws.addEventListener('close', () => {
      const index = this.sockets.findIndex((entry) => entry.ws === ws);
      if (index >= 0) {
        this.sockets.splice(index, 1);
      }
      void this.instance?.webSocketClose(ws);
    });
    ws.addEventListener('error', () => {
      void this.instance?.webSocketError(ws);
    });
  }

  getWebSockets(tag?: string): FakeWebSocket[] {
    return this.sockets
      .filter((entry) => tag === undefined || entry.tags.includes(tag))
      .map((entry) => entry.ws);
  }
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
  private readonly instances = new Map<string, SessionTrayDurableObject>();
  private readonly states = new Map<string, FakeDurableObjectState>();

  idFromName(name: string): DurableObjectIdLike {
    return new FakeDurableObjectId(name);
  }

  get(id: DurableObjectIdLike): SessionTrayDurableObject {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      const state = new FakeDurableObjectState();
      instance = new SessionTrayDurableObject(
        state,
        {},
        { now: () => Date.now(), webSocketPairFactory: createFakeWebSocketPair }
      );
      state.instance = instance;
      this.instances.set(key, instance);
      this.states.set(key, state);
    }
    return instance;
  }

  /**
   * Simulate Cloudflare evicting the DO from memory and re-instantiating it.
   * Rebuilds the object against the SAME `FakeDurableObjectState` (storage +
   * accepted WebSockets survive) but with fresh in-memory fields — mirroring
   * real hibernation, where `leaderSocket`/`tray` reset to null and must be
   * recovered via `restoreLeaderSocket()` / `loadTray()`.
   */
  simulateHibernation(trayId: string): void {
    const key = new FakeDurableObjectId(trayId).toString();
    const state = this.states.get(key);
    if (!state) return;
    const fresh = new SessionTrayDurableObject(
      state,
      {},
      { now: () => Date.now(), webSocketPairFactory: createFakeWebSocketPair }
    );
    state.instance = fresh;
    this.instances.set(key, fresh);
  }
}

const MOCK_HTML = '<html><body>SPA</body></html>';
const fakeAssets = {
  fetch: async (_req: Request) =>
    new Response(MOCK_HTML, { headers: { 'content-type': 'text/html' } }),
};

const fakeCloudSessions = {
  idFromName: (_name: string) => ({ toString: () => 'fake-cloud-id' }),
  idFromString: (_id: string) => ({ toString: () => 'fake-cloud-id' }),
  newUniqueId: () => ({ toString: () => 'fake-cloud-id' }),
  get: (_id: unknown) => ({
    fetch: async (_req: Request) => new Response('cloud DO not stubbed', { status: 501 }),
  }),
};

function createTestHarness() {
  const namespace = new FakeNamespace();
  return {
    env: {
      TRAY_HUB: namespace as unknown as Parameters<typeof handleWorkerRequest>[1]['TRAY_HUB'],
      ASSETS: fakeAssets,
      CLOUD_SESSIONS: fakeCloudSessions,
    } as unknown as Parameters<typeof handleWorkerRequest>[1],
    namespace,
  };
}

interface PreviewDOMethods {
  mintPreview(opts: {
    controllerToken: string;
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
    workerBaseUrl: string;
  }): Promise<{ previewToken: string; url: string }>;
  resolvePreview(previewToken: string): Promise<{
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
  } | null>;
  revokePreview(previewToken: string): Promise<{ revoked: boolean }>;
  listPreviews(): Promise<unknown[]>;
}

function asPreview(stub: SessionTrayDurableObject): PreviewDOMethods {
  return stub as unknown as PreviewDOMethods;
}

async function createTrayAndAttachLeader(
  env: ReturnType<typeof createTestHarness>['env'],
  namespace: FakeNamespace
): Promise<{
  trayId: string;
  controllerToken: string;
  stub: SessionTrayDurableObject;
}> {
  const { trayId, controllerToken, stub } = await createTrayAttachLeaderWithSocket(env, namespace);
  return { trayId, controllerToken, stub };
}

// Variant that also exposes the leader-side WebSocket so tests can install
// a `message` listener and respond to `preview.request` messages.
async function createTrayAttachLeaderWithSocket(
  env: ReturnType<typeof createTestHarness>['env'],
  namespace: FakeNamespace,
  options: { workerHost?: string } = {}
): Promise<{
  trayId: string;
  controllerToken: string;
  stub: SessionTrayDurableObject;
  clientSocket: FakeWebSocket;
}> {
  const host = options.workerHost ?? 'www.sliccy.ai';
  const created = await handleWorkerRequest(
    new Request(`https://${host}/tray`, { method: 'POST' }),
    env
  );
  const session = (await created.json()) as {
    capabilities: { controller: { url: string } };
    trayId: string;
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
  const socketResponse = await handleWorkerRequest(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
    env
  );
  const clientSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

  const controllerUrl = new URL(session.capabilities.controller.url);
  const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';
  const stub = namespace.get(namespace.idFromName(session.trayId));

  return { trayId: session.trayId, controllerToken, stub, clientSocket };
}

describe('SessionTrayDurableObject preview methods', () => {
  it('mintPreview stores a record and returns a token + URL', async () => {
    const { env, namespace } = createTestHarness();
    const { controllerToken, stub } = await createTrayAndAttachLeader(env, namespace);

    const result = await asPreview(stub).mintPreview({
      controllerToken,
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    });

    expect(result.previewToken).toMatch(/^[^.]+\.[0-9a-f]+$/);
    expect(result.url).toMatch(/^https:\/\/[0-9a-f]{32}--[0-9a-f]+\.sliccy\.now\/$/);

    const record = await asPreview(stub).resolvePreview(result.previewToken);
    expect(record).toMatchObject({
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
    });
  });

  it('mintPreview rejects when controllerToken is wrong', async () => {
    const { env, namespace } = createTestHarness();
    const { stub } = await createTrayAndAttachLeader(env, namespace);

    await expect(
      asPreview(stub).mintPreview({
        controllerToken: 'wrong.token',
        servedRoot: '/x',
        entryPath: '/x/i.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
      })
    ).rejects.toThrow(/invalid|forbidden/i);
  });

  it('resolvePreview returns null for unknown tokens', async () => {
    const { env, namespace } = createTestHarness();
    const { stub } = await createTrayAndAttachLeader(env, namespace);

    const result = await asPreview(stub).resolvePreview('bogus.abc');
    expect(result).toBeNull();
  });

  it('revokePreview deletes the record and returns { revoked: true }', async () => {
    const { env, namespace } = createTestHarness();
    const { controllerToken, stub } = await createTrayAndAttachLeader(env, namespace);

    const { previewToken } = await asPreview(stub).mintPreview({
      controllerToken,
      servedRoot: '/w',
      entryPath: '/w/i.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    });

    const revokeResult = await asPreview(stub).revokePreview(previewToken);
    expect(revokeResult).toEqual({ revoked: true });

    const resolveResult = await asPreview(stub).resolvePreview(previewToken);
    expect(resolveResult).toBeNull();
  });

  it('revokePreview on unknown token returns { revoked: false }', async () => {
    const { env, namespace } = createTestHarness();
    const { stub } = await createTrayAndAttachLeader(env, namespace);

    const result = await asPreview(stub).revokePreview('nope.0');
    expect(result).toEqual({ revoked: false });
  });

  it('listPreviews returns all active records', async () => {
    const { env, namespace } = createTestHarness();
    const { controllerToken, stub } = await createTrayAndAttachLeader(env, namespace);

    for (const dir of ['/workspace/a', '/workspace/b']) {
      await asPreview(stub).mintPreview({
        controllerToken,
        servedRoot: dir,
        entryPath: `${dir}/i.html`,
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
      });
    }

    const previews = await asPreview(stub).listPreviews();
    expect(previews).toHaveLength(2);
  });
});

// Helper: mint a preview via the public worker route and return token + URL.
async function mintPreviewViaWorker(
  env: ReturnType<typeof createTestHarness>['env'],
  trayId: string,
  controllerToken: string,
  body: { servedRoot: string; entryPath: string; allowLive: boolean } = {
    servedRoot: '/workspace/dist',
    entryPath: '/workspace/dist/index.html',
    allowLive: false,
  }
): Promise<{ previewToken: string; url: string }> {
  const res = await handleWorkerRequest(
    new Request(`https://www.sliccy.ai/api/tray/${trayId}/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${controllerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env
  );
  if (res.status !== 200) {
    throw new Error(`mint failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { previewToken: string; url: string };
}

describe('preview HTTP handler', () => {
  it('end-to-end: mint -> GET preview URL -> leader responds -> bytes returned', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    // Install leader-side responder BEFORE the GET (the GET awaits the response).
    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as {
        type: string;
        reqId?: string;
        vfsPath?: string;
      };
      if (msg.type === 'preview.request' && msg.reqId) {
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: true,
            mime: 'text/html',
            chunkIndex: 0,
            totalChunks: 1,
            content: '<h1>hello</h1>',
            encoding: 'utf-8',
          })
        );
      }
    });

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>hello</h1>');
  });

  it('preview fetch succeeds after DO hibernation (leader socket is recovered)', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as { type: string; reqId?: string };
      if (msg.type === 'preview.request' && msg.reqId) {
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: true,
            mime: 'text/html',
            chunkIndex: 0,
            totalChunks: 1,
            content: '<h1>after hibernation</h1>',
            encoding: 'utf-8',
          })
        );
      }
    });

    // Simulate the runtime evicting the DO from memory and re-instantiating it.
    // Storage and the accepted WebSocket survive (Cloudflare hibernation API),
    // but in-memory fields like `leaderSocket` reset to null until restored.
    namespace.simulateHibernation(trayId);

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>after hibernation</h1>');
  });

  it('joins servedRoot with the URL subpath when path is not /', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    let observedVfsPath: string | undefined;
    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as {
        type: string;
        reqId?: string;
        vfsPath?: string;
      };
      if (msg.type === 'preview.request' && msg.reqId) {
        observedVfsPath = msg.vfsPath;
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: true,
            mime: 'text/css',
            chunkIndex: 0,
            totalChunks: 1,
            content: 'body { color: red; }',
            encoding: 'utf-8',
          })
        );
      }
    });

    // Hit a subpath rather than `/` — exercises joinUnderRoot under servedRoot.
    const subpathUrl = new URL(url);
    subpathUrl.pathname = '/css/site.css';
    const res = await handleWorkerRequest(new Request(subpathUrl.toString()), env);
    expect(res.status).toBe(200);
    expect(observedVfsPath).toBe('/workspace/dist/css/site.css');
  });

  it('returns 404 for unknown token host', async () => {
    const { env } = createTestHarness();
    const res = await handleWorkerRequest(
      new Request('https://00000000000000000000000000000000--deadbeef.sliccy.now/'),
      env
    );
    expect(res.status).toBe(404);
  });

  it('returns 502 when leader is disconnected', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    // Close the leader WS so hasLiveLeader() returns false.
    clientSocket.close();

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(502);
  });

  it('returns 403 when leader sends ok:false status:403', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as { type: string; reqId?: string };
      if (msg.type === 'preview.request' && msg.reqId) {
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: false,
            status: 403,
            reason: 'outside servedRoot',
          })
        );
      }
    });

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(403);
  });

  it('returns 404 when leader sends ok:false status:404', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as { type: string; reqId?: string };
      if (msg.type === 'preview.request' && msg.reqId) {
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: false,
            status: 404,
            reason: 'no such file',
          })
        );
      }
    });

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(404);
  });

  it('omits Access-Control-Allow-Origin between preview subdomains', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { url } = await mintPreviewViaWorker(env, trayId, controllerToken);

    clientSocket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data ?? '{}') as { type: string; reqId?: string };
      if (msg.type === 'preview.request' && msg.reqId) {
        clientSocket.send(
          JSON.stringify({
            type: 'preview.response',
            reqId: msg.reqId,
            ok: true,
            mime: 'text/html',
            chunkIndex: 0,
            totalChunks: 1,
            content: '<h1>hello</h1>',
            encoding: 'utf-8',
          })
        );
      }
    });

    const res = await handleWorkerRequest(new Request(url), env);
    expect(res.status).toBe(200);
    // Preview tabs must not be able to fetch from each other's subdomain cross-origin.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preview.purge bumps cacheVersion on the matching preview record', async () => {
    const { env, namespace } = createTestHarness();
    const { trayId, controllerToken, clientSocket } = await createTrayAttachLeaderWithSocket(
      env,
      namespace
    );
    const { previewToken } = await mintPreviewViaWorker(env, trayId, controllerToken);

    // Resolve to check initial cacheVersion
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(trayId));
    const before = await stub.fetch(
      new Request(
        `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
      )
    );
    const beforeRec = (await before.json()) as { cacheVersion: number };
    expect(beforeRec.cacheVersion).toBe(1);

    // Leader sends a preview.purge message
    clientSocket.send(JSON.stringify({ type: 'preview.purge', previewToken }));

    // Give the async handler a tick
    await new Promise((r) => setTimeout(r, 50));

    const after = await stub.fetch(
      new Request(
        `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
      )
    );
    const afterRec = (await after.json()) as { cacheVersion: number };
    expect(afterRec.cacheVersion).toBe(2);
  });
});
