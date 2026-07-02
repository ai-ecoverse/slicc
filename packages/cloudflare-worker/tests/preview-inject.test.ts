import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import type { DurableObjectIdLike, DurableObjectStateLike } from '../src/shared.js';

// Minimal fake infrastructure to test preview injection

class FakeStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
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

interface FakeEnvResult {
  env: ReturnType<typeof createTestHarness>['env'];
  namespace: FakeNamespace;
  previewHost: string;
  previewToken: string;
  clientSocket: FakeWebSocket;
}

/**
 * Build a fakeEnv with a valid preview host that returns record.bridge === opts.bridge.
 * Returns { env, previewHost, previewToken, clientSocket } for testing preview injection.
 */
async function fakeEnv(opts: { bridge: boolean }): Promise<FakeEnvResult> {
  const { env, namespace } = createTestHarness();

  // Create tray
  const created = await handleWorkerRequest(
    new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
    env
  );
  const session = (await created.json()) as {
    capabilities: { controller: { url: string } };
    trayId: string;
  };

  // Attach leader
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

  // Install a message listener on clientSocket to respond to preview.request
  clientSocket.addEventListener('message', (event) => {
    if (!event.data) return;
    const msg = JSON.parse(event.data);
    if (msg.type === 'preview.request') {
      const responseMsg = {
        type: 'preview.response',
        reqId: msg.reqId,
        ok: true,
        status: 200,
        mime: 'text/html; charset=utf-8',
        encoding: 'utf-8' as const,
        chunkIndex: 0,
        totalChunks: 1,
        content: '<html><head></head><body>Test content</body></html>',
      };
      clientSocket.send(JSON.stringify(responseMsg));
    }
  });

  // Mint a preview token
  const mintRes = await stub.fetch(
    new Request('https://internal/internal/preview/mint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        controllerToken,
        workerBaseUrl: 'https://www.sliccy.ai',
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: false,
        bridge: opts.bridge,
        maxTabs: 1,
      }),
    })
  );
  const { previewToken, url } = (await mintRes.json()) as { previewToken: string; url: string };
  const previewHost = new URL(url).host;

  return {
    env,
    namespace,
    previewHost,
    previewToken,
    clientSocket,
  };
}

describe('preview-inject', () => {
  it('injects the bootstrap script + connect-src only for bridged html', async () => {
    const { env, previewHost } = await fakeEnv({ bridge: true });

    const res = await handleWorkerRequest(new Request(`https://${previewHost}/`), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/__slicc/preview-bridge.js');
    expect(html).toContain('data-slicc-token="');
    expect(html).toContain('data-slicc-ws="');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toMatch(/connect-src 'self' wss:\/\//);
  });

  it('does not inject for non-bridged previews', async () => {
    const { env, previewHost } = await fakeEnv({ bridge: false });

    const res = await handleWorkerRequest(new Request(`https://${previewHost}/`), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('/__slicc/preview-bridge.js');
  });
});
