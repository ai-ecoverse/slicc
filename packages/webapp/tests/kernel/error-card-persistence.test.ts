/**
 * Durable cone-error cards (#3003).
 *
 * `#handleError` appends an `error: true` row to the page chat controller
 * only. Pi history never held it, and `toBufferedChatMessages` used to strip
 * `error` even if the row reached the kernel. These tests pin the writes that
 * make the card survive a reload: the message buffer, the
 * `browser-coding-agent` store, and the rebuild that folds a persisted card
 * back in next to the compaction seam (#2992).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
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

const { mockSessionStore, sessions, saved } = vi.hoisted(() => {
  const sessions = new Map<string, ChatMessage[]>();
  const saved: Array<{ sessionId: string; messages: ChatMessage[] }> = [];
  return {
    sessions,
    saved,
    mockSessionStore: vi.fn(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.saveMessages = vi.fn(async (sessionId: string, messages: ChatMessage[]) => {
        const copy = structuredClone(messages);
        sessions.set(sessionId, copy);
        saved.push({ sessionId, messages: copy });
      });
      this.load = vi.fn(async (sessionId: string) => {
        const messages = sessions.get(sessionId);
        return messages ? { id: sessionId, messages, createdAt: 0, updatedAt: 0 } : null;
      });
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

function makeConversationStore(markers: ConversationMarker[] = []) {
  return {
    markers,
    load: vi.fn(async () => ({ markers })),
    putMarker: vi.fn(async (_key: string, marker: ConversationMarker) => {
      const at = markers.findIndex((m) => m.id === marker.id);
      if (at >= 0) markers[at] = marker;
      else markers.push(marker);
      return true;
    }),
    deleteMarker: vi.fn(async (_key: string, id: string) => {
      const at = markers.findIndex((m) => m.id === id);
      if (at >= 0) markers.splice(at, 1);
      return at >= 0;
    }),
  };
}

describe('kernel error-card persistence', () => {
  let bridge: InstanceType<typeof Bridge>;
  let callbacks: ReturnType<typeof Bridge.createCallbacks>;
  let conversationStore: ReturnType<typeof makeConversationStore>;
  let agentMessages: unknown[];

  const persisted = () => saved[saved.length - 1]?.messages ?? [];

  const rebuild = () =>
    (
      bridge as unknown as {
        buildBufferFromAgentMessages: (scoop: unknown) => Promise<ChatMessage[] | null>;
      }
    ).buildBufferFromAgentMessages(CONE);

  beforeEach(async () => {
    sentMessages.length = 0;
    saved.length = 0;
    sessions.clear();
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
    conversationStore = makeConversationStore();

    bridge = new Bridge();
    await bridge.bind({
      getScoops: () => [CONE],
      getScoopContext: () => ({ getAgentMessages: () => agentMessages }),
      getConversationStore: () => conversationStore,
      getQueuedMessageIds: () => [],
    } as never);
    callbacks = Bridge.createCallbacks(bridge);
  });

  it('appends an error card to the buffer and the UI store', async () => {
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(persisted().some((m) => m.error === true)).toBe(true));

    const card = persisted().find((m) => m.error);
    expect(card).toMatchObject({
      role: 'assistant',
      content: 'rate limited',
      error: true,
    });
    const buf = (bridge as unknown as { getBuffer: (jid: string) => ChatMessage[] }).getBuffer(
      'cone_1'
    );
    expect(buf.at(-1)).toMatchObject({ content: 'rate limited', error: true });
  });

  it('keeps error: true across persist/reseed from Pi history', async () => {
    callbacks.onError?.('cone_1', 'provider exploded');
    await vi.waitFor(() => expect(persisted().some((m) => m.error === true)).toBe(true));
    const cardId = persisted().find((m) => m.error)?.id;
    expect(cardId).toBeTruthy();

    // Full reload: buffers start empty, seed rebuilds from Pi (no error row)
    // and would overwrite the UI store without the fold.
    (bridge as unknown as { messageBuffers: Map<string, unknown> }).messageBuffers.clear();
    await bridge.seedBuffersFromAgentState();

    const buf = (bridge as unknown as { getBuffer: (jid: string) => ChatMessage[] }).getBuffer(
      'cone_1'
    );
    const card = buf.find((m) => m.error === true);
    expect(card).toMatchObject({
      id: cardId,
      role: 'assistant',
      content: 'provider exploded',
      error: true,
    });
    expect(persisted().find((m) => m.id === cardId)?.error).toBe(true);
  });

  it('keeps the compaction seam when an error card is folded back in', async () => {
    conversationStore.markers.push({
      id: 'compaction-cone_1-stored',
      kind: 'compaction',
      timestamp: 1500,
      compaction: { trigger: 'threshold', state: 'summarized' },
    });
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(persisted().some((m) => m.error === true)).toBe(true));

    (bridge as unknown as { messageBuffers: Map<string, unknown> }).messageBuffers.clear();
    const rebuilt = (await rebuild()) as ChatMessage[];

    expect(rebuilt.map((m) => (m.compaction ? 'seam' : m.error ? 'error' : m.role))).toEqual([
      'user',
      'seam',
      'assistant',
      'error',
    ]);
    expect(rebuilt.find((m) => m.error)?.error).toBe(true);
    expect(rebuilt.find((m) => m.compaction)?.compaction).toMatchObject({ state: 'summarized' });
  });

  it('places a persisted error card on the timestamp seam', async () => {
    sessions.set('session-cone', [
      {
        id: 'err-mid',
        role: 'assistant',
        content: 'boom',
        timestamp: 1500,
        error: true,
      },
    ]);

    const rebuilt = (await rebuild()) as ChatMessage[];
    expect(rebuilt.map((m) => (m.error ? 'error' : m.role))).toEqual([
      'user',
      'error',
      'assistant',
    ]);
  });

  it('folds a persisted error card in once', async () => {
    callbacks.onError?.('cone_1', 'rate limited');
    await vi.waitFor(() => expect(persisted().some((m) => m.error === true)).toBe(true));

    const rebuilt = (await rebuild()) as ChatMessage[];
    expect(rebuilt.filter((m) => m.error === true)).toHaveLength(1);
  });
});
