import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactionStateDetail } from '../../src/core/context-compaction.js';
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

const { mockSessionStore, saved } = vi.hoisted(() => {
  const saved: Array<{ sessionId: string; messages: ChatMessage[] }> = [];
  return {
    saved,
    mockSessionStore: vi.fn(function (this: Record<string, unknown>) {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.saveMessages = vi.fn(async (sessionId: string, messages: ChatMessage[]) => {
        saved.push({ sessionId, messages: structuredClone(messages) });
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

describe('kernel compaction-row persistence', () => {
  let bridge: InstanceType<typeof Bridge>;
  let callbacks: ReturnType<typeof Bridge.createCallbacks>;
  let conversationStore: ReturnType<typeof makeConversationStore>;
  let agentMessages: unknown[];

  const phase = (state: string, detail: Partial<CompactionStateDetail> = {}) =>
    callbacks.onCompactionStateChange?.(
      'cone_1',
      state as never,
      {
        trigger: 'idle',
        ...detail,
      } as CompactionStateDetail
    );

  const persisted = () => saved[saved.length - 1]?.messages ?? [];

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

  it('writes nothing durable for a round that has only started', async () => {
    phase('summarizing', { transcriptPath: '/sessions/cone/before.md' });
    await vi.waitFor(() => expect(sentMessages.length).toBeGreaterThan(0));

    expect(conversationStore.putMarker).not.toHaveBeenCalled();
    expect(persisted().filter((m) => m.compaction)).toEqual([]);
  });

  it('records the round once it settles, as a marker and a row', async () => {
    phase('summarizing', { transcriptPath: '/sessions/cone/before.md' });
    phase('idle', { transcriptPath: '/sessions/cone/before.md' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));

    expect(conversationStore.markers).toEqual([
      expect.objectContaining({
        kind: 'compaction',
        compaction: {
          trigger: 'idle',
          state: 'summarized',
          transcriptPath: '/sessions/cone/before.md',
        },
      }),
    ]);

    const rows = persisted().filter((m) => m.compaction);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'assistant',
      content: '',
      compaction: { state: 'summarized' },
    });

    expect(rows[0].id).toBe(conversationStore.markers[0].id);
  });

  it('emits the row id it will persist under', async () => {
    phase('summarizing');
    phase('idle');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));

    const emitted = sentMessages
      .map((m) => (m as { payload: { type: string; rowId?: string } }).payload)
      .filter((p) => p.type === 'compaction-state');
    expect(emitted.map((p) => p.rowId)).toEqual([
      conversationStore.markers[0].id,
      conversationStore.markers[0].id,
    ]);
  });

  it('retracts a round that kept nothing, from the record AND the buffer', async () => {
    callbacks.onResponse?.('cone_1', 'shipped', false);
    phase('summarizing', { roundId: 'idle-1' });
    phase('idle', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    phase('cancelled', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.deleteMarker).toHaveBeenCalled());

    expect(conversationStore.markers).toEqual([]);
    expect(persisted().filter((m) => m.compaction)).toEqual([]);
  });

  it('writes nothing for a phase that is not a row', async () => {
    phase('extracting-memory');
    phase('idle');
    await vi.waitFor(() => expect(sentMessages.length).toBeGreaterThan(0));

    expect(conversationStore.putMarker).not.toHaveBeenCalled();
    expect(conversationStore.deleteMarker).not.toHaveBeenCalled();
  });

  it('holds a marker the record cannot take yet and writes it at the end of the turn', async () => {
    conversationStore.putMarker.mockResolvedValueOnce(false);

    phase('summarizing');
    phase('idle');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    expect(conversationStore.markers).toEqual([]);

    callbacks.onResponseDone?.('cone_1');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(2));

    expect(conversationStore.markers).toEqual([
      expect.objectContaining({ compaction: expect.objectContaining({ state: 'summarized' }) }),
    ]);
  });

  it('stops holding a marker whose round is taken back', async () => {
    conversationStore.putMarker.mockResolvedValueOnce(false);

    phase('summarizing', { roundId: 'idle-1' });
    phase('idle', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    phase('cancelled', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.deleteMarker).toHaveBeenCalled());

    callbacks.onResponseDone?.('cone_1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(conversationStore.putMarker).toHaveBeenCalledTimes(1);
    expect(conversationStore.markers).toEqual([]);
  });

  it('folds a stored marker back into a rebuild from live agent state', async () => {
    conversationStore.markers.push({
      id: 'compaction-cone_1-stored',
      kind: 'compaction',
      timestamp: 1500,
      compaction: { trigger: 'threshold', state: 'summarized' },
    });

    const rebuilt = (await (
      bridge as unknown as {
        buildBufferFromAgentMessages: (scoop: unknown) => Promise<ChatMessage[] | null>;
      }
    ).buildBufferFromAgentMessages(CONE)) as ChatMessage[];

    expect(rebuilt.map((m) => (m.compaction ? 'seam' : m.role))).toEqual([
      'user',
      'seam',
      'assistant',
    ]);
  });

  it('survives a float with no canonical store at all', async () => {
    const plain = new Bridge();
    await plain.bind({
      getScoops: () => [CONE],
      getScoopContext: () => ({ getAgentMessages: () => agentMessages }),
      getQueuedMessageIds: () => [],
    } as never);
    const plainCallbacks = Bridge.createCallbacks(plain);

    plainCallbacks.onCompactionStateChange?.('cone_1', 'summarizing', { trigger: 'threshold' });
    plainCallbacks.onCompactionStateChange?.('cone_1', 'idle', { trigger: 'threshold' });
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));

    expect(persisted().at(-1)?.compaction).toMatchObject({ state: 'summarized' });
  });
});
