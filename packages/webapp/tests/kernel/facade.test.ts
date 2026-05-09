/**
 * Phase 1 facade parity test.
 *
 * Drives the existing `OffscreenBridge` (host side) and `OffscreenClient`
 * (panel side) through their typed `KernelFacade` / `KernelClientFacade`
 * surfaces and pins the seams the compat contract calls out:
 *
 *   - `request-state` snapshot shape (round-trip across the bridge)
 *   - `scoop-drop` deletes the right session id
 *   - `clear-chat` deletes every scoop's session id
 *   - `panel-cdp-command` round-trip
 *   - `tool-ui-action` routing
 *   - `agent-event` `text_delta` ordering preserved through the facade emit
 *   - follower-sync `user-message` diversion
 *   - `sprinkle-op-response` routing into the proxy handler
 *
 * The test mocks chrome.runtime (so the existing transport adapter binds)
 * and runs both bridge and client against the same listener fan-out — when
 * the bridge emits, the client's listener fires.
 *
 * The point is the *typed surface*: every interaction here goes through a
 * `KernelFacade` / `KernelClientFacade`-typed binding, never the concrete
 * class. If the structural contract drifts, this file stops compiling.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock chrome.runtime — fan-out style so a panel-source message reaches the
// bridge listener and an offscreen-source message reaches the client
// listener.
// ---------------------------------------------------------------------------

interface ChromeListener {
  (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void): boolean | void;
}

const messageListeners: ChromeListener[] = [];
const sentMessages: unknown[] = [];

const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined,
    sendMessage: vi.fn(async (msg: unknown) => {
      sentMessages.push(msg);
      // Fan out to every other listener (excluding self isn't important
      // here — listeners filter by `source`).
      for (const listener of messageListeners) {
        listener(msg, {}, () => {});
      }
    }),
    onMessage: {
      addListener: vi.fn((cb: ChromeListener) => {
        messageListeners.push(cb);
      }),
      removeListener: vi.fn((cb: ChromeListener) => {
        const i = messageListeners.indexOf(cb);
        if (i >= 0) messageListeners.splice(i, 1);
      }),
    },
  },
};

(globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

// ---------------------------------------------------------------------------
// Hoisted module mocks — must match `OffscreenBridge` / `OffscreenClient`
// import shapes.
// ---------------------------------------------------------------------------

const { mockSessionStore, mockHandleAction, mockHandleSprinkleOpResponse } = vi.hoisted(() => ({
  mockSessionStore: vi.fn(function (this: Record<string, Mock>) {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.saveMessages = vi.fn().mockResolvedValue(undefined);
    this.delete = vi.fn().mockResolvedValue(undefined);
  }),
  mockHandleAction: vi.fn().mockResolvedValue(undefined),
  mockHandleSprinkleOpResponse: vi.fn(),
}));

vi.mock('../../src/ui/session-store.js', () => ({
  SessionStore: mockSessionStore,
}));

vi.mock('../../src/tools/tool-ui.js', () => ({
  toolUIRegistry: {
    handleAction: mockHandleAction,
  },
}));

vi.mock('../../../chrome-extension/src/sprinkle-proxy.js', () => ({
  handleSprinkleOpResponse: mockHandleSprinkleOpResponse,
}));

const { OffscreenBridge } = await import('../../../chrome-extension/src/offscreen-bridge.js');
const { OffscreenClient } = await import('../../src/ui/offscreen-client.js');

import type {
  KernelFacade,
  KernelClientFacade,
  KernelClientCallbacks,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrchestratorMock() {
  return {
    getScoops: vi.fn(() => [
      {
        jid: 'cone_1',
        name: 'Cone',
        folder: 'cone',
        isCone: true,
        type: 'cone' as const,
        requiresTrigger: false,
        assistantLabel: 'sliccy',
        addedAt: new Date().toISOString(),
      },
      {
        jid: 'scoop_test',
        name: 'Test',
        folder: 'test-scoop',
        isCone: false,
        type: 'scoop' as const,
        requiresTrigger: true,
        assistantLabel: 'test-scoop',
        addedAt: new Date().toISOString(),
      },
    ]),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    createScoopTab: vi.fn(),
    registerScoop: vi.fn().mockResolvedValue(undefined),
    unregisterScoop: vi.fn().mockResolvedValue(undefined),
    stopScoop: vi.fn(),
    clearQueuedMessages: vi.fn().mockResolvedValue(undefined),
    clearAllMessages: vi.fn().mockResolvedValue(undefined),
    delegateToScoop: vi.fn().mockResolvedValue(undefined),
    updateModel: vi.fn(),
    setScoopThinkingLevel: vi.fn().mockResolvedValue(undefined),
    resetFilesystem: vi.fn().mockResolvedValue(undefined),
    reloadAllSkills: vi.fn().mockResolvedValue(undefined),
    getSessionCosts: vi.fn(() => ({})),
  };
}

function makeClientCallbacks(): KernelClientCallbacks & {
  agentEvents: unknown[];
  scoopMessagesReplaced: Array<{ scoopJid: string; messages: unknown[] }>;
} {
  const agentEvents: unknown[] = [];
  const scoopMessagesReplaced: Array<{ scoopJid: string; messages: unknown[] }> = [];
  return {
    agentEvents,
    scoopMessagesReplaced,
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
    onScoopMessagesReplaced: (scoopJid, messages) =>
      void scoopMessagesReplaced.push({ scoopJid, messages }),
    onReady: vi.fn(),
  };
}

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Kernel facade parity (Phase 1)', () => {
  let facade: KernelFacade;
  let client: KernelClientFacade;
  let orchestrator: ReturnType<typeof makeOrchestratorMock>;
  let callbacks: ReturnType<typeof makeClientCallbacks>;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    // Construct bridge — it registers a chrome.runtime listener eagerly
    // for emit (no-op until bind), but the panel-side listener it
    // installs lives inside `bind()`.
    const bridge = new OffscreenBridge();
    facade = bridge;

    orchestrator = makeOrchestratorMock();
    await bridge.bind(orchestrator as unknown as Parameters<typeof bridge.bind>[0]);

    // Construct client — registers its own panel-side listener eagerly.
    callbacks = makeClientCallbacks();
    const offscreenClient = new OffscreenClient(callbacks);
    client = offscreenClient;
  });

  // 1. request-state snapshot shape
  it('client.requestState → bridge.buildStateSnapshot reaches the panel intact', async () => {
    client.requestState();
    await tick();

    const snapshot = facade.buildStateSnapshot();
    expect(snapshot.type).toBe('state-snapshot');
    expect(snapshot.scoops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jid: 'cone_1', isCone: true }),
        expect.objectContaining({ jid: 'scoop_test', isCone: false }),
      ])
    );
    // Bridge sent the same snapshot to the panel as a side-effect of
    // handling `request-state`.
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        source: 'offscreen',
        payload: expect.objectContaining({ type: 'state-snapshot' }),
      })
    );
  });

  // 2. scoop-drop deletes the right session id
  it('client.unregisterScoop("scoop_test") triggers SessionStore.delete("session-test-scoop")', async () => {
    await client.unregisterScoop('scoop_test');
    await tick();

    const sessionStore = (facade as unknown as { sessionStore: { delete: Mock } }).sessionStore;
    expect(sessionStore.delete).toHaveBeenCalledWith('session-test-scoop');
    expect(orchestrator.unregisterScoop).toHaveBeenCalledWith('scoop_test');
  });

  // 3. clear-chat deletes every scoop's session id
  it('client.clearAllMessages → SessionStore.delete called for every scoop session', async () => {
    await client.clearAllMessages();
    await tick();

    const sessionStore = (facade as unknown as { sessionStore: { delete: Mock } }).sessionStore;
    expect(sessionStore.delete).toHaveBeenCalledWith('session-cone');
    expect(sessionStore.delete).toHaveBeenCalledWith('session-test-scoop');
    expect(orchestrator.clearAllMessages).toHaveBeenCalled();
  });

  // 4. panel-cdp-command round-trip
  it('panel-cdp-command goes through BrowserAPI and returns panel-cdp-response', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, foo: 1 });
    const browser = {
      getTransport: () => ({ send }),
    };

    // Re-bind with a BrowserAPI stub. Phase 1 contract: rebind is allowed
    // and must not double-listen — the bridge's own `transportUnsubscribe`
    // is what guarantees that.
    type BindFn = (
      orch: ReturnType<typeof makeOrchestratorMock>,
      browserAPI?: typeof browser
    ) => Promise<void>;
    await (facade.bind as unknown as BindFn)(orchestrator, browser);

    // Simulate a panel-cdp-command — go directly through the
    // chrome.runtime mock to mimic the panel sending it.
    sentMessages.length = 0;
    for (const listener of messageListeners) {
      listener(
        {
          source: 'panel',
          payload: {
            type: 'panel-cdp-command',
            id: 42,
            method: 'Page.navigate',
            params: { url: 'https://example.com' },
          },
        },
        {},
        () => {}
      );
    }
    await tick();

    expect(send).toHaveBeenCalledWith('Page.navigate', { url: 'https://example.com' }, undefined);
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        source: 'offscreen',
        payload: expect.objectContaining({
          type: 'panel-cdp-response',
          id: 42,
          result: { ok: true, foo: 1 },
        }),
      })
    );
  });

  // 5. tool-ui-action routing
  it('tool-ui-action routes to toolUIRegistry.handleAction', async () => {
    for (const listener of messageListeners) {
      listener(
        {
          source: 'panel',
          payload: {
            type: 'tool-ui-action',
            requestId: 'req-9',
            action: 'submit',
            data: { value: 'hello' },
          },
        },
        {},
        () => {}
      );
    }
    await tick();

    expect(mockHandleAction).toHaveBeenCalledWith('req-9', {
      action: 'submit',
      data: { value: 'hello' },
    });
  });

  // 6. agent-event text_delta ordering preserved through facade emit
  it('text_delta deltas appear in order on the wire and reach the client agent handle in order', async () => {
    // Subscribe via the typed handle, capture events.
    const handle = client.createAgentHandle();
    (client as { selectedScoopJid: string | null }).selectedScoopJid = 'cone_1';
    const events: Array<{ type: string; text?: string }> = [];
    handle.onEvent((event) => {
      events.push({ type: event.type, text: 'text' in event ? event.text : undefined });
    });

    // Bridge-side: invoke the streaming callbacks in the order an LLM
    // would produce them. The bridge's `createCallbacks` is the only
    // place that knows how to wire orchestrator events into the wire,
    // so we go through it here.
    const orchCallbacks = OffscreenBridge.createCallbacks(
      facade as InstanceType<typeof OffscreenBridge>
    );
    orchCallbacks.onResponse?.('cone_1', 'Hel', true);
    orchCallbacks.onResponse?.('cone_1', 'lo ', true);
    orchCallbacks.onResponse?.('cone_1', 'world', true);
    orchCallbacks.onResponseDone?.('cone_1');
    await tick();

    const deltaTexts = events.filter((e) => e.type === 'content_delta').map((e) => e.text);
    expect(deltaTexts).toEqual(['Hel', 'lo ', 'world']);
    expect(events.some((e) => e.type === 'content_done')).toBe(true);
  });

  // 7. follower-sync user-message diversion
  it('user-message is diverted to followerSync.sendMessage when a follower is attached', async () => {
    const followerSendMessage = vi.fn();
    facade.setFollowerSync({
      sendMessage: followerSendMessage,
    } as unknown as Parameters<typeof facade.setFollowerSync>[0]);

    // Simulate the panel sending a user message.
    for (const listener of messageListeners) {
      listener(
        {
          source: 'panel',
          payload: {
            type: 'user-message',
            scoopJid: 'cone_1',
            text: 'follower hi',
            messageId: 'msg-follower-1',
          },
        },
        {},
        () => {}
      );
    }
    await tick();

    expect(followerSendMessage).toHaveBeenCalledWith('follower hi', 'msg-follower-1', undefined);
    // The local orchestrator must NOT have seen the message in follower mode.
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
  });

  // 8. sprinkle-op-response routes to the proxy handler instead of being
  //    handed to handlePanelMessage
  it('sprinkle-op-response payloads route to handleSprinkleOpResponse', async () => {
    for (const listener of messageListeners) {
      listener(
        {
          source: 'panel',
          payload: {
            type: 'sprinkle-op-response',
            id: 'req-1',
            result: { ok: true },
          },
        },
        {},
        () => {}
      );
    }
    await tick();

    expect(mockHandleSprinkleOpResponse).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sprinkle-op-response', id: 'req-1' })
    );
    // And handlePanelMessage didn't see it (no orchestrator side-effects).
    expect(orchestrator.handleMessage).not.toHaveBeenCalled();
    expect(orchestrator.unregisterScoop).not.toHaveBeenCalled();
  });
});
