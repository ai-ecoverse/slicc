import { describe, expect, it } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';

interface FakeWebSocket {
  sent: string[];
  received: string[];
  peer: FakeWebSocket | null;
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: string }) => void
  ): void;
}

interface TestHarness {
  env: {
    TRAY_HUB: {
      idFromName(name: string): { toString(): string };
      get(id: { toString(): string }): {
        fetch(request: Request): Promise<Response>;
      };
    };
  };
}

function createTestHarness(): TestHarness {
  class FakeStorage {
    private readonly data = new Map<string, unknown>();

    async get<T>(key: string): Promise<T | undefined> {
      return this.data.get(key) as T | undefined;
    }

    async put<T>(key: string, value: T): Promise<void> {
      this.data.set(key, value);
    }
  }

  class FakeDurableObjectState {
    readonly storage = new FakeStorage();
  }

  class FakeWebSocketImpl implements FakeWebSocket {
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
      if (this.peer) {
        this.peer.received.push(data);
        for (const listener of this.peer.listeners.get('message') ?? []) {
          listener({ data });
        }
      }
    }

    close(): void {}
  }

  const durableObjects = new Map<string, SessionTrayDurableObject>();

  return {
    env: {
      TRAY_HUB: {
        idFromName(name: string) {
          return { toString: () => name };
        },
        get(id: { toString(): string }) {
          const key = id.toString();
          let instance = durableObjects.get(key);
          if (!instance) {
            instance = new SessionTrayDurableObject(
              new FakeDurableObjectState() as never,
              {},
              {
                now: () => Date.now(),
                webSocketPairFactory: () => {
                  const client = new FakeWebSocketImpl();
                  const server = new FakeWebSocketImpl();
                  client.peer = server;
                  server.peer = client;
                  return { client, server };
                },
              }
            );
            durableObjects.set(key, instance);
          }
          return instance;
        },
      },
    },
  };
}

describe('SessionTrayDurableObject preview methods', () => {
  it('mintPreview stores a record and returns a token + URL', async () => {
    const { env } = createTestHarness();

    // Create a tray
    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string } };
      trayId: string;
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

    // Get DO instance and call mintPreview directly
    const trayId = session.trayId;
    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(trayId));

    // Extract controllerToken from the capabilities URL
    const controllerUrl = new URL(session.capabilities.controller.url);
    const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';

    const result = (await (
      stub as { mintPreview: (...args: unknown[]) => Promise<unknown> }
    ).mintPreview({
      controllerToken,
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    })) as { previewToken: string; url: string };

    expect(result.previewToken).toMatch(/^[^.]+\.[0-9a-f]+$/);
    expect(result.url).toMatch(/^https:\/\/[^.]+\.[0-9a-f]+\.preview\.sliccy\.ai\/$/);

    const record = (await (
      stub as { resolvePreview: (...args: unknown[]) => Promise<unknown> }
    ).resolvePreview(result.previewToken)) as {
      servedRoot: string;
      entryPath: string;
      allowLive: boolean;
    } | null;

    expect(record).toMatchObject({
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
    });
  });

  it('mintPreview rejects when controllerToken is wrong', async () => {
    const { env } = createTestHarness();

    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { trayId: string };

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(session.trayId));

    await expect(
      (stub as { mintPreview: (...args: unknown[]) => Promise<unknown> }).mintPreview({
        controllerToken: 'wrong.token',
        servedRoot: '/x',
        entryPath: '/x/i.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
      })
    ).rejects.toThrow(/invalid|forbidden/i);
  });

  it('resolvePreview returns null for unknown tokens', async () => {
    const { env } = createTestHarness();

    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { trayId: string };

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(session.trayId));

    const result = await (
      stub as { resolvePreview: (...args: unknown[]) => Promise<unknown> }
    ).resolvePreview('bogus.abc');
    expect(result).toBeNull();
  });

  it('revokePreview deletes the record and returns { revoked: true }', async () => {
    const { env } = createTestHarness();

    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string } };
      trayId: string;
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

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(session.trayId));

    const controllerUrl = new URL(session.capabilities.controller.url);
    const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';

    const { previewToken } = (await (
      stub as { mintPreview: (...args: unknown[]) => Promise<unknown> }
    ).mintPreview({
      controllerToken,
      servedRoot: '/w',
      entryPath: '/w/i.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    })) as { previewToken: string };

    const revokeResult = await (
      stub as { revokePreview: (...args: unknown[]) => Promise<unknown> }
    ).revokePreview(previewToken);
    expect(revokeResult).toEqual({ revoked: true });

    const resolveResult = await (
      stub as { resolvePreview: (...args: unknown[]) => Promise<unknown> }
    ).resolvePreview(previewToken);
    expect(resolveResult).toBeNull();
  });

  it('revokePreview on unknown token returns { revoked: false }', async () => {
    const { env } = createTestHarness();

    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as { trayId: string };

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(session.trayId));

    const result = await (
      stub as { revokePreview: (...args: unknown[]) => Promise<unknown> }
    ).revokePreview('nope.0');
    expect(result).toEqual({ revoked: false });
  });

  it('listPreviews returns all active records', async () => {
    const { env } = createTestHarness();

    const created = await handleWorkerRequest(
      new Request('https://tray.test/tray', { method: 'POST' }),
      env
    );
    const session = (await created.json()) as {
      capabilities: { controller: { url: string } };
      trayId: string;
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

    const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(session.trayId));

    const controllerUrl = new URL(session.capabilities.controller.url);
    const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';

    for (const dir of ['/workspace/a', '/workspace/b']) {
      await (stub as { mintPreview: (...args: unknown[]) => Promise<unknown> }).mintPreview({
        controllerToken,
        servedRoot: dir,
        entryPath: `${dir}/i.html`,
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
      });
    }

    const previews = (await (
      stub as { listPreviews: () => Promise<unknown[]> }
    ).listPreviews()) as unknown[];
    expect(previews).toHaveLength(2);
  });
});
