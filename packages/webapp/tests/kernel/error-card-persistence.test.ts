/**
 * Durable cone-error cards (#3003, #2365).
 *
 * `#handleError` appends an `error: true` row to the page chat controller
 * only, and Pi history never holds it. Since #2365 the card's durable copy is
 * an `error` marker on the canonical conversation record — never an entry
 * (the model would read its own failure as a prior turn), never the frozen
 * `browser-coding-agent` store. These tests pin that write, the retry for a
 * record that does not exist yet, and the rebuild that folds the card back in
 * next to the compaction seam (#2992).
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../../src/core/index.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import { toAgentMessages } from '../../src/work-unit/conversation/derive.js';
import { conversationIdentityFor } from '../../src/work-unit/conversation/key.js';
import { WorkUnitConversationStore } from '../../src/work-unit/conversation/store.js';
import type { ConversationMarker } from '../../src/work-unit/conversation/types.js';

const messageListeners: Array<(message: unknown) => void> = [];
const sentMessages: unknown[] = [];

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: undefined,
    sendMessage: vi.fn(async (msg: unknown) => {
      sentMessages.push(msg);
    }),
    onMessage: {
      addListener: vi.fn((cb: (message: unknown) => void) => void messageListeners.push(cb)),
      removeListener: vi.fn(),
    },
  },
};

const { mockSessionStore, saved } = vi.hoisted(() => {
  // The frozen legacy UI store: recorded only so the tests can prove it is
  // never written or read.
  const saved: Array<{ sessionId: string; messages: ChatMessage[] }> = [];
  return {
    saved,
    mockSessionStore: vi.fn(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.saveMessages = vi.fn(async (sessionId: string, messages: ChatMessage[]) => {
        saved.push({ sessionId, messages: structuredClone(messages) });
      });
      this.load = vi.fn().mockResolvedValue(null);
      this.delete = vi.fn().mockResolvedValue(undefined);
    }),
  };
});

vi.mock('../../src/scoops/chat-session-store.js', () => ({ SessionStore: mockSessionStore }));

const { Bridge } = await import('../../src/kernel/facade.js');

const CONE = {
  jid: 'cone_1',
  name: 'Cone',
  folder: 'cone',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: '2026-01-04T10:00:00.000Z',
};

const DELEGATED_SCOOP = {
  ...CONE,
  jid: 'scoop_gelatiere',
  name: 'Gelatiere',
  folder: 'gelatiere',
  parentJid: CONE.jid,
  assistantLabel: 'gelatiere',
};

let realDbCounter = 0;

function terminalPiMessages(): AgentMessage[] {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: 'finish the job' }],
      timestamp: 1000,
    },
    {
      role: 'assistant',
      content: [],
      timestamp: 2000,
      stopReason: 'error',
      errorMessage: 'raw provider failure request-secret-123',
    },
  ] as AgentMessage[];
}

function newRealStore(): WorkUnitConversationStore {
  realDbCounter++;
  return new WorkUnitConversationStore({ dbName: `test-error-markers-${realDbCounter}` });
}

async function bindRealBridge(store: WorkUnitConversationStore) {
  const next = new Bridge();
  await next.bind({
    getScoops: () => [CONE, DELEGATED_SCOOP],
    getScoopContext: () => undefined,
    getConversationStore: () => store,
    getQueuedMessageIds: () => [],
  } as never);
  return { bridge: next, callbacks: Bridge.createCallbacks(next) };
}

function bufferFor(target: InstanceType<typeof Bridge>, jid: string): ChatMessage[] {
  return (target as { getBuffer: (targetJid: string) => ChatMessage[] }).getBuffer(jid);
}

/**
 * In-memory canonical store: Pi history plus markers. `exists: false` models
 * a unit whose first checkpoint has not landed — `putMarker` declines unless
 * asked to create, as the real store does. `writable: false` models a store
 * that cannot be written at all.
 */
