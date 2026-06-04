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

  idFromName(name: string): DurableObjectIdLike {
    return new FakeDurableObjectId(name);
  }

  get(id: DurableObjectIdLike): SessionTrayDurableObject {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      instance = new SessionTrayDurableObject(
        new FakeDurableObjectState(),
        {},
        { now: () => Date.now(), webSocketPairFactory: createFakeWebSocketPair }
      );
      this.instances.set(key, instance);
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
  const created = await handleWorkerRequest(
    new Request('https://tray.test/tray', { method: 'POST' }),
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
  await handleWorkerRequest(
    new Request(leader.websocket.url, { headers: { Upgrade: 'websocket' } }),
    env
  );

  const controllerUrl = new URL(session.capabilities.controller.url);
  const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';
  const stub = namespace.get(namespace.idFromName(session.trayId));

  return { trayId: session.trayId, controllerToken, stub };
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
    expect(result.url).toMatch(/^https:\/\/[^.]+\.[0-9a-f]+\.preview\.sliccy\.ai\/$/);

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
