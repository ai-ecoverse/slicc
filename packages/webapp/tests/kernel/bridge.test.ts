/**
 * Tests for Bridge — Orchestrator ↔ chrome.runtime message bridge.
 *
 * Verifies:
 * - createCallbacks() - text accumulation, tool tracking, message source attribution
 * - buildStateSnapshot() - scoop mapping, cone identification
 * - persistScoop() - correct session ID mapping, fire-and-forget error handling
 * - getBuffer/getOrCreateAssistantMsg - buffer isolation, source attribution
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSCRIPT_TOOL_TEXT_CHARS } from '../../src/scoops/transcript-limits.js';
import type { ChannelMessage } from '../../src/scoops/types.js';

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

vi.mock('../../src/ui/session-store.js', () => ({
  SessionStore: mockSessionStore,
}));

vi.mock('../../src/tools/tool-ui.js', () => ({
  TOOL_UI_MOUNTED_ACTION: '__mounted',
  toolUIRegistry: {
    handleAction: mockHandleAction,
    markMounted: vi.fn(),
    cancel: vi.fn(),
  },
}));

const { Bridge } = await import('../../src/kernel/facade.js');
const { SessionStore } = await import('../../src/ui/session-store.js');

describe('Bridge createCallbacks', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;
  let callbacks: any;

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new Bridge();

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

    callbacks = Bridge.createCallbacks(bridge);
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

describe('Bridge buildStateSnapshot', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new Bridge();

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

  it('falls back to cone jid when no leader-active-scoop has been pushed', () => {
    // No setActiveScoopJid call — exercises the cone-as-default fallback
    // path the JSDoc on `activeScoopJid` documents.
    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.activeScoopJid).toBe('cone_1');
  });

  it('returns the leader-pushed active scoop when one has been set', () => {
    // Simulates the panel's PanelLeaderSyncProxy pushing a sub-scoop
    // selection via `leader-active-scoop`. Survives panel reload because
    // the snapshot consults the cached value before defaulting to cone.
    bridge.setActiveScoopJid('scoop_test');
    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.activeScoopJid).toBe('scoop_test');
  });

  it('falls back to cone when active scoop is explicitly cleared to null', () => {
    bridge.setActiveScoopJid('scoop_test');
    bridge.setActiveScoopJid(null);
    const snapshot = bridge.buildStateSnapshot();
    expect(snapshot.activeScoopJid).toBe('cone_1');
  });

  it('sets activeScoopJid to null when no cone and no active scoop is set', () => {
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

describe('Bridge getBuffer/getOrCreateAssistantMsg', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new Bridge();

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

describe('Bridge persistScoop', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;
  let mockStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new Bridge();

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

describe('Bridge onScoopUnregistered eviction', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockStore: any;
  let callbacks: any;

  const unregisteredScoop = {
    jid: 'agent_probe_1',
    name: 'probe',
    folder: 'agent-probe',
    isCone: false,
    type: 'scoop',
    requiresTrigger: false,
    assistantLabel: 'agent-probe',
    addedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sentMessages.length = 0;
    bridge = new Bridge();
    mockStore = new SessionStore();
    (bridge as any).orchestrator = { getScoops: vi.fn(() => []) };
    (bridge as any).sessionStore = mockStore;
    callbacks = Bridge.createCallbacks(bridge);
  });

  it('evicts the chat buffer and per-scoop maps when a scoop is unregistered', () => {
    // Simulate agent activity that fills the buffer (the leak driver:
    // tool results buffered at full size, never evicted on programmatic
    // unregister — only the panel's scoop-drop path cleaned up).
    callbacks.onResponse('agent_probe_1', 'streamed text', true);
    callbacks.onToolStart?.('agent_probe_1', 'bash', { command: 'cat big.txt' });
    callbacks.onToolEnd?.('agent_probe_1', 'bash', 'z'.repeat(4096), false);
    callbacks.onStatusChange('agent_probe_1', 'processing');

    expect((bridge as any).messageBuffers.has('agent_probe_1')).toBe(true);
    expect((bridge as any).currentMessageId.has('agent_probe_1')).toBe(true);
    expect((bridge as any).scoopStatuses.has('agent_probe_1')).toBe(true);

    callbacks.onScoopUnregistered?.(unregisteredScoop);

    expect((bridge as any).messageBuffers.has('agent_probe_1')).toBe(false);
    expect((bridge as any).currentMessageId.has('agent_probe_1')).toBe(false);
    expect((bridge as any).fanOutMessageId.has('agent_probe_1')).toBe(false);
    expect((bridge as any).scoopStatuses.has('agent_probe_1')).toBe(false);
  });

  it('deletes the persisted UI session for the unregistered scoop', () => {
    callbacks.onResponse('agent_probe_1', 'text', true);

    callbacks.onScoopUnregistered?.(unregisteredScoop);

    expect(mockStore.delete).toHaveBeenCalledWith('session-agent-probe');
  });

  it('refreshes the panel scoop list after eviction', () => {
    const emitSpy = vi.spyOn(bridge as any, 'emitScoopList');

    callbacks.onScoopUnregistered?.(unregisteredScoop);

    expect(emitSpy).toHaveBeenCalled();
  });

  it('survives a missing sessionStore', () => {
    (bridge as any).sessionStore = null;
    callbacks.onResponse('agent_probe_1', 'text', true);

    expect(() => callbacks.onScoopUnregistered?.(unregisteredScoop)).not.toThrow();
    expect((bridge as any).messageBuffers.has('agent_probe_1')).toBe(false);
  });
});

describe('Bridge transcript size caps', () => {
  let bridge: InstanceType<typeof Bridge>;
  let callbacks: any;
  let emitted: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new Bridge();
    (bridge as any).orchestrator = { getScoops: vi.fn(() => []) };
    emitted = [];
    vi.spyOn(bridge as any, 'emit').mockImplementation((payload: any) => {
      emitted.push(payload);
    });
    callbacks = Bridge.createCallbacks(bridge);
  });

  it('caps oversized tool results in the buffer AND the emitted agent-event', () => {
    const huge = 'z'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 100_000);
    callbacks.onResponse('cone_1', 'turn text', true);
    callbacks.onToolStart?.('cone_1', 'bash', { command: 'cat big.txt' });

    callbacks.onToolEnd?.('cone_1', 'bash', huge, false);

    const buf = (bridge as any).messageBuffers.get('cone_1');
    const tc = buf.find((m: any) => m.toolCalls?.length)?.toolCalls[0];
    expect(tc.result.length).toBeLessThan(huge.length);
    expect(tc.result).toContain('truncated for the chat transcript');

    const toolEnd = emitted.find((e) => e.eventType === 'tool_end');
    expect(toolEnd.toolResult.length).toBeLessThan(huge.length);
  });

  it('caps oversized string fields in tool inputs (write_file content)', () => {
    const hugeContent = 'w'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 100_000);
    callbacks.onResponse('cone_1', 'turn text', true);

    callbacks.onToolStart?.('cone_1', 'write_file', {
      path: '/big.txt',
      content: hugeContent,
    });

    const buf = (bridge as any).messageBuffers.get('cone_1');
    const tc = buf.find((m: any) => m.toolCalls?.length)?.toolCalls[0];
    expect(tc.input.content.length).toBeLessThan(hugeContent.length);
    expect(tc.input.path).toBe('/big.txt');

    const toolStart = emitted.find((e) => e.eventType === 'tool_start');
    expect(toolStart.toolInput.content.length).toBeLessThan(hugeContent.length);
  });

  it('leaves normal-sized results and inputs untouched', () => {
    callbacks.onResponse('cone_1', 'turn text', true);
    callbacks.onToolStart?.('cone_1', 'bash', { command: 'ls' });
    callbacks.onToolEnd?.('cone_1', 'bash', 'file-a\nfile-b\n', false);

    const buf = (bridge as any).messageBuffers.get('cone_1');
    const tc = buf.find((m: any) => m.toolCalls?.length)?.toolCalls[0];
    expect(tc.input).toEqual({ command: 'ls' });
    expect(tc.result).toBe('file-a\nfile-b\n');
  });
});

describe('Bridge handlePanelMessage', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new Bridge();
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
      handleWebhookEvent: vi.fn(),
      handleCherryHostEvent: vi.fn(),
    };

    await bridge.bind(mockOrchestrator);
  });

  function simulatePanelMessage(payload: unknown): void {
    for (const listener of messageListeners) {
      listener({ source: 'panel', payload }, {}, () => {});
    }
  }

  it('answers request-session-stats with the total cost and per-scoop fills', async () => {
    mockOrchestrator.getSessionCosts = vi.fn(() => [
      { usage: { cost: { total: 0.2 } } },
      { usage: { cost: { total: 0.03 } } },
    ]);
    mockOrchestrator.getContextFills = vi.fn(() => [{ jid: 'cone_1', fill: 0.4 }]);

    simulatePanelMessage({ type: 'request-session-stats', requestId: 'st-1' });
    await new Promise((r) => setTimeout(r, 10));

    const reply = sentMessages.find(
      (m: any) => m?.payload?.type === 'session-stats' && m.payload.requestId === 'st-1'
    ) as any;
    expect(reply).toBeTruthy();
    expect(reply.payload.totalCost).toBeCloseTo(0.23);
    expect(reply.payload.fills).toEqual([{ jid: 'cone_1', fill: 0.4 }]);
  });

  it('answers request-session-stats with zeros when the cost provider throws', async () => {
    mockOrchestrator.getSessionCosts = vi.fn(() => {
      throw new Error('not ready');
    });

    simulatePanelMessage({ type: 'request-session-stats', requestId: 'st-2' });
    await new Promise((r) => setTimeout(r, 10));

    const reply = sentMessages.find(
      (m: any) => m?.payload?.type === 'session-stats' && m.payload.requestId === 'st-2'
    ) as any;
    expect(reply).toBeTruthy();
    expect(reply.payload.totalCost).toBe(0);
    expect(reply.payload.fills).toEqual([]);
  });

  it('dispatches cone-create through the extracted handler', async () => {
    simulatePanelMessage({ type: 'cone-create', name: 'sliccy' });
    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.registerScoop).toHaveBeenCalledWith(
      expect.objectContaining({ isCone: true, name: 'sliccy', folder: 'cone' })
    );
    const created = sentMessages.find((m: any) => m?.payload?.type === 'scoop-created') as any;
    expect(created?.payload?.scoop?.name).toBe('sliccy');
  });

  it('dispatches lick-cherry-host-event to orchestrator.handleCherryHostEvent', async () => {
    simulatePanelMessage({
      type: 'lick-cherry-host-event',
      cherryRuntimeId: 'follower-b1',
      name: 'cart.updated',
      detail: { items: 3 },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.handleCherryHostEvent).toHaveBeenCalledWith(
      'follower-b1',
      'cart.updated',
      {
        items: 3,
      }
    );
  });

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

  it('dispatches clear-chat: clears only the cone session and emits an ack', async () => {
    sentMessages.length = 0;
    simulatePanelMessage({ type: 'clear-chat', requestId: 'req-123' });

    await new Promise((r) => setTimeout(r, 10));

    // Cone-only: scoops keep their sessions; clearScoopMessages does the
    // per-scoop wipe (including the channel-history rows in the agent DB).
    expect(mockOrchestrator.clearScoopMessages).toHaveBeenCalledWith('cone_1');
    expect(mockOrchestrator.clearAllMessages).not.toHaveBeenCalled();
    const store = (bridge as any).sessionStore;
    expect(store.delete).toHaveBeenCalledWith('session-cone');
    expect(store.delete).not.toHaveBeenCalledWith('session-test-scoop');

    // Ack must carry the same requestId so the panel can match it.
    const ack = sentMessages.find((m: any) => m?.payload?.type === 'clear-chat-ack') as
      | { payload: { type: string; requestId: string } }
      | undefined;
    expect(ack?.payload.requestId).toBe('req-123');
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

describe('Bridge follower mode', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;
  let mockSync: any;
  let mockStore: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new Bridge();
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

  it('sprinkle-lick (e.g. chat dip) in follower mode forwards to leader, skips local cone', async () => {
    mockSync.sendSprinkleLick = vi.fn();
    bridge.setFollowerActive(true);
    bridge.setFollowerSync(mockSync);

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'accept', data: { v: 1 } },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockSync.sendSprinkleLick).toHaveBeenCalledWith(
      'inline',
      { action: 'accept', data: { v: 1 } },
      undefined
    );
    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it('sprinkle-lick in follower mode forwards targetScoop verbatim (third positional arg)', async () => {
    mockSync.sendSprinkleLick = vi.fn();
    bridge.setFollowerActive(true);
    bridge.setFollowerSync(mockSync);

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'welcome',
      body: { action: 'click' },
      targetScoop: 'helper-scoop',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockSync.sendSprinkleLick).toHaveBeenCalledWith(
      'welcome',
      { action: 'click' },
      'helper-scoop'
    );
  });

  it('sprinkle-lick mid-reconnect (followerActive but no sync) drops without falling through to local cone', async () => {
    mockSync.sendSprinkleLick = vi.fn();
    // Simulate the transient WebRTC reconnect window: bridge knows it's a
    // follower, but `setFollowerSync(null)` was called by `detachSync`.
    bridge.setFollowerActive(true);
    bridge.setFollowerSync(null);

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'accept' },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Critically: must NOT fall through to the local cone (that would
    // regress the bug `sprinkle-lick forwards to leader, skips local cone`
    // exists to prevent).
    expect(mockSync.sendSprinkleLick).not.toHaveBeenCalled();
    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it('sprinkle-lick falls through to routeSprinkleLick when follower mode inactive', async () => {
    mockSync.sendSprinkleLick = vi.fn();

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'accept' },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockSync.sendSprinkleLick).not.toHaveBeenCalled();
    // routeSprinkleLick → orchestrator.handleMessage on the cone
    expect(mockOrchestrator.handleMessage).toHaveBeenCalled();
  });

  it('sprinkle-lick carrying a handoff lickId flips the card and still routes to the cone', async () => {
    mockOrchestrator.resolveNavigateHandoffByHuman = vi.fn().mockResolvedValue(true);

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'accept', data: { lickId: 'lick-nav-9' } },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.resolveNavigateHandoffByHuman).toHaveBeenCalledWith('lick-nav-9', true);
    // Non-consuming: the dip lick still routes to the cone so it can act on accept.
    expect(mockOrchestrator.handleMessage).toHaveBeenCalled();
  });

  it('sprinkle-lick dismiss with a handoff lickId resolves accepted=false', async () => {
    mockOrchestrator.resolveNavigateHandoffByHuman = vi.fn().mockResolvedValue(true);

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'dismiss', data: { lickId: 'lick-nav-10' } },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.resolveNavigateHandoffByHuman).toHaveBeenCalledWith(
      'lick-nav-10',
      false
    );
  });

  it('sprinkle-lick without a lickId does not invoke the handoff card flip', async () => {
    mockOrchestrator.resolveNavigateHandoffByHuman = vi.fn();

    simulatePanelMessage({
      type: 'sprinkle-lick',
      sprinkleName: 'inline',
      body: { action: 'accept' },
      targetScoop: undefined,
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(mockOrchestrator.resolveNavigateHandoffByHuman).not.toHaveBeenCalled();
    expect(mockOrchestrator.handleMessage).toHaveBeenCalled();
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

describe('Bridge active-scoop tracking', () => {
  it('defaults to null before any panel signal', () => {
    const bridge = new Bridge();
    expect(bridge.getActiveScoopJid()).toBeNull();
  });

  it('setActiveScoopJid updates the cached value', () => {
    const bridge = new Bridge();
    bridge.setActiveScoopJid('scoop-1');
    expect(bridge.getActiveScoopJid()).toBe('scoop-1');
  });

  it('null clears the cache', () => {
    const bridge = new Bridge();
    bridge.setActiveScoopJid('scoop-1');
    bridge.setActiveScoopJid(null);
    expect(bridge.getActiveScoopJid()).toBeNull();
  });
});

describe('Bridge.getMessagesForJid', () => {
  it('returns the buffered messages cast to ChatMessage[]', () => {
    const bridge = new Bridge();
    // Seed via the @internal getBuffer (test only).
    const buf = (bridge as any).getBuffer('scoop-1') as Array<any>;
    buf.push({ id: 'm1', role: 'user', content: 'hi', timestamp: 1 });
    const msgs = bridge.getMessagesForJid('scoop-1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('m1');
  });

  it('returns an empty array for an unknown jid', () => {
    const bridge = new Bridge();
    expect(bridge.getMessagesForJid('nope')).toEqual([]);
  });
});

describe('Bridge.routeSprinkleLick', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();

    bridge = new Bridge();
    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone-1', name: 'cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop-2',
          name: 'helper',
          folder: 'helper',
          isCone: false,
          assistantLabel: 'helper',
        },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      createScoopTab: vi.fn().mockResolvedValue(undefined),
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

  it('handles a sprinkle lick targeted at a specific scoop', async () => {
    await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'helper');
    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'scoop-2',
        channel: 'sprinkle',
        senderName: 'sprinkle:welcome',
        senderId: 'sprinkle',
        fromAssistant: false,
      })
    );
    // Buffer should have received a corresponding lick entry.
    const buf = (bridge as any).getBuffer('scoop-2') as Array<any>;
    expect(buf).toHaveLength(1);
    expect(buf[0].source).toBe('lick');
    expect(buf[0].channel).toBe('sprinkle');
  });

  it('falls back to the cone when no targetScoop is given', async () => {
    await bridge.routeSprinkleLick('welcome', { action: 'go' });
    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'cone-1', channel: 'sprinkle' })
    );
  });

  it('falls back to the cone when targetScoop does not match any scoop', async () => {
    await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'unknown');
    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'cone-1' })
    );
  });

  it('matches targetScoop by folder with a "-scoop" suffix', async () => {
    mockOrchestrator.getScoops = vi.fn(() => [
      { jid: 'cone-1', name: 'cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
      {
        jid: 'scoop-3',
        name: 'Helper',
        folder: 'helper-scoop',
        isCone: false,
        assistantLabel: 'helper-scoop',
      },
    ]);
    await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'helper');
    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'scoop-3' })
    );
  });

  it('is a no-op when no orchestrator is bound', async () => {
    const unboundBridge = new Bridge();
    await unboundBridge.routeSprinkleLick('welcome', { action: 'go' });
    // Nothing throws; mock orchestrator on the bound bridge is unaffected.
    expect(mockOrchestrator.handleMessage).not.toHaveBeenCalled();
  });

  it('includes the forwarded origin label in the lick content', async () => {
    await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'helper', 'iOS follower');
    expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Forwarded from iOS follower'),
      })
    );
  });
});

describe('Bridge.onAgentEvent tap', () => {
  function captureEvents(bridge: InstanceType<typeof Bridge>) {
    const events: Array<{ scoopJid: string; event: any }> = [];
    const off = bridge.onAgentEvent((scoopJid: string, event: any) =>
      events.push({ scoopJid, event })
    );
    return { events, off };
  }

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
  });

  it('text_delta with no current messageId emits message_start + content_delta', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    const { events } = captureEvents(bridge);
    callbacks.onResponse?.('scoop-1', 'hello', true);
    expect(events.map((e) => e.event.type)).toEqual(['message_start', 'content_delta']);
    expect(events[1].event.text).toBe('hello');
    expect(events.every((e) => e.scoopJid === 'scoop-1')).toBe(true);
  });

  it('subsequent text_delta with same messageId emits only content_delta', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    callbacks.onResponse?.('scoop-1', 'hello', true);
    const { events } = captureEvents(bridge);
    callbacks.onResponse?.('scoop-1', ' world', true);
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('content_delta');
    expect(events[0].event.text).toBe(' world');
  });

  it('onResponseDone emits content_done', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    callbacks.onResponse?.('scoop-1', 'hello', true);
    const { events } = captureEvents(bridge);
    callbacks.onResponseDone?.('scoop-1');
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe('content_done');
  });

  it('onToolStart conditional message_start + tool_use_start', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    const { events } = captureEvents(bridge);
    callbacks.onToolStart?.('scoop-1', 'bash', { command: 'ls' });
    expect(events.map((e) => e.event.type)).toEqual(['message_start', 'tool_use_start']);
    expect(events[1].event.toolName).toBe('bash');
  });

  it('onToolEnd emits tool_result only when messageId exists', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    callbacks.onToolStart?.('scoop-1', 'bash', {});
    const { events } = captureEvents(bridge);
    callbacks.onToolEnd?.('scoop-1', 'bash', 'output', false);
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ type: 'tool_result', toolName: 'bash' });
  });

  it('unsubscribe stops further events', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    const { events, off } = captureEvents(bridge);
    off();
    callbacks.onResponse?.('scoop-1', 'hello', true);
    expect(events).toEqual([]);
  });

  it('turn_end clears the fan-out messageId gating state', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    // Prime the fan-out gating state with a text_delta envelope.
    callbacks.onResponse?.('scoop-1', 'hello', true);
    // Subscribe AFTER the priming so the captured events array only
    // sees what happens after the turn_end + next text_delta.
    const { events } = captureEvents(bridge);
    // Simulate the bridge receiving a turn_end envelope. createCallbacks
    // doesn't emit turn_end (only response_done), so drive it via
    // bridge.emit directly — same pattern as the wire would deliver it.
    (bridge as any).emit({
      type: 'agent-event',
      scoopJid: 'scoop-1',
      eventType: 'turn_end',
    });
    // No event should be emitted to listeners (turn_end synthesis is deferred).
    expect(events).toEqual([]);
    // But the state should be cleared — next text_delta should re-emit
    // message_start before content_delta.
    callbacks.onResponse?.('scoop-1', 'next', true);
    expect(events.map((e) => e.event.type)).toEqual(['message_start', 'content_delta']);
  });
});

describe('Bridge.notifyPanelIncomingMessage', () => {
  it('emits an incoming-message envelope with the canonical wire shape', () => {
    const bridge = new Bridge();
    const msg: ChannelMessage = {
      id: 'm-99',
      chatJid: 'scoop-1',
      senderId: 'user',
      senderName: 'User',
      content: 'hello from follower',
      timestamp: '2026-05-20T00:00:00.000Z',
      fromAssistant: false,
      channel: 'web',
    };
    sentMessages.length = 0;
    bridge.notifyPanelIncomingMessage('scoop-1', msg);
    const sent = sentMessages.find((m: any) => m?.payload?.type === 'incoming-message') as any;
    expect(sent).toBeDefined();
    expect(sent.payload.scoopJid).toBe('scoop-1');
    expect(sent.payload.message).toMatchObject({
      id: 'm-99',
      content: 'hello from follower',
      channel: 'web',
      fromAssistant: false,
    });
  });

  it('existing onIncomingMessage callback still emits via the same helper', () => {
    // Characterization test: the refactored onIncomingMessage callback
    // (which only fires for external lick channels) must produce the
    // same wire envelope as before the refactor.
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    sentMessages.length = 0;
    callbacks.onIncomingMessage?.('cone-1', {
      id: 'wh-1',
      chatJid: 'cone-1',
      senderId: 'webhook',
      senderName: 'webhook:test',
      content: '[Webhook test]',
      timestamp: '2026-05-20T00:00:00.000Z',
      fromAssistant: false,
      channel: 'webhook',
    });
    const sent = sentMessages.find((m: any) => m?.payload?.type === 'incoming-message') as any;
    expect(sent.payload.message.channel).toBe('webhook');
  });

  it('carries lickId/lickState onto the incoming-message envelope', () => {
    const bridge = new Bridge();
    const msg: ChannelMessage = {
      id: 'sudo-request-lick-1',
      chatJid: 'cone-1',
      senderId: 'test-scoop',
      senderName: 'test-scoop',
      content: '[@test-scoop sudo-request]\nKind: command\nDetail: git push',
      timestamp: '2026-05-20T00:00:00.000Z',
      fromAssistant: false,
      channel: 'sudo-request',
      lickId: 'lick-1',
      lickState: 'pending',
    };
    sentMessages.length = 0;
    bridge.notifyPanelIncomingMessage('cone-1', msg);
    const sent = sentMessages.find((m: any) => m?.payload?.type === 'incoming-message') as any;
    expect(sent.payload.message).toMatchObject({ lickId: 'lick-1', lickState: 'pending' });
  });
});

describe('Bridge applyMessageUpdate (live lick flip)', () => {
  it('flips the buffered lick state and emits message-updated', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    // Seed a pending actionable lick into the cone's buffer.
    callbacks.onIncomingMessage?.('cone-1', {
      id: 'sudo-request-lick-1',
      chatJid: 'cone-1',
      senderId: 'test-scoop',
      senderName: 'test-scoop',
      content: '[@test-scoop sudo-request]\nKind: command\nDetail: git push',
      timestamp: '2026-05-20T00:00:00.000Z',
      fromAssistant: false,
      channel: 'sudo-request',
      lickId: 'lick-1',
      lickState: 'pending',
    });
    sentMessages.length = 0;

    callbacks.onMessageUpdate?.('cone-1', {
      messageId: 'sudo-request-lick-1',
      lickId: 'lick-1',
      lickState: 'confirmed',
    });

    const buf = (bridge as any).getBuffer('cone-1');
    const entry = buf.find((m: any) => m.lickId === 'lick-1');
    expect(entry?.lickState).toBe('confirmed');

    const emitted = sentMessages.find((m: any) => m?.payload?.type === 'message-updated') as any;
    expect(emitted).toBeDefined();
    expect(emitted.payload).toMatchObject({
      type: 'message-updated',
      scoopJid: 'cone-1',
      messageId: 'sudo-request-lick-1',
      lickId: 'lick-1',
      lickState: 'confirmed',
    });
  });

  it('still emits message-updated when no buffered row matches', () => {
    const bridge = new Bridge();
    const callbacks = Bridge.createCallbacks(bridge);
    sentMessages.length = 0;
    callbacks.onMessageUpdate?.('cone-1', {
      messageId: 'sudo-request-missing',
      lickId: 'missing',
      lickState: 'dismissed',
    });
    const emitted = sentMessages.find((m: any) => m?.payload?.type === 'message-updated') as any;
    expect(emitted?.payload.lickState).toBe('dismissed');
  });
});

describe('Bridge follower-forwarding bridge', () => {
  let bridge: InstanceType<typeof Bridge>;
  let setForwarder: ReturnType<typeof vi.fn>;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    setForwarder = vi.fn();
    emitEvent = vi.fn();
    (globalThis as any).__slicc_lickManager = { setForwarder, emitEvent };
    bridge = new Bridge();
    await bridge.bind({
      getScoops: vi.fn(() => []),
      handleMessage: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('set-follower-forwarding(true) installs a forwarder that emits forward-lick to the page', async () => {
    const emitSpy = vi.spyOn(bridge as any, 'emit');
    await (bridge as any).handlePanelMessage({ type: 'set-follower-forwarding', enabled: true });
    expect(setForwarder).toHaveBeenCalledTimes(1);
    const fwd = setForwarder.mock.calls[0][0] as (e: unknown) => void;
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    fwd(event);
    expect(emitSpy).toHaveBeenCalledWith({ type: 'forward-lick', event });
  });

  it('set-follower-forwarding(false) clears the forwarder', async () => {
    await (bridge as any).handlePanelMessage({ type: 'set-follower-forwarding', enabled: false });
    expect(setForwarder).toHaveBeenCalledWith(null);
  });

  it('inject-forwarded-lick emits the event into the worker LickManager', async () => {
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    await (bridge as any).handlePanelMessage({ type: 'inject-forwarded-lick', event });
    expect(emitEvent).toHaveBeenCalledWith(event);
  });

  it('inject-forwarded-lick is a no-op (no throw) when the worker LickManager is absent', async () => {
    delete (globalThis as any).__slicc_lickManager;
    await expect(
      (bridge as any).handlePanelMessage({
        type: 'inject-forwarded-lick',
        event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} },
      })
    ).resolves.toBeUndefined();
  });

  it('set-follower-forwarding is a no-op (no throw) when the worker LickManager is absent', async () => {
    delete (globalThis as any).__slicc_lickManager;
    await expect(
      (bridge as any).handlePanelMessage({ type: 'set-follower-forwarding', enabled: true })
    ).resolves.toBeUndefined();
  });
});

describe('Bridge request-scoop-transcript', () => {
  let bridge: InstanceType<typeof Bridge>;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    bridge = new Bridge();
    await bridge.bind({
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      getScoopContext: vi.fn(() => undefined),
    } as any);
  });

  it('flattens buffered messages and replies with correlated requestId', async () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push(
      { id: 'u1', role: 'user', content: 'help me refactor auth', timestamp: 100 },
      { id: 'a1', role: 'assistant', content: 'starting now', timestamp: 200 },
      { id: 'a2', role: 'assistant', content: '   ', timestamp: 300 } // empty after trim — skip
    );

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-transcript',
      requestId: 'tr-test-1',
      scoopJid: 'cone_1',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-transcript') as any;
    expect(reply).toBeDefined();
    expect(reply.payload.requestId).toBe('tr-test-1');
    expect(reply.payload.scoopJid).toBe('cone_1');
    expect(reply.payload.transcript).toBe('user: help me refactor auth\nassistant: starting now');
  });

  it('returns empty transcript for an unknown scoop', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-transcript',
      requestId: 'tr-test-2',
      scoopJid: 'does-not-exist',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-transcript') as any;
    expect(reply).toBeDefined();
    expect(reply.payload.requestId).toBe('tr-test-2');
    expect(reply.payload.transcript).toBe('');
  });

  it('does NOT emit scoop-messages-replaced (side-effect-free vs request-scoop-messages)', async () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'u1', role: 'user', content: 'hi', timestamp: 100 });

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-transcript',
      requestId: 'tr-test-3',
      scoopJid: 'cone_1',
    });

    const replacedReply = sentMessages.find(
      (m: any) => m.payload?.type === 'scoop-messages-replaced'
    );
    expect(replacedReply).toBeUndefined();
  });
});

describe('Bridge request-scoop-chat-messages', () => {
  let bridge: InstanceType<typeof Bridge>;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    bridge = new Bridge();
    await bridge.bind({
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      getScoopContext: vi.fn(() => undefined),
    } as any);
  });

  it('returns buffered messages with correlated requestId', async () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push(
      { id: 'u1', role: 'user', content: 'hello', timestamp: 100 },
      { id: 'a1', role: 'assistant', content: 'hi there', timestamp: 200 }
    );

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-chat-messages',
      requestId: 'cm-test-1',
      scoopJid: 'cone_1',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-chat-messages') as any;
    expect(reply).toBeDefined();
    expect(reply.payload.requestId).toBe('cm-test-1');
    expect(reply.payload.scoopJid).toBe('cone_1');
    expect(reply.payload.messages).toHaveLength(2);
    expect(reply.payload.messages[0].content).toBe('hello');
    expect(reply.payload.messages[1].content).toBe('hi there');
  });

  it('returns empty messages array for an unknown scoop', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-chat-messages',
      requestId: 'cm-test-2',
      scoopJid: 'does-not-exist',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-chat-messages') as any;
    expect(reply).toBeDefined();
    expect(reply.payload.requestId).toBe('cm-test-2');
    expect(reply.payload.messages).toEqual([]);
  });

  it('does NOT emit scoop-messages-replaced (side-effect-free)', async () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'u1', role: 'user', content: 'hi', timestamp: 100 });

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-chat-messages',
      requestId: 'cm-test-3',
      scoopJid: 'cone_1',
    });

    const replacedReply = sentMessages.find(
      (m: any) => m.payload?.type === 'scoop-messages-replaced'
    );
    expect(replacedReply).toBeUndefined();
  });

  it('falls back to sessionStore when no buffer or agent messages exist', async () => {
    (bridge as any).sessionStore = {
      load: vi.fn().mockResolvedValue({
        messages: [{ id: 's1', role: 'user', content: 'from store', timestamp: 50 }],
      }),
    };

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-chat-messages',
      requestId: 'cm-test-4',
      scoopJid: 'cone_1',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-chat-messages') as any;
    expect(reply.payload.requestId).toBe('cm-test-4');
    expect(reply.payload.messages).toHaveLength(1);
    expect(reply.payload.messages[0].content).toBe('from store');
  });

  it('returns empty when sessionStore throws', async () => {
    (bridge as any).sessionStore = {
      load: vi.fn().mockRejectedValue(new Error('idb closed')),
    };

    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-chat-messages',
      requestId: 'cm-test-5',
      scoopJid: 'cone_1',
    });

    const reply = sentMessages.find((m: any) => m.payload?.type === 'scoop-chat-messages') as any;
    expect(reply.payload.requestId).toBe('cm-test-5');
    expect(reply.payload.messages).toEqual([]);
  });
});

describe('Bridge handlePanelMessage dispatch', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    bridge = new Bridge();
    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
        {
          jid: 'scoop_a',
          name: 'A',
          folder: 'a-scoop',
          isCone: false,
          assistantLabel: 'a-scoop',
        },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      registerScoop: vi.fn().mockResolvedValue(undefined),
      unregisterScoop: vi.fn().mockResolvedValue(undefined),
      delegateToScoop: vi.fn().mockResolvedValue(undefined),
      updateModel: vi.fn(),
      setScoopThinkingLevel: vi.fn().mockResolvedValue(undefined),
      resetFilesystem: vi.fn().mockResolvedValue(undefined),
      reloadAllSkills: vi.fn().mockResolvedValue(undefined),
      handleWebhookEvent: vi.fn(),
      stopScoop: vi.fn(),
      clearQueuedMessages: vi.fn().mockResolvedValue(undefined),
      deleteQueuedMessage: vi.fn().mockResolvedValue(undefined),
      clearScoopMessages: vi.fn().mockResolvedValue(undefined),
      getScoopContext: vi.fn(() => undefined),
      createScoopTab: vi.fn(),
    };
    await bridge.bind(mockOrchestrator);
  });

  it('cone-create registers a new cone scoop and emits scoop-created', async () => {
    await (bridge as any).handlePanelMessage({ type: 'cone-create', name: 'NewCone' });
    expect(mockOrchestrator.registerScoop).toHaveBeenCalledTimes(1);
    const registered = mockOrchestrator.registerScoop.mock.calls[0][0];
    expect(registered.isCone).toBe(true);
    expect(registered.name).toBe('NewCone');
    expect(registered.folder).toBe('cone');
    expect(registered.assistantLabel).toBe('sliccy');
    const event = sentMessages.find((m: any) => m.payload?.type === 'scoop-created') as
      | { payload: { scoop: { isCone: boolean; name: string } } }
      | undefined;
    expect(event?.payload.scoop.isCone).toBe(true);
    expect(event?.payload.scoop.name).toBe('NewCone');
  });

  it('scoop-feed dispatches to orchestrator.delegateToScoop with "sliccy"', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'scoop-feed',
      scoopJid: 'scoop_a',
      prompt: 'go do the thing',
    });
    expect(mockOrchestrator.delegateToScoop).toHaveBeenCalledWith(
      'scoop_a',
      'go do the thing',
      'sliccy'
    );
  });

  it('set-model triggers orchestrator.updateModel', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'set-model',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      apiKey: 'test',
    });
    expect(mockOrchestrator.updateModel).toHaveBeenCalledTimes(1);
  });

  it('refresh-model triggers orchestrator.updateModel', async () => {
    await (bridge as any).handlePanelMessage({ type: 'refresh-model' });
    expect(mockOrchestrator.updateModel).toHaveBeenCalledTimes(1);
  });

  it('request-state emits a state-snapshot', async () => {
    await (bridge as any).handlePanelMessage({ type: 'request-state' });
    const snapshot = sentMessages.find((m: any) => m.payload?.type === 'state-snapshot');
    expect(snapshot).toBeDefined();
  });

  it('clear-filesystem calls orchestrator.resetFilesystem', async () => {
    await (bridge as any).handlePanelMessage({ type: 'clear-filesystem' });
    expect(mockOrchestrator.resetFilesystem).toHaveBeenCalledTimes(1);
  });

  it('clear-filesystem swallows orchestrator errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOrchestrator.resetFilesystem.mockRejectedValueOnce(new Error('boom'));
    await expect(
      (bridge as any).handlePanelMessage({ type: 'clear-filesystem' })
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('set-thinking-level forwards to orchestrator.setScoopThinkingLevel', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'set-thinking-level',
      scoopJid: 'cone_1',
      level: 'high',
    });
    expect(mockOrchestrator.setScoopThinkingLevel).toHaveBeenCalledWith(
      'cone_1',
      'high',
      undefined
    );
  });

  it('set-thinking-level swallows orchestrator errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockOrchestrator.setScoopThinkingLevel.mockRejectedValueOnce(new Error('bad level'));
    await expect(
      (bridge as any).handlePanelMessage({
        type: 'set-thinking-level',
        scoopJid: 'cone_1',
        level: 'xhigh',
      })
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('reload-skills triggers orchestrator.reloadAllSkills', async () => {
    await (bridge as any).handlePanelMessage({ type: 'reload-skills' });
    expect(mockOrchestrator.reloadAllSkills).toHaveBeenCalledTimes(1);
  });

  it('reload-skills swallows orchestrator errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockOrchestrator.reloadAllSkills.mockRejectedValueOnce(new Error('no skills dir'));
    await expect(
      (bridge as any).handlePanelMessage({ type: 'reload-skills' })
    ).resolves.toBeUndefined();
    // Microtask drain for the fire-and-forget .catch handler
    await new Promise((r) => setTimeout(r, 5));
    warnSpy.mockRestore();
  });

  it('lick-webhook-event forwards to orchestrator.handleWebhookEvent', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'lick-webhook-event',
      webhookId: 'wh-1',
      headers: { 'x-test': 'true' },
      body: { hello: 'world' },
    });
    expect(mockOrchestrator.handleWebhookEvent).toHaveBeenCalledWith(
      'wh-1',
      { 'x-test': 'true' },
      { hello: 'world' }
    );
  });

  it('abort calls stopScoop and clears queued messages', async () => {
    await (bridge as any).handlePanelMessage({ type: 'abort', scoopJid: 'cone_1' });
    expect(mockOrchestrator.stopScoop).toHaveBeenCalledWith('cone_1');
    expect(mockOrchestrator.clearQueuedMessages).toHaveBeenCalledWith('cone_1');
  });

  it('delete-queued-message forwards to orchestrator.deleteQueuedMessage', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'delete-queued-message',
      scoopJid: 'cone_1',
      messageId: 'msg-42',
    });
    expect(mockOrchestrator.deleteQueuedMessage).toHaveBeenCalledWith('cone_1', 'msg-42');
    // Must not drop neighbouring queued items.
    expect(mockOrchestrator.clearQueuedMessages).not.toHaveBeenCalled();
  });

  it('delete-queued-message evicts the matching entry from the per-scoop buffer', async () => {
    // Regression for PR #1062 review: a dismissed queued bubble could be
    // resurrected after a reload/HMR because the bridge's messageBuffers
    // still carried the entry — `request-scoop-messages` would replay it.
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-keep', role: 'user', content: 'keep me', timestamp: 1 });
    buf.push({ id: 'msg-drop', role: 'user', content: 'drop me', timestamp: 2 });
    buf.push({ id: 'msg-also-keep', role: 'user', content: 'also keep', timestamp: 3 });
    const persistSpy = vi.spyOn(bridge as any, 'persistScoop');
    await (bridge as any).handlePanelMessage({
      type: 'delete-queued-message',
      scoopJid: 'cone_1',
      messageId: 'msg-drop',
    });
    const after = (bridge as any).messageBuffers.get('cone_1');
    expect(after.map((m: any) => m.id)).toEqual(['msg-keep', 'msg-also-keep']);
    // Re-persists so the UI session store mirrors the eviction; a later
    // session-store-backed rehydration cannot resurrect the dropped entry.
    expect(persistSpy).toHaveBeenCalledWith('cone_1');
  });

  it('delete-queued-message is a no-op when the buffer is absent or missing the id', async () => {
    const persistSpy = vi.spyOn(bridge as any, 'persistScoop');
    // Buffer absent: orchestrator delete still fires, no buffer mutation.
    await (bridge as any).handlePanelMessage({
      type: 'delete-queued-message',
      scoopJid: 'scoop_a',
      messageId: 'ghost',
    });
    expect((bridge as any).messageBuffers.has('scoop_a')).toBe(false);
    expect(persistSpy).not.toHaveBeenCalled();
    // Buffer present but no matching entry: no mutation, no re-persist.
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'msg-keep', role: 'user', content: 'keep me', timestamp: 1 });
    await (bridge as any).handlePanelMessage({
      type: 'delete-queued-message',
      scoopJid: 'cone_1',
      messageId: 'unknown',
    });
    expect((bridge as any).messageBuffers.get('cone_1').map((m: any) => m.id)).toEqual([
      'msg-keep',
    ]);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it('local-storage-set writes through to globalThis.localStorage', async () => {
    const ls = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    (globalThis as any).localStorage = ls;
    try {
      await (bridge as any).handlePanelMessage({
        type: 'local-storage-set',
        key: 'k',
        value: 'v',
      });
      expect(ls.setItem).toHaveBeenCalledWith('k', 'v');
    } finally {
      delete (globalThis as any).localStorage;
    }
  });

  it('local-storage-remove writes through to globalThis.localStorage', async () => {
    const ls = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    (globalThis as any).localStorage = ls;
    try {
      await (bridge as any).handlePanelMessage({ type: 'local-storage-remove', key: 'k' });
      expect(ls.removeItem).toHaveBeenCalledWith('k');
    } finally {
      delete (globalThis as any).localStorage;
    }
  });

  it('local-storage-clear writes through to globalThis.localStorage', async () => {
    const ls = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    (globalThis as any).localStorage = ls;
    try {
      await (bridge as any).handlePanelMessage({ type: 'local-storage-clear' });
      expect(ls.clear).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as any).localStorage;
    }
  });

  it('local-storage-set swallows setItem errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).localStorage = {
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    try {
      await expect(
        (bridge as any).handlePanelMessage({ type: 'local-storage-set', key: 'k', value: 'v' })
      ).resolves.toBeUndefined();
    } finally {
      delete (globalThis as any).localStorage;
      warnSpy.mockRestore();
    }
  });

  it('local-storage-remove swallows removeItem errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).localStorage = {
      setItem: vi.fn(),
      removeItem: vi.fn(() => {
        throw new Error('forbidden');
      }),
      clear: vi.fn(),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    try {
      await expect(
        (bridge as any).handlePanelMessage({ type: 'local-storage-remove', key: 'k' })
      ).resolves.toBeUndefined();
    } finally {
      delete (globalThis as any).localStorage;
      warnSpy.mockRestore();
    }
  });

  it('local-storage-clear swallows clear errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).localStorage = {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(() => {
        throw new Error('forbidden');
      }),
      getItem: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    try {
      await expect(
        (bridge as any).handlePanelMessage({ type: 'local-storage-clear' })
      ).resolves.toBeUndefined();
    } finally {
      delete (globalThis as any).localStorage;
      warnSpy.mockRestore();
    }
  });

  it('scoop-drop with no sessionStore does not throw', async () => {
    // Force sessionStore to null by reaching past bind()
    (bridge as any).sessionStore = null;
    await expect(
      (bridge as any).handlePanelMessage({ type: 'scoop-drop', scoopJid: 'scoop_a' })
    ).resolves.toBeUndefined();
    expect(mockOrchestrator.unregisterScoop).toHaveBeenCalledWith('scoop_a');
  });
});

describe('Bridge handleRequestScoopMessages', () => {
  let bridge: InstanceType<typeof Bridge>;
  let mockOrchestrator: any;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    bridge = new Bridge();
    mockOrchestrator = {
      getScoops: vi.fn(() => [
        { jid: 'cone_1', name: 'Cone', folder: 'cone', isCone: true, assistantLabel: 'sliccy' },
      ]),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      getScoopContext: vi.fn(() => undefined),
    };
    await bridge.bind(mockOrchestrator);
  });

  it('emits scoop-messages-replaced from the buffered chat when present', async () => {
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'u1', role: 'user', content: 'hi', timestamp: 100 });
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-messages',
      scoopJid: 'cone_1',
    });
    const replaced = sentMessages.find((m: any) => m.payload?.type === 'scoop-messages-replaced') as
      | { payload: { messages: Array<{ id: string }> } }
      | undefined;
    expect(replaced?.payload.messages).toHaveLength(1);
    expect(replaced?.payload.messages[0].id).toBe('u1');
  });

  it('is a no-op when the orchestrator is not bound', async () => {
    const fresh = new Bridge();
    await (fresh as any).handlePanelMessage({
      type: 'request-scoop-messages',
      scoopJid: 'cone_1',
    });
    // No emit happens — orchestrator is null
    expect(sentMessages.filter((m: any) => m.payload?.type === 'scoop-messages-replaced')).toEqual(
      []
    );
  });

  it('is a no-op when scoopJid does not match any scoop', async () => {
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-messages',
      scoopJid: 'does-not-exist',
    });
    expect(sentMessages.filter((m: any) => m.payload?.type === 'scoop-messages-replaced')).toEqual(
      []
    );
  });

  it('loads from sessionStore when no buffer and no agent messages', async () => {
    const store = (bridge as any).sessionStore;
    store.load = vi.fn().mockResolvedValue({
      messages: [{ id: 'm1', role: 'user', content: 'previous', timestamp: 50 }],
    });
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-messages',
      scoopJid: 'cone_1',
    });
    const replaced = sentMessages.find((m: any) => m.payload?.type === 'scoop-messages-replaced') as
      | { payload: { messages: Array<{ id: string }> } }
      | undefined;
    expect(store.load).toHaveBeenCalledWith('session-cone');
    expect(replaced?.payload.messages).toHaveLength(1);
    expect(replaced?.payload.messages[0].id).toBe('m1');
  });

  it('swallows sessionStore.load errors without emitting', async () => {
    const store = (bridge as any).sessionStore;
    store.load = vi.fn().mockRejectedValue(new Error('idb closed'));
    await expect(
      (bridge as any).handlePanelMessage({
        type: 'request-scoop-messages',
        scoopJid: 'cone_1',
      })
    ).resolves.toBeUndefined();
    expect(sentMessages.filter((m: any) => m.payload?.type === 'scoop-messages-replaced')).toEqual(
      []
    );
  });

  it('emits nothing when sessionStore returns no messages', async () => {
    const store = (bridge as any).sessionStore;
    store.load = vi.fn().mockResolvedValue({ messages: [] });
    await (bridge as any).handlePanelMessage({
      type: 'request-scoop-messages',
      scoopJid: 'cone_1',
    });
    expect(sentMessages.filter((m: any) => m.payload?.type === 'scoop-messages-replaced')).toEqual(
      []
    );
  });
});

describe('Bridge seedBuffersFromAgentState', () => {
  let bridge: InstanceType<typeof Bridge>;

  const coneScoop = {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    isCone: true,
    assistantLabel: 'sliccy',
  };
  const makeContext = (messages: any[]) => ({ getAgentMessages: vi.fn(() => messages) });
  const restoredHistory = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'first answer' }],
      timestamp: 2,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      stopReason: 'stop',
    },
  ];

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    bridge = new Bridge();
  });

  it('seeds an empty buffer from the restored agent messages and persists it', async () => {
    const context = makeContext(restoredHistory);
    await bridge.bind({
      getScoops: vi.fn(() => [coneScoop]),
      getScoopContext: vi.fn(() => context),
    } as any);
    const store = (bridge as any).sessionStore;

    await bridge.seedBuffersFromAgentState();

    const buf = (bridge as any).getBuffer('cone_1');
    expect(buf).toHaveLength(2);
    expect(buf[0]).toMatchObject({ role: 'user', content: 'first question' });
    expect(buf[1]).toMatchObject({ role: 'assistant', content: 'first answer' });
    // Repairs the UI store immediately (the truncation fix).
    expect(store.saveMessages).toHaveBeenCalledWith('session-cone', expect.any(Array));
    const persisted = store.saveMessages.mock.calls[0][1];
    expect(persisted).toHaveLength(2);
  });

  it('does not overwrite a buffer that already has live messages', async () => {
    const context = makeContext(restoredHistory);
    await bridge.bind({
      getScoops: vi.fn(() => [coneScoop]),
      getScoopContext: vi.fn(() => context),
    } as any);
    const store = (bridge as any).sessionStore;
    const buf = (bridge as any).getBuffer('cone_1');
    buf.push({ id: 'live-1', role: 'user', content: 'live', timestamp: 100 });

    await bridge.seedBuffersFromAgentState();

    const after = (bridge as any).getBuffer('cone_1');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe('live-1');
    // Skipped before even reading the context — no clobber, no persist.
    expect(context.getAgentMessages).not.toHaveBeenCalled();
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it('skips scoops with no restored agent messages (no buffer, no persist)', async () => {
    const context = makeContext([]);
    await bridge.bind({
      getScoops: vi.fn(() => [coneScoop]),
      getScoopContext: vi.fn(() => context),
    } as any);
    const store = (bridge as any).sessionStore;

    await bridge.seedBuffersFromAgentState();

    expect((bridge as any).messageBuffers.get('cone_1')).toBeUndefined();
    expect(store.saveMessages).not.toHaveBeenCalled();
  });

  it('is a no-op when the orchestrator is not bound', async () => {
    const fresh = new Bridge();
    await expect(fresh.seedBuffersFromAgentState()).resolves.toBeUndefined();
  });
});
