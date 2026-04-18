// @vitest-environment jsdom
/**
 * Regression test for the selection-time hydration race.
 *
 * Two independent SessionStore.load() calls happened during scoop selection:
 *   1. OffscreenClient.reconcileForScoopSelection() — seeds currentMessageId
 *   2. ChatPanel.switchToContext() — renders the message list
 *
 * The offscreen bridge persists to the shared IndexedDB on every delta
 * (fire-and-forget), so a persist could land between the two reads. When
 * that happened, the reconciled state and the rendered state disagreed
 * and the next text_delta either forked a new assistant row (visible
 * duplicate) or silently dropped into a non-rendered message id.
 *
 * Fix: reconcileForScoopSelection now returns the loaded Session, and
 * switchToContext accepts that same snapshot as preloadedSession so both
 * reads come from a single IndexedDB snapshot.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// chrome.runtime mock matching the offscreen-client test harness
const messageListeners: Array<
  (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => void
> = [];
const sentMessages: unknown[] = [];

const mockChrome = {
  runtime: {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test/${path}`,
    lastError: undefined,
    sendMessage: vi.fn(async (msg: unknown) => {
      sentMessages.push(msg);
    }),
    onMessage: {
      addListener: vi.fn((cb: any) => {
        messageListeners.push(cb);
      }),
      removeListener: vi.fn(),
    },
  },
};

(globalThis as any).chrome = mockChrome;

function installMockLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

const { OffscreenClient } = await import('../../src/ui/offscreen-client.js');
const { ChatPanel } = await import('../../src/ui/chat-panel.js');
const { SessionStore } = await import('../../src/ui/session-store.js');
import type { ChatMessage } from '../../src/ui/types.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

function simulateMessage(source: string, payload: unknown): void {
  for (const listener of messageListeners) {
    listener({ source, payload }, {}, () => {});
  }
}

function makeScoop(jid: string, folder: string): RegisteredScoop {
  return {
    jid,
    name: folder,
    folder,
    isCone: false,
    type: 'scoop',
    requiresTrigger: true,
    assistantLabel: folder,
    addedAt: '',
  };
}

describe('selection-time hydration race', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    installMockLocalStorage();
    localStorage.clear();
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
  });

  it('does not fork a new assistant row when a bridge persist lands between reconcile and switchToContext', async () => {
    const scoopJid = 'agent_race';
    const folder = 'scoop-x';
    const contextId = `session-${folder}`;

    // Seed S1: user message only, no assistant yet. This is what reconcile
    // will load.
    const store = new SessionStore();
    await store.init();
    const s1: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
      },
    ];
    await store.saveMessages(contextId, s1);

    // Build the real OffscreenClient + real ChatPanel (same harness the
    // extension uses at runtime).
    const client = new OffscreenClient({
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
      onPendingHandoffsChange: vi.fn(),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    await panel.initSession('default');

    // Step 1: reconcile — load #1. At this point the bridge has not yet
    // persisted the assistant message.
    const reconciledSession = await client.reconcileForScoopSelection(makeScoop(scoopJid, folder));

    // currentMessageId must be cleared because S1 has no streaming assistant.
    expect((client as any).currentMessageId.has(scoopJid)).toBe(false);
    // reconcile now returns the loaded session (Session | null).
    expect(reconciledSession).not.toBeNull();
    expect(reconciledSession?.messages.map((m) => m.id)).toEqual(['u1']);

    // Step 2: bridge persist lands BETWEEN load #1 and load #2. The bridge
    // writes a new streaming assistant message (msg-5) on the first delta.
    const s2: ChatMessage[] = [
      ...s1,
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'hello',
        timestamp: 2,
        isStreaming: true,
      },
    ];
    await store.saveMessages(contextId, s2);

    // Step 3: switchToContext — load #2 in pre-fix code, preloaded session
    // in post-fix code. The fix passes reconciledSession as the preloaded
    // session so switchToContext uses the SAME snapshot reconcile saw.
    await panel.switchToContext(contextId, false, 'scoop-x', reconciledSession);

    // Wire the panel's agent handle to the OffscreenClient so it receives
    // the events we fire below.
    client.selectedScoopJid = scoopJid;
    const handle = client.createAgentHandle();
    panel.setAgent(handle);

    // Step 4: simulate a text_delta from the running scoop.
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid,
      eventType: 'text_delta',
      text: ' world',
    });

    // Flush any requestAnimationFrame-scheduled delta work.
    await new Promise((r) => setTimeout(r, 20));

    // Core assertion: exactly ONE assistant row in the panel — no fork.
    //
    // Pre-fix: switchToContext did its own fresh load and saw S2 with
    // msg-5. The delta's message_start then appended a second assistant
    // row (scoop-<jid>-<uid>), leaving the panel with two rows.
    //
    // Post-fix: switchToContext uses the reconciled snapshot (S1), so the
    // bridge's in-flight msg-5 is not double-counted — only one row is
    // created, sourced from the delta's synthesized id.
    const assistantRows = panel.getMessages().filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
  });

  it('uses the preloaded session for both seed and render when provided, ignoring later bridge persists', async () => {
    // Complement to the fork test: verify that when a snapshot containing
    // the in-progress assistant is passed via preloadedSession, it is
    // used for rendering even if a subsequent bridge persist has mutated
    // IndexedDB. This proves the two reads are unified — both come from
    // the same snapshot.
    const scoopJid = 'agent_race_preload';
    const folder = 'scoop-preload';
    const contextId = `session-${folder}`;

    const store = new SessionStore();
    await store.init();
    const s1: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
      },
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'hello',
        timestamp: 2,
        isStreaming: true,
      },
    ];
    await store.saveMessages(contextId, s1);

    const client = new OffscreenClient({
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
      onPendingHandoffsChange: vi.fn(),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    await panel.initSession('default');

    const reconciledSession = await client.reconcileForScoopSelection(makeScoop(scoopJid, folder));

    // reconcile seeded currentMessageId to msg-5 (the in-progress assistant).
    expect((client as any).currentMessageId.get(scoopJid)).toBe('msg-5');
    expect(reconciledSession?.messages.map((m) => m.id)).toEqual(['u1', 'msg-5']);

    // Bridge persists a further delta AFTER reconcile but BEFORE the panel
    // renders. The fix must keep using the reconciled snapshot, not this.
    await store.saveMessages(contextId, [
      ...s1.slice(0, 1),
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'hello there',
        timestamp: 3,
        isStreaming: true,
      },
    ]);

    // Pass the reconciled snapshot to switchToContext — both reads come
    // from the same IndexedDB snapshot.
    await panel.switchToContext(contextId, false, 'scoop-preload', reconciledSession);

    const msgs = panel.getMessages();
    const assistantRows = msgs.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0].id).toBe('msg-5');
    // Content reflects the preloaded snapshot, not the later persist.
    expect(assistantRows[0].content).toBe('hello');
  });

  it('backwards-compat: switchToContext without preloadedSession still performs its own load (CLI path)', async () => {
    const folder = 'scoop-cli';
    const contextId = `session-${folder}`;

    const store = new SessionStore();
    await store.init();
    const persisted: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'howdy',
        timestamp: 2,
      },
    ];
    await store.saveMessages(contextId, persisted);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    await panel.initSession('default');

    // No 4th arg — CLI call sites keep working with the 3-arg signature.
    await panel.switchToContext(contextId, false, folder);

    const msgs = panel.getMessages();
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('applies text_delta to a seeded in-progress assistant id without dropping', async () => {
    // Seeded-id adoption regression: after reconcileForScoopSelection seeds
    // currentMessageId for an in-progress assistant, OffscreenClient skips
    // message_start and emits only content_delta. ChatPanel must lazily
    // adopt that messageId as currentStreamId so pendingDeltaText flushes
    // into the real message row — otherwise flushPendingDelta early-returns
    // (currentStreamId === null) and the tokens disappear.
    const scoopJid = 'agent_seeded_adopt';
    const folder = 'scoop-adopt';
    const contextId = `session-${folder}`;

    const store = new SessionStore();
    await store.init();
    const s1: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'hello',
        timestamp: 2,
        isStreaming: true,
      },
    ];
    await store.saveMessages(contextId, s1);

    const client = new OffscreenClient({
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
      onPendingHandoffsChange: vi.fn(),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    await panel.initSession('default');

    // Reconcile seeds currentMessageId = 'msg-5' and returns the snapshot.
    const reconciledSession = await client.reconcileForScoopSelection(makeScoop(scoopJid, folder));
    expect((client as any).currentMessageId.get(scoopJid)).toBe('msg-5');

    // Use the unified snapshot for rendering.
    await panel.switchToContext(contextId, false, folder, reconciledSession);

    // Wire the panel's agent handle to the client so it receives events.
    client.selectedScoopJid = scoopJid;
    const handle = client.createAgentHandle();
    panel.setAgent(handle);

    // Fire a seeded-id text_delta — OffscreenClient emits ONLY content_delta
    // (no message_start) because currentMessageId was seeded.
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid,
      eventType: 'text_delta',
      text: ' world',
    });

    // Flush RAF-scheduled pendingDeltaText.
    await new Promise((r) => setTimeout(r, 20));

    // Then the response completes.
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid,
      eventType: 'response_done',
    });
    await new Promise((r) => setTimeout(r, 20));

    const msgs = panel.getMessages();
    const assistantRows = msgs.filter((m) => m.role === 'assistant');
    // Exactly one assistant row — no fork from a synthetic message_start.
    expect(assistantRows).toHaveLength(1);
    const target = msgs.find((m) => m.id === 'msg-5');
    expect(target).toBeDefined();
    // Pre-fix: content stays 'hello' because flushPendingDelta early-returns
    // when currentStreamId is null. Post-fix: delta appends.
    expect(target!.content).toBe('hello world');
    // After content_done, streaming flag flips off.
    expect(target!.isStreaming).toBe(false);
  });

  it('accumulates multiple seeded deltas across frames', async () => {
    // Progression regression: once currentStreamId is adopted for a seeded
    // id, subsequent RAF flushes must keep accumulating into the same row.
    const scoopJid = 'agent_seeded_multi';
    const folder = 'scoop-multi';
    const contextId = `session-${folder}`;

    const store = new SessionStore();
    await store.init();
    const s1: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
      {
        id: 'msg-5',
        role: 'assistant',
        content: 'hello',
        timestamp: 2,
        isStreaming: true,
      },
    ];
    await store.saveMessages(contextId, s1);

    const client = new OffscreenClient({
      onStatusChange: vi.fn(),
      onScoopCreated: vi.fn(),
      onScoopListUpdate: vi.fn(),
      onIncomingMessage: vi.fn(),
      onPendingHandoffsChange: vi.fn(),
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new ChatPanel(container);
    await panel.initSession('default');

    const reconciledSession = await client.reconcileForScoopSelection(makeScoop(scoopJid, folder));
    await panel.switchToContext(contextId, false, folder, reconciledSession);

    client.selectedScoopJid = scoopJid;
    const handle = client.createAgentHandle();
    panel.setAgent(handle);

    // Fire three text_delta events with a RAF flush between each.
    for (const chunk of [' a', ' b', ' c']) {
      simulateMessage('offscreen', {
        type: 'agent-event',
        scoopJid,
        eventType: 'text_delta',
        text: chunk,
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid,
      eventType: 'response_done',
    });
    await new Promise((r) => setTimeout(r, 20));

    const msgs = panel.getMessages();
    const assistantRows = msgs.filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(1);
    const target = msgs.find((m) => m.id === 'msg-5');
    expect(target).toBeDefined();
    expect(target!.content).toBe('hello a b c');
    expect(target!.isStreaming).toBe(false);
  });
});