function makeConversationStore(getMessages: () => unknown[]) {
  const state = { exists: true, writable: true, markers: [] as ConversationMarker[] };
  return {
    state,
    load: vi.fn(async () =>
      state.exists
        ? {
            key: '/workspace::cone_1',
            version: 1,
            workUnitId: 'cone_1',
            workspaceId: '/workspace',
            folder: 'cone',
            origin: 'agent-history',
            entries: getMessages().map((message, seq) => ({
              id: `e${seq}`,
              seq,
              kind: (message as { role: string }).role === 'assistant' ? 'assistant' : 'user',
              timestamp: 0,
              text: '',
              message,
            })),
            markers: state.markers,
            createdAt: 1,
            updatedAt: 1,
            legacyKeys: { agentSessionId: 'cone_1', chatSessionId: 'session-cone' },
          }
        : null
    ),
    putMarker: vi.fn(
      async (_key: string, marker: ConversationMarker, options: { createWith?: unknown } = {}) => {
        if (!state.writable) return false;
        if (!state.exists) {
          if (!options.createWith) return false;
          state.exists = true;
        }
        const at = state.markers.findIndex((m) => m.id === marker.id);
        if (at >= 0) state.markers[at] = marker;
        else state.markers.push(marker);
        return true;
      }
    ),
    deleteMarker: vi.fn(async () => false),
  };
}

