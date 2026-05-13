/**
 * Tests for OffscreenBridge — Orchestrator ↔ chrome.runtime message bridge.
 *
 * Verifies:
 * - createCallbacks() - text accumulation, tool tracking, message source attribution
 * - buildStateSnapshot() - scoop mapping, cone identification
 * - persistScoop() - correct session ID mapping, fire-and-forget error handling
 * - getBuffer/getOrCreateAssistantMsg - buffer isolation, source attribution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock chrome.runtime
const messageListeners: Array<
  (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => void
> = [];
const sentMessages: unknown[] = [];

const mockChrome = {
  runtime: {
    id: 'test-extension-id',
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

// Mock SessionStore module via hoisted to get type safety
const { mockSessionStore, mockHandleAction } = vi.hoisted(() => ({
  mockSessionStore: vi.fn(function (this: any) {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.saveMessages = vi.fn().mockResolvedValue(undefined);
    this.delete = vi.fn().mockResolvedValue(undefined);
  }),
  mockHandleAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../webapp/src/ui/session-store.js', () => ({
  SessionStore: mockSessionStore,
}));

vi.mock('../../webapp/src/tools/tool-ui.js', () => ({
  toolUIRegistry: {
    handleAction: mockHandleAction,
  },
}));

const { OffscreenBridge } = await import('../src/offscreen-bridge.js');
const { SessionStore } = await import('../../webapp/src/ui/session-store.js');

describe('OffscreenBridge createCallbacks', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;
  let callbacks: any;

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new OffscreenBridge();

    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
        },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      createScoopTab: vi.fn().mockResolvedValue(undefined),
      registerScoop: vi.fn().mockResolvedValue(undefined),
      unregisterScoop: vi.fn().mockResolvedValue(undefined),
      stopScoop: vi.fn().mockResolvedValue(undefined),
      clearQueuedMessages: vi.fn().mockResolvedValue(undefined),
      clearAllMessages: vi.fn().mockResolvedValue(undefined),
      delegateToScoop: vi.fn().mockResolvedValue(undefined),
      updateModel: vi.fn().mockResolvedValue(undefined),
    };

    callbacks = OffscreenBridge.createCallbacks(bridge);
  });

  it('onResponse accumulates text on isPartial:true', () => {
    const scoopJid = 'cone_1';
    callbacks.onResponse(scoopJid, 'Hello', true);
    callbacks.onResponse(scoopJid, ' world', true);

    const buf = (bridge as any).getBuffer(scoopJid);
    const msg = buf[0];
    expect(msg.content).toBe('Hello world');
    expect(msg.isStreaming).toBe(true);
  });

  it('onResponse replaces content on isPartial:false', () => {
    const scoopJid = 'cone_1';
    callbacks.onResponse(scoopJid, 'Partial text', true);
    callbacks.onResponse(scoopJid, 'Complete text', false);

    const buf = (bridge as any).getBuffer(scoopJid);
    const msg = buf[0];
    expect(msg.content).toBe('Complete text');
    expect(msg.isStreaming).toBe(false);
  });

  it('onResponse emits agent-event text_delta', () => {
    const scoopJid = 'cone_1';
    callbacks.onResponse(scoopJid, 'Hello', true);

    const emitted = sentMessages[0] as any;
    expect(emitted.source).toBe('offscreen');
    expect(emitted.payload.type).toBe('agent-event');
    expect(emitted.payload.scoopJid).toBe(scoopJid);
    expect(emitted.payload.eventType).toBe('text_delta');
    expect(emitted.payload.text).toBe('Hello');
  });

  it('onResponseDone marks message not streaming and persists', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const scoopJid = 'cone_1';
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;

    callbacks.onResponse(scoopJid, 'Hello', true);
    callbacks.onResponseDone(scoopJid);

    const buf = (bridge as any).getBuffer(scoopJid);
    const msg = buf[0];
    expect(msg.isStreaming).toBe(false);
    expect(mockStore.saveMessages).toHaveBeenCalled();
  });

  it('onResponseDone clears currentMessageId', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const scoopJid = 'cone_1';
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;

    callbacks.onResponse(scoopJid, 'Hello', true);
    expect((bridge as any).currentMessageId.has(scoopJid)).toBe(true);

    callbacks.onResponseDone(scoopJid);
    expect((bridge as any).currentMessageId.has(scoopJid)).toBe(false);
  });

  it('onToolStart filters hidden tools and tracks in message', () => {
    const scoopJid = 'cone_1';
    callbacks.onResponse(scoopJid, 'Processing', true);

    // Hidden tool should not be tracked
    callbacks.onToolStart(scoopJid, 'send_message', { text: 'hidden' });
    const buf = (bridge as any).getBuffer(scoopJid);
    let msg = buf[0];
    expect(msg.toolCalls?.length).toBe(0);

    // Visible tool should be tracked
    callbacks.onToolStart(scoopJid, 'bash', { command: 'ls' });
    msg = buf[0];
    expect(msg.toolCalls?.length).toBe(1);
    expect(msg.toolCalls![0].name).toBe('bash');
    expect(msg.toolCalls![0].input).toEqual({ command: 'ls' });
  });

  it('onToolEnd filters hidden tools', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const scoopJid = 'cone_1';
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;

    callbacks.onResponse(scoopJid, 'Processing', true);
    callbacks.onToolStart(scoopJid, 'bash', { command: 'ls' });

    // Hidden tool result should not be tracked
    callbacks.onToolEnd(scoopJid, 'send_message', 'hidden result', false);

    const buf = (bridge as any).getBuffer(scoopJid);
    const msg = buf[0];
    expect(msg.toolCalls?.length).toBe(1);
    expect(msg.toolCalls![0].result).toBeUndefined();

    // Visible tool result should be tracked
    callbacks.onToolEnd(scoopJid, 'bash', 'file1.txt\nfile2.txt', false);
    expect(msg.toolCalls![0].result).toBe('file1.txt\nfile2.txt');
    expect(msg.toolCalls![0].isError).toBe(false);
  });

  it('onToolEnd marks error correctly', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const scoopJid = 'cone_1';
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;

    callbacks.onResponse(scoopJid, 'Processing', true);
    callbacks.onToolStart(scoopJid, 'bash', { command: 'false' });
    callbacks.onToolEnd(scoopJid, 'bash', 'Error: command failed', true);

    const buf = (bridge as any).getBuffer(scoopJid);
    const msg = buf[0];
    expect(msg.toolCalls![0].isError).toBe(true);
  });

  it('onIncomingMessage formats delegation prefix', () => {
    const scoopJid = 'scoop_test';
    const msg = {
      id: 'msg-1',
      content: 'Do this work',
      channel: 'delegation' as const,
      senderName: 'sliccy',
      fromAssistant: true,
      timestamp: new Date().toISOString(),
    };

    callbacks.onIncomingMessage(scoopJid, msg);

    const buf = (bridge as any).getBuffer(scoopJid);
    const bufferedMsg = buf[0];
    expect(bufferedMsg.content).toContain('**[Instructions from sliccy]**');
    expect(bufferedMsg.content).toContain('Do this work');
    expect(bufferedMsg.source).toBe('delegation');
    expect(bufferedMsg.channel).toBe('delegation');
  });

  it('onIncomingMessage formats regular user message', () => {
    const scoopJid = 'scoop_test';
    const msg = {
      id: 'msg-2',
      content: 'Regular message',
      channel: 'web' as const,
      senderName: 'User',
      fromAssistant: false,
      timestamp: new Date().toISOString(),
    };

    callbacks.onIncomingMessage(scoopJid, msg);

    const buf = (bridge as any).getBuffer(scoopJid);
    const bufferedMsg = buf[0];
    expect(bufferedMsg.content).toBe('Regular message');
    expect(bufferedMsg.source).toBeUndefined();
    expect(bufferedMsg.channel).toBe('web');
  });

  it('onIncomingMessage persists the scoop', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;
    const scoopJid = 'cone_1';

    const msg = {
      id: 'msg-3',
      content: 'Test',
      channel: 'web' as const,
      senderName: 'User',
      fromAssistant: false,
      timestamp: new Date().toISOString(),
    };

    callbacks.onIncomingMessage(scoopJid, msg);

    expect(mockStore.saveMessages).toHaveBeenCalled();
  });

  it('onStatusChange updates status and emits event', () => {
    const scoopJid = 'cone_1';
    callbacks.onStatusChange(scoopJid, 'processing');

    expect((bridge as any).scoopStatuses.get(scoopJid)).toBe('processing');

    const emitted = sentMessages[0] as any;
    expect(emitted.payload.type).toBe('scoop-status');
    expect(emitted.payload.scoopJid).toBe(scoopJid);
    expect(emitted.payload.status).toBe('processing');
  });

  it('onStatusChange clears currentMessageId when ready', () => {
    const scoopJid = 'cone_1';
    callbacks.onResponse(scoopJid, 'Hello', true);
    expect((bridge as any).currentMessageId.has(scoopJid)).toBe(true);

    callbacks.onStatusChange(scoopJid, 'ready');
    expect((bridge as any).currentMessageId.has(scoopJid)).toBe(false);
  });

  it('onError emits error message', () => {
    const scoopJid = 'cone_1';
    callbacks.onError(scoopJid, 'Something went wrong');

    const emitted = sentMessages[0] as any;
    expect(emitted.payload.type).toBe('error');
    expect(emitted.payload.scoopJid).toBe(scoopJid);
    expect(emitted.payload.error).toBe('Something went wrong');
  });

  it('onSendMessage buffers, persists, and emits text_delta + response_done', () => {
    (bridge as any).orchestrator = mockOrchestrator;
    const mockStore = new SessionStore();
    (bridge as any).sessionStore = mockStore;

    const targetJid = 'cone_1';
    callbacks.onSendMessage(targetJid, 'Hello from scoop!');

    // Should buffer
    const buf = (bridge as any).getBuffer(targetJid);
    expect(buf.length).toBe(1);
    expect(buf[0].role).toBe('assistant');
    expect(buf[0].content).toBe('Hello from scoop!');

    // Should persist
    expect(mockStore.saveMessages).toHaveBeenCalledWith('session-cone', expect.anything());

    // Should emit text_delta then response_done
    const events = sentMessages.map((m: any) => m.payload);
    const textDelta = events.find((e: any) => e.eventType === 'text_delta');
    const responseDone = events.find((e: any) => e.eventType === 'response_done');

    expect(textDelta).toBeDefined();
    expect(textDelta.scoopJid).toBe(targetJid);
    expect(textDelta.text).toBe('Hello from scoop!');

    expect(responseDone).toBeDefined();
    expect(responseDone.scoopJid).toBe(targetJid);
  });

  it('onToolUI emits agent-event with tool_ui eventType', () => {
    callbacks.onToolUI!('cone_1', 'bash', 'req-123', '<div>Mount?</div>');

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        source: 'offscreen',
        payload: expect.objectContaining({
          type: 'agent-event',
          scoopJid: 'cone_1',
          eventType: 'tool_ui',
          toolName: 'bash',
          requestId: 'req-123',
          html: '<div>Mount?</div>',
        }),
      })
    );
  });

  it('onToolUIDone emits agent-event with tool_ui_done eventType', () => {
    callbacks.onToolUIDone!('cone_1', 'req-123');

    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        source: 'offscreen',
        payload: expect.objectContaining({
          type: 'agent-event',
          scoopJid: 'cone_1',
          eventType: 'tool_ui_done',
          requestId: 'req-123',
        }),
      })
    );
  });
});

describe('OffscreenBridge buildStateSnapshot', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new OffscreenBridge();

    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
        },
      ]),
    };

    (bridge as any).orchestrator = mockOrchestrator;
  });

  it('maps scoops correctly', () => {
    const snapshot = bridge.buildStateSnapshot();

    expect(snapshot.type).toBe('state-snapshot');
    expect(snapshot.scoops.length).toBe(2);
    expect(snapshot.scoops[0].jid).toBe('cone_1');
    expect(snapshot.scoops[0].name).toBe('Cone');
    expect(snapshot.scoops[0].isCone).toBe(true);
    expect(snapshot.scoops[1].jid).toBe('scoop_test');
    expect(snapshot.scoops[1].isCone).toBe(false);
  });

  it('sets activeScoopJid to cone jid', () => {
    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.activeScoopJid).toBe('cone_1');
  });

  it('sets activeScoopJid to null when no cone', () => {
    mockOrchestrator.getScoops.mockReturnValue([
      {
        jid: 'scoop_1',
        name: 'Test',
        folder: 'test-scoop',
        isCone: false,
        assistantLabel: 'test-scoop',
      },
    ]);

    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.activeScoopJid).toBeNull();
  });

  it('includes status from scoopStatuses map', () => {
    (bridge as any).scoopStatuses.set('cone_1', 'processing');
    (bridge as any).scoopStatuses.set('scoop_test', 'ready');

    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.scoops[0].status).toBe('processing');
    expect(snapshot.scoops[1].status).toBe('ready');
  });

  it('defaults to ready for scoops without status', () => {
    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.scoops[0].status).toBe('ready');
    expect(snapshot.scoops[1].status).toBe('ready');
  });

  it('handles empty scoops list', () => {
    mockOrchestrator.getScoops.mockReturnValue([]);
    const snapshot = bridge.buildStateSnapshot();

    expect(snapshot.scoops).toEqual([]);
    expect(snapshot.activeScoopJid).toBeNull();
  });

  it('handles null orchestrator gracefully', () => {
    (bridge as any).orchestrator = null;
    const snapshot = bridge.buildStateSnapshot();

    expect(snapshot.scoops).toEqual([]);
    expect(snapshot.activeScoopJid).toBeNull();
  });
});

describe('OffscreenBridge getBuffer/getOrCreateAssistantMsg', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new OffscreenBridge();

    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
        },
      ]),
    };

    (bridge as any).orchestrator = mockOrchestrator;
  });

  it('getBuffer creates isolated buffer per scoop', () => {
    const buf1 = (bridge as any).getBuffer('cone_1');
    const buf2 = (bridge as any).getBuffer('scoop_test');

    expect(buf1).not.toBe(buf2);
    expect(buf1).toEqual([]);
    expect(buf2).toEqual([]);
  });

  it('getBuffer returns same buffer on repeated calls', () => {
    const buf1 = (bridge as any).getBuffer('cone_1');
    buf1.push({ id: 'msg-1', role: 'user', content: 'test', timestamp: Date.now() });

    const buf2 = (bridge as any).getBuffer('cone_1');
    expect(buf2.length).toBe(1);
    expect(buf2[0].content).toBe('test');
  });

  it('getOrCreateAssistantMsg sets source to cone for cone scoop', () => {
    const msg = (bridge as any).getOrCreateAssistantMsg('cone_1');

    expect(msg.role).toBe('assistant');
    expect(msg.source).toBe('cone');
    expect(msg.isStreaming).toBe(true);
  });

  it('getOrCreateAssistantMsg sets source to scoop name', () => {
    const msg = (bridge as any).getOrCreateAssistantMsg('scoop_test');

    expect(msg.source).toBe('Test');
  });

  it('getOrCreateAssistantMsg returns same message on repeated calls', () => {
    const msg1 = (bridge as any).getOrCreateAssistantMsg('cone_1');
    const msg2 = (bridge as any).getOrCreateAssistantMsg('cone_1');

    expect(msg1.id).toBe(msg2.id);
  });

  it('getOrCreateAssistantMsg adds message to buffer', () => {
    (bridge as any).getOrCreateAssistantMsg('cone_1');

    const buf = (bridge as any).getBuffer('cone_1');
    expect(buf.length).toBe(1);
    expect(buf[0].role).toBe('assistant');
  });

  it('getOrCreateAssistantMsg creates new message after currentMessageId deleted', () => {
    const msg1 = (bridge as any).getOrCreateAssistantMsg('cone_1');
    const id1 = msg1.id;

    (bridge as any).currentMessageId.delete('cone_1');

    const msg2 = (bridge as any).getOrCreateAssistantMsg('cone_1');
    expect(msg2.id).not.toBe(id1);

    const buf = (bridge as any).getBuffer('cone_1');
    expect(buf.length).toBe(2);
  });
});

describe('OffscreenBridge persistScoop', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;
  let mockStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new OffscreenBridge();

    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
        },
      ]),
    };

    mockStore = new SessionStore();
    (bridge as any).orchestrator = mockOrchestrator;
    (bridge as any).sessionStore = mockStore;
  });

  it('maps cone to session-cone', () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-1', role: 'user', content: 'test', timestamp: Date.now() });

    (bridge as any).persistScoop('cone_1');

    expect(mockStore.saveMessages).toHaveBeenCalledWith('session-cone', expect.anything());
  });

  it('maps scoop to session-{folder}', () => {
    const buf = (bridge as any).getBuffer('scoop_test');
    buf.push({ id: 'msg-1', role: 'user', content: 'test', timestamp: Date.now() });

    (bridge as any).persistScoop('scoop_test');

    expect(mockStore.saveMessages).toHaveBeenCalledWith('session-test-scoop', expect.anything());
  });

  it('early returns when no sessionStore', () => {
    (bridge as any).sessionStore = null;
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-1', role: 'user', content: 'test', timestamp: Date.now() });

    (bridge as any).persistScoop('cone_1');

    // No assertion needed; should just not crash
    expect(true).toBe(true);
  });

  it('early returns when scoop not found', () => {
    (bridge as any).persistScoop('unknown_scoop');

    expect(mockStore.saveMessages).not.toHaveBeenCalled();
  });

  it('early returns when buffer is empty', () => {
    (bridge as any).persistScoop('cone_1');

    expect(mockStore.saveMessages).not.toHaveBeenCalled();
  });

  it('swallows saveMessages errors (fire-and-forget)', () => {
    mockStore.saveMessages.mockRejectedValue(new Error('DB full'));

    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-1', role: 'user', content: 'test', timestamp: Date.now() });

    // Should not throw
    expect(() => {
      (bridge as any).persistScoop('cone_1');
    }).not.toThrow();
  });

  it('passes buffer as messages to sessionStore', () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-1', role: 'user', content: 'hello', timestamp: 100 });
    buf.push({ id: 'msg-2', role: 'assistant', content: 'world', timestamp: 200 });

    (bridge as any).persistScoop('cone_1');

    expect(mockStore.saveMessages).toHaveBeenCalledWith('session-cone', buf);
  });
});

describe('OffscreenBridge handlePanelMessage', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new OffscreenBridge();
    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
        },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      createScoopTab: vi.fn(),
      registerScoop: vi.fn().mockResolvedValue(undefined),
      unregisterScoop: vi.fn().mockResolvedValue(undefined),
      stopScoop: vi.fn(),
      clearQueuedMessages: vi.fn().mockResolvedValue(undefined),
      clearAllMessages: vi.fn().mockResolvedValue(undefined),
      clearScoopMessages: vi.fn().mockResolvedValue(undefined),
      delegateToScoop: vi.fn().mockResolvedValue(undefined),
      updateModel: vi.fn(),
    };

    await bridge.bind(mockOrchestrator);
  });

  function simulatePanelMessage(payload: unknown): void {
    for (const listener of messageListeners) {
      listener({ source: 'panel', payload }, {}, () => {});
    }
  }

  it('dispatches user-message to orchestrator.handleMessage', async () => {
    simulatePanelMessage({
      type: 'user-message',
      scoopJid: 'cone_1',
      text: 'Hello world',
      messageId: 'msg-1',
    });

    // handlePanelMessage is async — give it a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'cone_1',
        senderId: 'user',
        content: 'Hello world',
        channel: 'web',
      })
    );
    expect(mockOrchestrator.createScoopTab).toHaveBeenCalledWith('cone_1');
  });

  it('dispatches scoop-drop and cleans up session', async () => {
    simulatePanelMessage({
      type: 'scoop-drop',
      scoopJid: 'scoop_test',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.unregisterScoop).toHaveBeenCalledWith('scoop_test');
    // Session store delete should have been called for the scoop's session
    const store = (bridge as any).sessionStore;
    expect(store.delete).toHaveBeenCalledWith('session-test-scoop');
  });

  it('dispatches clear-chat (default target=cone) and clears only the cone session', async () => {
    simulatePanelMessage({ type: 'clear-chat' });

    await new Promise((r) => setTimeout(r, 10));

    // Default target is 'cone' — clear only the cone, leave scoops alive.
    expect(mockOrchestrator.clearScoopMessages).toHaveBeenCalledWith('cone_1');
    expect(mockOrchestrator.clearAllMessages).not.toHaveBeenCalled();
    const store = (bridge as any).sessionStore;
    expect(store.delete).toHaveBeenCalledWith('session-cone');
    expect(store.delete).not.toHaveBeenCalledWith('session-test-scoop');
  });

  it('dispatches clear-chat target=all and clears every scoop session', async () => {
    simulatePanelMessage({ type: 'clear-chat', target: 'all' });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.clearAllMessages).toHaveBeenCalled();
    expect(mockOrchestrator.clearScoopMessages).not.toHaveBeenCalled();
    const store = (bridge as any).sessionStore;
    expect(store.delete).toHaveBeenCalledWith('session-cone');
    expect(store.delete).toHaveBeenCalledWith('session-test-scoop');
  });

  it('dispatches abort to orchestrator.stopScoop', async () => {
    simulatePanelMessage({ type: 'abort', scoopJid: 'cone_1' });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.stopScoop).toHaveBeenCalledWith('cone_1');
  });

  it('ignores non-panel messages', async () => {
    for (const listener of messageListeners) {
      listener(
        {
          source: 'offscreen',
          payload: { type: 'user-message', scoopJid: 'cone_1', text: 'x', messageId: 'm' },
        },
        {},
        () => {}
      );
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it('forwards panel-cdp-command through BrowserAPI transport', async () => {
    const mockTransport = {
      send: vi.fn().mockResolvedValue({ frameId: '123' }),
    };
    const mockBrowserAPI = {
      getTransport: vi.fn(() => mockTransport),
    };
    (bridge as any).browserAPI = mockBrowserAPI;

    simulatePanelMessage({
      type: 'panel-cdp-command',
      id: 42,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      sessionId: 'session-1',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockTransport.send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://example.com' },
      'session-1'
    );

    // Should emit panel-cdp-response with result
    const response = sentMessages.find((m: any) => m.payload?.type === 'panel-cdp-response') as any;
    expect(response).toBeDefined();
    expect(response.payload.id).toBe(42);
    expect(response.payload.result).toEqual({ frameId: '123' });
  });

  it('returns error response when BrowserAPI is not available', async () => {
    (bridge as any).browserAPI = null;

    simulatePanelMessage({
      type: 'panel-cdp-command',
      id: 99,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = sentMessages.find((m: any) => m.payload?.type === 'panel-cdp-response') as any;
    expect(response).toBeDefined();
    expect(response.payload.id).toBe(99);
    expect(response.payload.error).toBe('BrowserAPI not available');
  });

  it('returns error response when transport.send throws', async () => {
    const mockTransport = {
      send: vi.fn().mockRejectedValue(new Error('Tab not found')),
    };
    const mockBrowserAPI = {
      getTransport: vi.fn(() => mockTransport),
    };
    (bridge as any).browserAPI = mockBrowserAPI;

    simulatePanelMessage({
      type: 'panel-cdp-command',
      id: 77,
      method: 'Page.navigate',
      params: { url: 'https://bad.example' },
    });

    await new Promise((r) => setTimeout(r, 10));

    const response = sentMessages.find((m: any) => m.payload?.type === 'panel-cdp-response') as any;
    expect(response).toBeDefined();
    expect(response.payload.id).toBe(77);
    expect(response.payload.error).toBe('Tab not found');
  });

  it('tool-ui-action relays to toolUIRegistry.handleAction', async () => {
    mockHandleAction.mockClear();

    simulatePanelMessage({
      type: 'tool-ui-action',
      requestId: 'req-456',
      action: 'approve',
      data: { handleInIdb: true, idbKey: 'pendingMount:req-456', dirName: 'mydir' },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockHandleAction).toHaveBeenCalledWith('req-456', {
      action: 'approve',
      data: { handleInIdb: true, idbKey: 'pendingMount:req-456', dirName: 'mydir' },
    });
  });
});

describe('OffscreenBridge follower mode', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let mockOrchestrator: any;
  let mockSync: any;
  let mockStore: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new OffscreenBridge();
    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_test',
          name: 'Test',
          folder: 'test-scoop',
          isCone: false,
          assistantLabel: 'test-scoop',
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
    };
    await bridge.bind(mockOrchestrator);

    mockSync = {
      sendMessage: vi.fn(),
      close: vi.fn(),
    };
    mockStore = (bridge as any).sessionStore;
  });

  function simulatePanelMessage(payload: unknown): void {
    for (const listener of messageListeners) {
      listener({ source: 'panel', payload }, {}, () => {});
    }
  }

  it('setFollowerSync stores the manager and clears with null', () => {
    bridge.setFollowerSync(mockSync);
    expect((bridge as any).followerSync).toBe(mockSync);
    bridge.setFollowerSync(null);
    expect((bridge as any).followerSync).toBeNull();
  });

  it('user-message in follower mode forwards to followerSync, skips orchestrator', async () => {
    bridge.setFollowerSync(mockSync);

    simulatePanelMessage({
      type: 'user-message',
      scoopJid: 'cone_1',
      text: 'leader, do x',
      messageId: 'msg-f1',
      attachments: [{ kind: 'text', name: 'a.md', text: 'hi' }],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockSync.sendMessage).toHaveBeenCalledWith('leader, do x', 'msg-f1', [
      { kind: 'text', name: 'a.md', text: 'hi' },
    ]);
    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
    expect(mockOrchestrator.createScoopTab).not.toHaveBeenCalled();

    // Should still buffer the local user message for echo dedup
    const buf = (bridge as any).getBuffer('cone_1');
    expect(buf).toHaveLength(1);
    expect(buf[0].id).toBe('msg-f1');
  });

  it('user-message falls through to orchestrator when follower mode inactive', async () => {
    simulatePanelMessage({
      type: 'user-message',
      scoopJid: 'cone_1',
      text: 'local',
      messageId: 'msg-l1',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.handleMessage).toHaveBeenCalled();
    expect(mockSync.sendMessage).not.toHaveBeenCalled();
  });

  it('applyFollowerSnapshot replaces cone buffer, persists, emits scoop-messages-replaced', () => {
    // Pre-populate with stale local content to verify replacement.
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'old', role: 'user', content: 'stale', timestamp: 1 });

    bridge.applyFollowerSnapshot([
      { id: 'a', role: 'user', content: 'hi', timestamp: 100 },
      {
        id: 'b',
        role: 'assistant',
        content: 'reply',
        timestamp: 200,
        toolCalls: [{ id: 't1', name: 'bash', input: { cmd: 'ls' }, result: 'a\nb' }],
      },
    ] as any);

    const after = (bridge as any).getBuffer('cone_1');
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe('a');
    expect(after[1].toolCalls?.[0]?.name).toBe('bash');

    expect(mockStore.saveMessages).toHaveBeenCalledWith('session-cone', expect.any(Array));

    const replaced = sentMessages.find(
      (m: any) => m.payload?.type === 'scoop-messages-replaced'
    ) as any;
    expect(replaced).toBeDefined();
    expect(replaced.payload.scoopJid).toBe('cone_1');
    expect(replaced.payload.messages).toHaveLength(2);
  });

  it('applyFollowerSnapshot is a noop when no orchestrator or no cone', () => {
    (bridge as any).orchestrator = null;
    bridge.applyFollowerSnapshot([{ id: 'a', role: 'user', content: 'hi', timestamp: 100 }] as any);
    expect(sentMessages).toHaveLength(0);

    (bridge as any).orchestrator = { getScoops: () => [] };
    bridge.applyFollowerSnapshot([{ id: 'a', role: 'user', content: 'hi', timestamp: 100 }] as any);
    expect(sentMessages).toHaveLength(0);
  });

  it('getConeJid returns the cone jid or null', () => {
    expect(bridge.getConeJid()).toBe('cone_1');
    (bridge as any).orchestrator = { getScoops: () => [] };
    expect(bridge.getConeJid()).toBeNull();
    (bridge as any).orchestrator = null;
    expect(bridge.getConeJid()).toBeNull();
  });

  it('emitFollowerAgentEvent maps each AgentEvent type to the matching agent-event payload', () => {
    bridge.emitFollowerAgentEvent({
      type: 'content_delta',
      messageId: 'm1',
      text: 'partial',
    } as any);
    bridge.emitFollowerAgentEvent({ type: 'content_done', messageId: 'm1' } as any);
    bridge.emitFollowerAgentEvent({
      type: 'tool_use_start',
      messageId: 'm1',
      toolName: 'bash',
      toolInput: { cmd: 'ls' },
    } as any);
    bridge.emitFollowerAgentEvent({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'ok',
      isError: false,
    } as any);
    bridge.emitFollowerAgentEvent({ type: 'turn_end', messageId: 'm1' } as any);
    bridge.emitFollowerAgentEvent({ type: 'error', error: 'boom' } as any);

    const types = sentMessages.map((m: any) => ({
      type: m.payload?.type,
      eventType: m.payload?.eventType,
      error: m.payload?.error,
    }));
    expect(types).toEqual([
      { type: 'agent-event', eventType: 'text_delta', error: undefined },
      { type: 'agent-event', eventType: 'response_done', error: undefined },
      { type: 'agent-event', eventType: 'tool_start', error: undefined },
      { type: 'agent-event', eventType: 'tool_end', error: undefined },
      { type: 'agent-event', eventType: 'turn_end', error: undefined },
      { type: 'error', eventType: undefined, error: 'boom' },
    ]);
  });

  it('emitFollowerAgentEvent is a noop without a cone', () => {
    (bridge as any).orchestrator = { getScoops: () => [] };
    bridge.emitFollowerAgentEvent({
      type: 'content_delta',
      messageId: 'm1',
      text: 'x',
    } as any);
    expect(sentMessages).toHaveLength(0);
  });

  it('emitFollowerStatus emits scoop-status processing/ready for cone', () => {
    bridge.emitFollowerStatus('processing');
    bridge.emitFollowerStatus('idle');

    const statusMsgs = sentMessages
      .filter((m: any) => m.payload?.type === 'scoop-status')
      .map((m: any) => m.payload);
    expect(statusMsgs).toEqual([
      { type: 'scoop-status', scoopJid: 'cone_1', status: 'processing' },
      { type: 'scoop-status', scoopJid: 'cone_1', status: 'ready' },
    ]);
  });

  it('emitFollowerIncomingMessage emits incoming-message for cone', () => {
    bridge.emitFollowerIncomingMessage('echo-1', 'leader-side text');
    const m = sentMessages.find((x: any) => x.payload?.type === 'incoming-message') as any;
    expect(m.payload).toMatchObject({
      type: 'incoming-message',
      scoopJid: 'cone_1',
      message: {
        id: 'echo-1',
        content: 'leader-side text',
        channel: 'web',
        senderName: 'User',
        fromAssistant: false,
      },
    });
    expect(typeof m.payload.message.timestamp).toBe('string');
  });
});
