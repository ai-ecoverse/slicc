import { buildPreviewUrl } from '@slicc/shared-ts';
import { expect } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import {
  createFakeWebSocketPair,
  FakeDurableObjectState,
  type FakeWebSocket,
} from './fake-do-state.js';
import { makeEnv } from './helpers/fake-env.js';
import { previewHomeBindings } from './helpers/preview-home.js';

class FakeDurableObjectId {
  constructor(private readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

class FakeNamespace {
  readonly states = new Map<string, FakeDurableObjectState>();
  private readonly instances = new Map<string, SessionTrayDurableObject>();

  constructor(private readonly options: { previewStorage?: R2Bucket; now?: () => number } = {}) {}

  idFromName(name: string): { toString: () => string } {
    return new FakeDurableObjectId(name);
  }

  get(id: { toString: () => string }): SessionTrayDurableObject {
    const key = id.toString();
    let instance = this.instances.get(key);
    if (!instance) {
      const state = new FakeDurableObjectState();
      this.states.set(key, state);
      instance = new SessionTrayDurableObject(
        // biome-ignore lint/suspicious/noExplicitAny: Test helper needs to construct DO with fake state
        state as any,
        { TRAY_HUB: this, PREVIEW_STORAGE: this.options.previewStorage },
        {
          now: this.options.now ?? (() => Date.now()),
          webSocketPairFactory: () => createFakeWebSocketPair(state),
        }
      );
      state.instance = instance;
      this.instances.set(key, instance);
    }
    return instance;
  }

  reconstruct(name: string): SessionTrayDurableObject {
    const state = this.states.get(name);
    if (!state) throw new Error(`No Durable Object state for ${name}`);
    const instance = new SessionTrayDurableObject(
      state as never,
      { TRAY_HUB: this, PREVIEW_STORAGE: this.options.previewStorage },
      {
        now: this.options.now ?? (() => Date.now()),
        webSocketPairFactory: () => createFakeWebSocketPair(state),
      }
    );
    state.instance = instance;
    this.instances.set(name, instance);
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

export function createTestEnv(options: { previewStorage?: R2Bucket; now?: () => number } = {}) {
  const namespace = new FakeNamespace(options);
  return {
    env: makeEnv({
      // biome-ignore lint/suspicious/noExplicitAny: Test env type is complex and not fully typed
      TRAY_HUB: namespace as unknown as any,
      ASSETS: fakeAssets,
      CLOUD_SESSIONS: fakeCloudSessions,
      WEBHOOK_HOMES: previewHomeBindings,
      PREVIEW_STORAGE: options.previewStorage,
    }),
    namespace,
  };
}

export interface BridgeConnection {
  ws: FakeWebSocket;

  serverWs: FakeWebSocket;
  connId: string;
  sent: string[];
  closed: boolean;
}

export type LeaderMessage = { type?: string } & Record<string, unknown>;

export interface BridgeHarness {
  do: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  stub: { fetch: (req: Request) => Promise<Response> };
  leaderSent: LeaderMessage[];
  previewToken: string;
  workerBaseUrl: string;
  controllerToken: string;
  bridgeUrl: (path?: string) => string;
  mintBridgedPreview: (opts: {
    bridge: boolean;
    maxTabs?: number;
    webhookId?: string;
    quiet?: boolean;
  }) => Promise<string>;
  openBridge: () => Promise<BridgeConnection>;
  deliverLeaderMessage: (msg: unknown) => Promise<void>;
  deliverBridgeMessage: (b: BridgeConnection, msg: unknown) => Promise<void>;
  closeBridge: (b: BridgeConnection) => Promise<void>;
  revokePreview: (token: string) => Promise<void>;

  reconnectLeader: () => Promise<unknown[]>;
  reconstructDO: () => void;
}

export async function makeTrayWithConnectedLeader(opts: {
  bridge: boolean;
  maxTabs?: number;
  webhookId?: string;
  quiet?: boolean;
}): Promise<BridgeHarness> {
  const { env, namespace } = createTestEnv();
  const workerBaseUrl = 'https://www.sliccy.ai';

  const { session, leader, leaderSent, controllerToken, stub, state } = await setupConnectedLeader(
    env,
    namespace,
    workerBaseUrl
  );

  let activeStub = stub;
  const previewToken = await mintPreviewInternal(
    activeStub,
    controllerToken,
    workerBaseUrl,
    opts.bridge,
    opts.maxTabs ?? 20,
    opts.webhookId,
    opts.quiet
  );

  const harness: BridgeHarness = {
    get do() {
      return activeStub;
    },
    state,
    stub: { fetch: (req: Request) => activeStub.fetch(req) },
    leaderSent,
    previewToken,
    workerBaseUrl,
    controllerToken,

    bridgeUrl(path = '/__slicc/bridge') {
      return buildPreviewUrl(workerBaseUrl, previewToken, path);
    },

    async mintBridgedPreview(newOpts) {
      return mintPreviewInternal(
        activeStub,
        controllerToken,
        workerBaseUrl,
        newOpts.bridge,
        newOpts.maxTabs ?? 20,
        newOpts.webhookId,
        newOpts.quiet
      );
    },

    async openBridge() {
      const url = harness.bridgeUrl();
      const upgradeResponse = await activeStub.fetch(
        new Request(url, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://example.sliccy.now',
          },
        })
      );

      const bridgeWs = (upgradeResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

      let connId = '';
      if (bridgeWs.received.length > 0) {
        const welcome = JSON.parse(bridgeWs.received[0]);
        if (welcome.t === 'welcome' && welcome.connId) {
          connId = welcome.connId;
        }
      }

      const serverWs = state
        .getWebSockets('bridge')
        .find(
          (w) => (w.deserializeAttachment() as { connId?: string } | undefined)?.connId === connId
        );
      if (!serverWs) {
        throw new Error(`openBridge: no bridge server socket found for connId ${connId}`);
      }

      const conn: BridgeConnection = {
        ws: bridgeWs,
        serverWs,
        connId,
        sent: [],
        closed: false,
      };

      bridgeWs.addEventListener('close', () => {
        conn.closed = true;
      });

      return conn;
    },

    async deliverLeaderMessage(msg) {
      const leaderServer = state.getWebSockets('leader')[0];
      await activeStub.webSocketMessage(leaderServer as never, JSON.stringify(msg));
    },

    async deliverBridgeMessage(b, msg) {
      await activeStub.webSocketMessage(b.serverWs as never, JSON.stringify(msg));
    },

    async closeBridge(b) {
      await activeStub.webSocketClose(b.serverWs as never);
      b.closed = true;
    },

    async revokePreview(token) {
      const revokeUrl = `${workerBaseUrl}/api/tray/${session.trayId}/preview/stop`;
      await handleWorkerRequest(
        new Request(revokeUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${controllerToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ previewToken: token }),
        }),
        env
      );
    },

    reconnectLeader: () =>
      reconnectLeaderImpl({
        state,
        env,
        controllerUrl: session.capabilities.controller.url,
        leaderKey: leader.leaderKey,
      }),

    reconstructDO() {
      activeStub = namespace.reconstruct(session.trayId);
    },
  };

  return harness;
}

export async function setupConnectedLeader(
  env: ReturnType<typeof createTestEnv>['env'],
  namespace: FakeNamespace,
  workerBaseUrl: string
): Promise<{
  session: { capabilities: { controller: { url: string } }; trayId: string };
  leader: { leaderKey: string; websocket: { url: string } };
  leaderSent: LeaderMessage[];
  controllerToken: string;
  stub: SessionTrayDurableObject;
  state: FakeDurableObjectState;
}> {
  const created = await handleWorkerRequest(
    new Request(`${workerBaseUrl}/tray`, { method: 'POST' }),
    env
  );
  expect(created.status).toBe(201);
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
  const leaderSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

  const leaderSent: LeaderMessage[] = [];
  leaderSocket.addEventListener('message', (event: { data?: string }) => {
    if (event.data) leaderSent.push(JSON.parse(event.data) as LeaderMessage);
  });

  const controllerToken =
    new URL(session.capabilities.controller.url).pathname.split('/').pop() ?? '';
  const stub = namespace.get(namespace.idFromName(session.trayId));
  const state = namespace.states.get(session.trayId)!;

  return { session, leader, leaderSent, controllerToken, stub, state };
}

async function reconnectLeaderImpl(deps: {
  state: FakeDurableObjectState;
  env: unknown;
  controllerUrl: string;
  leaderKey: string;
}): Promise<unknown[]> {
  const { state, env, controllerUrl, leaderKey } = deps;
  state.getWebSockets('leader')[0]?.close();

  const attach = await handleWorkerRequest(
    new Request(controllerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'lead-1', leaderKey }),
    }),
    env as Parameters<typeof handleWorkerRequest>[1]
  );
  const reattached = (await attach.json()) as { websocket: { url: string } };
  const socketResponse = await handleWorkerRequest(
    new Request(reattached.websocket.url, { headers: { Upgrade: 'websocket' } }),
    env as Parameters<typeof handleWorkerRequest>[1]
  );
  const leaderSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;
  return leaderSocket.received.map((raw) => JSON.parse(raw));
}

async function mintPreviewInternal(
  stub: SessionTrayDurableObject,
  controllerToken: string,
  workerBaseUrl: string,
  bridge: boolean,
  maxTabs: number,
  webhookId?: string,
  quiet?: boolean
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: mintPreview is a private method we access for testing
  const result = await (stub as any).mintPreview({
    controllerToken,
    servedRoot: '/workspace/dist',
    entryPath: '/workspace/dist/index.html',
    allowLive: bridge,
    bridge,
    maxTabs,
    webhookId,
    quiet,
    workerBaseUrl,
  });
  return result.previewToken;
}
