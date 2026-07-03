/**
 * Test harness for preview bridge feature (Tasks 5-7).
 *
 * Provides concrete, executable helpers that drive the SessionTrayDurableObject
 * WebSocket hibernation APIs to simulate bridge tab connections, leader control
 * messages, and preview lifecycle operations.
 */

import { buildPreviewUrl } from '@slicc/shared-ts';
import { handleWorkerRequest } from '../src/index.js';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import {
  createFakeWebSocketPair,
  FakeDurableObjectState,
  type FakeWebSocket,
} from './fake-do-state.js';

// ──────────────────────────────────────────────────────────────────────────
// Test environment setup (mirrors session-tray-preview.test.ts)
// ──────────────────────────────────────────────────────────────────────────

class FakeDurableObjectId {
  constructor(private readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

class FakeNamespace {
  readonly states = new Map<string, FakeDurableObjectState>();
  private readonly instances = new Map<string, SessionTrayDurableObject>();

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
        {},
        {
          now: () => Date.now(),
          webSocketPairFactory: () => createFakeWebSocketPair(state),
        }
      );
      state.instance = instance;
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

function createTestEnv() {
  const namespace = new FakeNamespace();
  return {
    env: {
      // biome-ignore lint/suspicious/noExplicitAny: Test env type is complex and not fully typed
      TRAY_HUB: namespace as unknown as any,
      ASSETS: fakeAssets,
      CLOUD_SESSIONS: fakeCloudSessions,
    },
    namespace,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Harness Interface
// ──────────────────────────────────────────────────────────────────────────

export interface BridgeConnection {
  /** The bridge CLIENT socket — `.received` reflects what the DO sent to the tab. */
  ws: FakeWebSocket;
  /** The bridge SERVER socket the DO accepted (tagged 'bridge') — deliver messages/close here, as the runtime does. */
  serverWs: FakeWebSocket;
  connId: string;
  sent: string[];
  closed: boolean;
}

export interface BridgeHarness {
  do: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  stub: { fetch: (req: Request) => Promise<Response> };
  leaderSent: unknown[];
  previewToken: string;
  workerBaseUrl: string;
  controllerToken: string;
  bridgeUrl: (path?: string) => string;
  mintBridgedPreview: (opts: {
    bridge: boolean;
    maxTabs?: number;
    webhookId?: string;
  }) => Promise<string>;
  openBridge: () => Promise<BridgeConnection>;
  deliverLeaderMessage: (msg: unknown) => Promise<void>;
  deliverBridgeMessage: (b: BridgeConnection, msg: unknown) => Promise<void>;
  closeBridge: (b: BridgeConnection) => Promise<void>;
  revokePreview: (token: string) => Promise<void>;
  /**
   * Simulate a leader reload: drop the current leader socket, then re-attach and
   * open a fresh controller WS. Returns everything the NEW leader socket received
   * during the upgrade (includes `leader.connected` + any replayed
   * `bridge.connected`).
   */
  reconnectLeader: () => Promise<unknown[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// Harness Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Creates a tray with a connected leader, mints a preview per opts, and returns
 * concrete helpers that drive DO WebSocket methods directly.
 */
export async function makeTrayWithConnectedLeader(opts: {
  bridge: boolean;
  maxTabs?: number;
  webhookId?: string;
}): Promise<BridgeHarness> {
  const { env, namespace } = createTestEnv();
  const workerBaseUrl = 'https://www.sliccy.ai';

  // 1-6. Create tray, attach + connect the leader, capture its sends, resolve
  // the controller token and the DO instance.
  const { session, leader, leaderSent, controllerToken, stub, state } = await setupConnectedLeader(
    env,
    namespace,
    workerBaseUrl
  );

  // 7. Mint preview
  const previewToken = await mintPreviewInternal(
    stub,
    controllerToken,
    workerBaseUrl,
    opts.bridge,
    opts.maxTabs ?? 20,
    opts.webhookId
  );

  // 8. Build helpers
  const harness: BridgeHarness = {
    do: stub,
    state,
    stub: { fetch: (req: Request) => stub.fetch(req) },
    leaderSent,
    previewToken,
    workerBaseUrl,
    controllerToken,

    bridgeUrl(path = '/__slicc/bridge') {
      return buildPreviewUrl(workerBaseUrl, previewToken, path);
    },

    async mintBridgedPreview(newOpts) {
      return mintPreviewInternal(
        stub,
        controllerToken,
        workerBaseUrl,
        newOpts.bridge,
        newOpts.maxTabs ?? 20,
        newOpts.webhookId
      );
    },

    async openBridge() {
      // Open bridge WebSocket via the DO directly (not through worker routing)
      const url = harness.bridgeUrl();
      const upgradeResponse = await stub.fetch(
        new Request(url, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://example.sliccy.now',
          },
        })
      );

      const bridgeWs = (upgradeResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

      // The DO sends {t:'welcome',connId} as the first message.
      // Extract connId from the received messages.
      let connId = '';
      if (bridgeWs.received.length > 0) {
        const welcome = JSON.parse(bridgeWs.received[0]);
        if (welcome.t === 'welcome' && welcome.connId) {
          connId = welcome.connId;
        }
      }

      // The DO accepted the bridge SERVER socket (tagged 'bridge') — find the one whose
      // attachment connId matches, so we deliver messages/close to it exactly as the runtime does.
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
        sent: [], // Not used in the relay tests
        closed: false,
      };

      // Track close
      bridgeWs.addEventListener('close', () => {
        conn.closed = true;
      });

      return conn;
    },

    // Deliver directly to the accepted SERVER socket and AWAIT the DO's async handler, so the
    // assertion observes the completed relay. (A fire-and-forget client.send + setTimeout races
    // the multi-await webSocketMessage/Close handler.) LEADER_WS_TAG='leader', BRIDGE_WS_TAG='bridge'.
    async deliverLeaderMessage(msg) {
      const leaderServer = state.getWebSockets('leader')[0];
      await stub.webSocketMessage(leaderServer as never, JSON.stringify(msg));
    },

    async deliverBridgeMessage(b, msg) {
      await stub.webSocketMessage(b.serverWs as never, JSON.stringify(msg));
    },

    async closeBridge(b) {
      await stub.webSocketClose(b.serverWs as never);
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
  };

  return harness;
}

// ──────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Create a tray, attach + connect a leader, and resolve the pieces the harness
 *  needs (session, leaderKey, captured leader sends, controller token, DO). */
async function setupConnectedLeader(
  env: ReturnType<typeof createTestEnv>['env'],
  namespace: FakeNamespace,
  workerBaseUrl: string
): Promise<{
  session: { capabilities: { controller: { url: string } }; trayId: string };
  leader: { leaderKey: string; websocket: { url: string } };
  leaderSent: unknown[];
  controllerToken: string;
  stub: SessionTrayDurableObject;
  state: FakeDurableObjectState;
}> {
  const created = await handleWorkerRequest(
    new Request(`${workerBaseUrl}/tray`, { method: 'POST' }),
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
  const leaderSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

  const leaderSent: unknown[] = [];
  leaderSocket.addEventListener('message', (event: { data?: string }) => {
    if (event.data) leaderSent.push(JSON.parse(event.data));
  });

  const controllerToken =
    new URL(session.capabilities.controller.url).pathname.split('/').pop() ?? '';
  const stub = namespace.get(namespace.idFromName(session.trayId));
  const state = namespace.states.get(session.trayId)!;

  return { session, leader, leaderSent, controllerToken, stub, state };
}

/**
 * Simulate a leader reload: drop the current leader socket (via its own close()
 * so the fake evicts it and fires webSocketClose), then re-attach with the
 * original leaderKey and open a fresh controller WS. Returns everything the new
 * socket received during the upgrade (`leader.connected` + replayed
 * `bridge.connected`).
 */
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
  webhookId?: string
): Promise<string> {
  // Call the DO's mintPreview method directly
  // biome-ignore lint/suspicious/noExplicitAny: mintPreview is a private method we access for testing
  const result = await (stub as any).mintPreview({
    controllerToken,
    servedRoot: '/workspace/dist',
    entryPath: '/workspace/dist/index.html',
    allowLive: bridge,
    bridge,
    maxTabs,
    webhookId,
    workerBaseUrl,
  });
  return result.previewToken;
}
