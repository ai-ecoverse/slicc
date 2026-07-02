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
          webSocketPairFactory: createFakeWebSocketPair,
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
  ws: FakeWebSocket;
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

  // 1. Create tray
  const created = await handleWorkerRequest(
    new Request(`${workerBaseUrl}/tray`, { method: 'POST' }),
    env
  );
  const session = (await created.json()) as {
    capabilities: { controller: { url: string } };
    trayId: string;
  };

  // 2. Attach leader
  const attach = await handleWorkerRequest(
    new Request(session.capabilities.controller.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerId: 'lead-1' }),
    }),
    env
  );
  const leader = (await attach.json()) as { leaderKey: string; websocket: { url: string } };

  // 3. Open leader WebSocket
  const socketResponse = await handleWorkerRequest(
    new Request(leader.websocket.url, {
      headers: { Upgrade: 'websocket' },
    }),
    env
  );
  const leaderSocket = (socketResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

  // 4. Capture leader sends (messages sent FROM the server TO this client)
  const leaderSent: unknown[] = [];
  leaderSocket.addEventListener('message', (event: { data?: string }) => {
    if (event.data) {
      leaderSent.push(JSON.parse(event.data));
    }
  });

  // 5. Extract controller token
  const controllerUrl = new URL(session.capabilities.controller.url);
  const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';

  // 6. Get DO instance
  const stub = namespace.get(namespace.idFromName(session.trayId));
  const state = namespace.states.get(session.trayId)!;

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
      // Open bridge WebSocket via the preview URL
      const url = harness.bridgeUrl();
      const upgradeResponse = await handleWorkerRequest(
        new Request(url, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://example.sliccy.now',
          },
        }),
        env
      );

      const bridgeWs = (upgradeResponse as unknown as { webSocket: FakeWebSocket }).webSocket;

      // The DO sends {t:'welcome',connId} as the first message.
      // We need to capture it to extract the real connId.
      const sent: string[] = [];
      let connId = '';

      const originalSend = bridgeWs.send.bind(bridgeWs);
      bridgeWs.send = (data: string) => {
        const parsed = JSON.parse(data);
        if (parsed.t === 'welcome' && parsed.connId) {
          connId = parsed.connId;
        }
        sent.push(data);
        originalSend(data);
      };

      const conn: BridgeConnection = {
        ws: bridgeWs,
        connId,
        sent,
        closed: false,
      };

      // Track close
      bridgeWs.addEventListener('close', () => {
        conn.closed = true;
      });

      return conn;
    },

    async deliverLeaderMessage(msg) {
      await stub.webSocketMessage(leaderSocket, JSON.stringify(msg));
    },

    async deliverBridgeMessage(b, msg) {
      await stub.webSocketMessage(b.ws, JSON.stringify(msg));
    },

    async closeBridge(b) {
      await stub.webSocketClose(b.ws);
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
  };

  return harness;
}

// ──────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ──────────────────────────────────────────────────────────────────────────

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