describe('kernel error-card persistence', () => {
  let bridge: InstanceType<typeof Bridge>;
  let callbacks: ReturnType<typeof Bridge.createCallbacks>;
  let conversationStore: ReturnType<typeof makeConversationStore>;
  let agentMessages: unknown[];

  const buffered = (b: unknown = bridge) =>
    (b as { getBuffer: (jid: string) => ChatMessage[] }).getBuffer('cone_1');

  /** A fresh kernel over the same durable state — what a reload boots into. */
  async function reload(): Promise<InstanceType<typeof Bridge>> {
    const next = new Bridge();
    await next.bind({
      getScoops: () => [CONE],
      getScoopContext: () => undefined,
      getConversationStore: () => conversationStore,
      getQueuedMessageIds: () => [],
    } as never);
    await next.hydrateBuffersFromRecords();
    return next;
  }

  beforeEach(async () => {
    sentMessages.length = 0;
    saved.length = 0;
    vi.clearAllMocks();
    agentMessages = [
      { role: 'user', content: [{ type: 'text', text: 'ship it' }], timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'shipped' }],
        timestamp: 2000,
        model: 'claude-opus-4-6',
      },
    ];
    conversationStore = makeConversationStore(() => agentMessages);

    bridge = new Bridge();
    await bridge.bind({
      getScoops: () => [CONE],
      getScoopContext: () => undefined,
      getConversationStore: () => conversationStore,
      getQueuedMessageIds: () => [],
    } as never);
    callbacks = Bridge.createCallbacks(bridge);
  });

  it('appends an error card to the buffer and records an error marker', async () => {
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));

    expect(buffered().at(-1)).toMatchObject({
      role: 'assistant',
      content: 'rate limited',
      error: true,
    });
    expect(conversationStore.state.markers).toEqual([
      expect.objectContaining({ kind: 'error', text: 'rate limited', id: buffered().at(-1)?.id }),
    ]);
    expect(saved).toEqual([]);
  });

  it('keeps error: true across a reload', async () => {
    callbacks.onError?.('cone_1', 'provider exploded');
    await vi.waitFor(() => expect(conversationStore.state.markers).toHaveLength(1));
    const cardId = buffered().at(-1)?.id;

    const reloaded = await reload();

    expect(buffered(reloaded).find((m) => m.error === true)).toMatchObject({
      id: cardId,
      role: 'assistant',
      content: 'provider exploded',
      error: true,
    });
  });

  it('keeps the compaction seam next to a restored error card', async () => {
    conversationStore.state.markers.push({
      id: 'compaction-cone_1-stored',
      kind: 'compaction',
      timestamp: 1500,
      compaction: { trigger: 'threshold', state: 'summarized' },
    });
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(conversationStore.state.markers).toHaveLength(2));

    const rows = buffered(await reload());

    expect(rows.map((m) => (m.compaction ? 'seam' : m.error ? 'error' : m.role))).toEqual([
      'user',
      'seam',
      'assistant',
      'error',
    ]);
    expect(rows.find((m) => m.compaction)?.compaction).toMatchObject({ state: 'summarized' });
  });

  it('places a stored error card on its timestamp seam, exactly once', async () => {
    conversationStore.state.markers.push({
      id: 'err-mid',
      kind: 'error',
      timestamp: 1500,
      text: 'boom',
    });

    const rows = buffered(await reload());

    expect(rows.map((m) => (m.error ? 'error' : m.role))).toEqual(['user', 'error', 'assistant']);
    expect(rows.find((m) => m.error)).toMatchObject({ id: 'err-mid', content: 'boom' });
  });

  it('creates the record for a card whose turn failed before any message existed', async () => {
    // A missing API key: Pi never holds a message, so no checkpoint will ever
    // create a record for a held card to land on.
    conversationStore.state.exists = false;
    agentMessages = [];
    callbacks.onError?.('cone_1', 'bad api key');
    await vi.waitFor(() => expect(conversationStore.state.markers).toHaveLength(1));

    expect(conversationStore.putMarker).toHaveBeenCalledWith(
      '/workspace::cone_1',
      expect.objectContaining({ kind: 'error' }),
      { createWith: expect.objectContaining({ key: '/workspace::cone_1', workUnitId: 'cone_1' }) }
    );
    const rows = buffered(await reload());
    expect(rows).toEqual([expect.objectContaining({ content: 'bad api key', error: true })]);
  });

  it('holds a card the store cannot take and writes it when the turn settles', async () => {
    conversationStore.state.writable = false;
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    expect(conversationStore.state.markers).toEqual([]);

    conversationStore.state.writable = true;
    // A failed turn settles to `ready` without necessarily reaching
    // `onResponseDone`; either is enough to retry.
    callbacks.onStatusChange?.('cone_1', 'ready');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(2));

    expect(conversationStore.state.markers).toEqual([
      expect.objectContaining({ kind: 'error', text: 'rate limited' }),
    ]);
  });

  it('keeps error: true through a follower snapshot projection', () => {
    sentMessages.length = 0;
    bridge.applyFollowerSnapshot([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 100 },
      {
        id: 'err-snap',
        role: 'assistant',
        content: 'rate limited',
        timestamp: 200,
        error: true,
      },
    ]);

    expect(buffered().find((m) => m.id === 'err-snap')).toMatchObject({
      role: 'assistant',
      content: 'rate limited',
      error: true,
    });

    const replaced = sentMessages.find(
      (m) => (m as { payload?: { type?: string } }).payload?.type === 'scoop-messages-replaced'
    ) as { payload: { messages: ChatMessage[] } } | undefined;
    expect(replaced?.payload.messages.find((m) => m.id === 'err-snap')?.error).toBe(true);
    expect(saved).toEqual([]);
  });
});

