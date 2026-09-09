/**
 * Durable compaction rows (#2843 follow-up).
 *
 * A compaction marker exists nowhere in Pi's history — it is bookkeeping
 * ABOUT that history — so the kernel is what has to write it down. These
 * tests pin the three writes that make a seam survive a reload: the message
 * buffer, the `browser-coding-agent` store, and the canonical record's
 * `markers`, plus the rebuild that folds a stored marker back in.
 */

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

/** In-memory stand-in for the canonical store's marker surface. */
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

  /** The rows the UI store was last written with. */
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

  it('records an opening round as a marker and a row', async () => {
    phase('summarizing', { transcriptPath: '/sessions/cone/before.md' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalled());

    expect(conversationStore.markers).toEqual([
      expect.objectContaining({
        kind: 'compaction',
        compaction: {
          trigger: 'idle',
          state: 'summarizing',
          transcriptPath: '/sessions/cone/before.md',
        },
      }),
    ]);
    // The same row is in the buffer the panel replays from, and in the UI
    // store a reload reads.
    expect(persisted().at(-1)).toMatchObject({
      role: 'assistant',
      content: '',
      compaction: { state: 'summarizing' },
    });
  });

  it('settles the round in place rather than stacking a second seam', async () => {
    phase('summarizing');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    phase('idle');
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(2));

    expect(conversationStore.markers).toHaveLength(1);
    expect(conversationStore.markers[0].compaction.state).toBe('summarized');
    const rows = persisted().filter((m) => m.compaction);
    expect(rows).toHaveLength(1);
    expect(rows[0].compaction?.state).toBe('summarized');
  });

  it('retracts a round that kept nothing, from the record AND the buffer', async () => {
    // A real conversation under the seam: `persistScoop` refuses to write an
    // EMPTY buffer (its truncation guard), so a transcript that is nothing
    // but the retracted row could not show the write either way.
    callbacks.onResponse?.('cone_1', 'shipped', false);
    phase('summarizing', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(1));
    phase('idle', { roundId: 'idle-1' });
    await vi.waitFor(() => expect(conversationStore.putMarker).toHaveBeenCalledTimes(2));
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

    // On the seam: after the message that preceded the round, before the one
    // that followed it. Without this, every boot re-seeds the buffer from Pi's
    // history — which never held the row — and persists the transcript minus
    // its seams over the UI store.
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
    await vi.waitFor(() => expect(saved.length).toBeGreaterThan(0));

    // The row still reaches the UI store — only the canonical annotation is
    // skipped, and nothing throws.
    expect(persisted().at(-1)?.compaction).toMatchObject({ state: 'summarizing' });
  });
});