describe('kernel error-card IndexedDB durability (#3263)', () => {
  it('keeps a root failure separate from Pi history across a reload and rebuild', async () => {
    const store = newRealStore();
    const identity = conversationIdentityFor(CONE);
    const piMessages = terminalPiMessages();
    await store.syncAgentMessages(identity, piMessages);
    const { callbacks } = await bindRealBridge(store);

    const visibleFailure = 'Scoop "Cone" failed after 3 attempts: provider unavailable';
    callbacks.onError?.(CONE.jid, visibleFailure);

    await vi.waitFor(async () => {
      expect((await store.load(identity.key))?.markers).toEqual([
        expect.objectContaining({ kind: 'error', text: visibleFailure }),
      ]);
    });
    const durable = await store.load(identity.key);
    // The empty Pi assistant error remains model history. The presentation
    // marker is not injected into that history and therefore cannot make the
    // model respond to its own failure on the next turn.
    expect(toAgentMessages(durable)).toEqual(piMessages);
    expect(JSON.stringify(toAgentMessages(durable))).not.toContain(visibleFailure);

    const { bridge: reloaded } = await bindRealBridge(store);
    await reloaded.hydrateBuffersFromRecords();
    expect(bufferFor(reloaded, CONE.jid).filter((message) => message.error)).toEqual([
      expect.objectContaining({ content: visibleFailure, error: true }),
    ]);

    // A second rebuild is a read, not another presentation write.
    await reloaded.hydrateBuffersFromRecords();
    expect(bufferFor(reloaded, CONE.jid).filter((message) => message.error)).toHaveLength(1);
    expect((await store.load(identity.key))?.markers).toHaveLength(1);
  });

  it('creates and reloads a marker-only record for a delegated fatal failure', async () => {
    const store = newRealStore();
    const identity = conversationIdentityFor(DELEGATED_SCOOP);
    const { callbacks } = await bindRealBridge(store);

    const fatalNotification = 'Scoop "Gelatiere" failed with unrecoverable error: quota exhausted';
    callbacks.onError?.(DELEGATED_SCOOP.jid, fatalNotification);

    await vi.waitFor(async () => {
      expect(await store.load(identity.key)).toMatchObject({
        workUnitId: DELEGATED_SCOOP.jid,
        workspaceId: '/scoops/gelatiere/workspace',
        entries: [],
        markers: [expect.objectContaining({ kind: 'error', text: fatalNotification })],
      });
    });
    expect(await store.load(conversationIdentityFor(CONE).key)).toBeNull();

    const { bridge: reloaded } = await bindRealBridge(store);
    await reloaded.hydrateBuffersFromRecords();
    expect(bufferFor(reloaded, DELEGATED_SCOOP.jid).filter((message) => message.error)).toEqual([
      expect.objectContaining({ content: fatalNotification, error: true }),
    ]);
  });

  it('retries a failed marker-only write at terminal error with one stable id', async () => {
    const store = newRealStore();
    const identity = conversationIdentityFor(DELEGATED_SCOOP);
    const writeMarker = store.putMarker.bind(store);
    const markerWrites = vi.spyOn(store, 'putMarker');
    markerWrites
      .mockImplementationOnce(async () => false)
      .mockImplementation((key, marker, options) => writeMarker(key, marker, options));
    const { callbacks } = await bindRealBridge(store);

    callbacks.onError?.(DELEGATED_SCOOP.jid, 'provider unavailable');
    // This is the real terminal ordering: lifecycle emits `error` immediately
    // after onError, before recordErrorCard's first IndexedDB await settles.
    callbacks.onStatusChange?.(DELEGATED_SCOOP.jid, 'error');
    // A repeated state sync may overlap the first retry. Stable marker ids
    // make every write an upsert rather than another card.
    callbacks.onStatusChange?.(DELEGATED_SCOOP.jid, 'error');

    await vi.waitFor(async () => {
      expect((await store.load(identity.key))?.markers).toEqual([
        expect.objectContaining({ kind: 'error', text: 'provider unavailable' }),
      ]);
    });
    expect(markerWrites.mock.calls.length).toBeGreaterThanOrEqual(2);

    const writesAfterRecovery = markerWrites.mock.calls.length;
    callbacks.onResponseDone?.(DELEGATED_SCOOP.jid);
    callbacks.onStatusChange?.(DELEGATED_SCOOP.jid, 'ready');
    await Promise.resolve();
    await Promise.resolve();
    expect(markerWrites).toHaveBeenCalledTimes(writesAfterRecovery);

    const { bridge: reloaded } = await bindRealBridge(store);
    await reloaded.hydrateBuffersFromRecords();
    expect(
      bufferFor(reloaded, DELEGATED_SCOOP.jid).filter((message) => message.error)
    ).toHaveLength(1);
    expect((await store.load(identity.key))?.markers).toHaveLength(1);
  });
});
