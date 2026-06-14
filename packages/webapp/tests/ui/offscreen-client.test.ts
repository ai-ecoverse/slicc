/**
 * Tests for OffscreenClient — side panel's interface to the offscreen agent engine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock chrome.runtime
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

const { OffscreenClient } = await import('../../src/ui/offscreen-client.js');

function simulateMessage(source: string, payload: unknown): void {
  for (const listener of messageListeners) {
    listener({ source, payload }, {}, () => {});
  }
}

describe('OffscreenClient', () => {
  let client: InstanceType<typeof OffscreenClient>;
  const callbacks = {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
  };

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    client = new OffscreenClient(callbacks);
  });

  it('sends user-message to offscreen', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();

    handle.sendMessage('Hello world', 'msg-1');

    expect(sentMessages.length).toBe(1);
    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.source).toBe('panel');
    expect(envelope.payload.type).toBe('user-message');
    expect(envelope.payload.scoopJid).toBe('cone_123');
    expect(envelope.payload.text).toBe('Hello world');
    expect(envelope.payload.messageId).toBe('msg-1');
  });

  it('sends attachments with user-message payloads', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const attachments = [
      {
        id: 'a1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        kind: 'text' as const,
        text: 'hello',
      },
    ];

    handle.sendMessage('Hello world', 'msg-1', attachments);

    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.payload.attachments).toEqual(attachments);
  });

  it('sends abort on stop', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();

    handle.stop();

    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.payload.type).toBe('abort');
    expect(envelope.payload.scoopJid).toBe('cone_123');
  });

  it('emits error when no scoop selected', () => {
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    handle.sendMessage('Hello');

    expect(events).toEqual([{ type: 'error', error: 'No scoop selected' }]);
    expect(sentMessages.length).toBe(0);
  });

  it('handles agent-event text_delta', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'Hello',
    });

    // Should get message_start + content_delta
    expect(events.length).toBe(2);
    expect((events[0] as any).type).toBe('message_start');
    expect((events[1] as any).type).toBe('content_delta');
    expect((events[1] as any).text).toBe('Hello');
  });

  it('ignores agent-events for non-selected scoops', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'other_scoop',
      eventType: 'text_delta',
      text: 'Hello',
    });

    expect(events.length).toBe(0);
  });

  it('handles scoop-status changes', () => {
    simulateMessage('offscreen', {
      type: 'scoop-status',
      scoopJid: 'cone_123',
      status: 'processing',
    });

    expect(callbacks.onStatusChange).toHaveBeenCalledWith('cone_123', 'processing');
    expect(client.isProcessing('cone_123')).toBe(true);
  });

  it('handles scoop-created', () => {
    simulateMessage('offscreen', {
      type: 'scoop-created',
      scoop: {
        jid: 'scoop_test_1',
        name: 'Test',
        folder: 'test-scoop',
        isCone: false,
        assistantLabel: 'test-scoop',
        status: 'ready',
      },
    });

    expect(callbacks.onScoopCreated).toHaveBeenCalled();
    expect(client.getScoops().length).toBe(1);
    expect(client.getScoop('scoop_test_1')?.name).toBe('Test');
  });

  it('handles state-snapshot', () => {
    simulateMessage('offscreen', {
      type: 'state-snapshot',
      scoops: [
        {
          jid: 'cone_1',
          name: 'Cone',
          folder: 'cone',
          isCone: true,
          assistantLabel: 'sliccy',
          status: 'ready',
        },
        {
          jid: 'scoop_1',
          name: 'Worker',
          folder: 'worker-scoop',
          isCone: false,
          assistantLabel: 'worker-scoop',
          status: 'processing',
        },
      ],
      activeScoopJid: 'cone_1',
    });

    expect(client.getScoops().length).toBe(2);
    expect(client.isProcessing('scoop_1')).toBe(true);
    expect(client.isProcessing('cone_1')).toBe(false);
    expect(callbacks.onScoopListUpdate).toHaveBeenCalled();
  });

  it('handles error for selected scoop', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'error',
      scoopJid: 'cone_123',
      error: 'Something went wrong',
    });

    expect(events).toEqual([{ type: 'error', error: 'Something went wrong' }]);
  });

  it('sends request-state', () => {
    client.requestState();

    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.payload.type).toBe('request-state');
  });

  it('sends clear-chat with a requestId and resolves once the ack arrives', async () => {
    const pending = client.clearAllMessages();

    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.payload.type).toBe('clear-chat');
    expect(typeof envelope.payload.requestId).toBe('string');
    expect(envelope.payload.requestId.length).toBeGreaterThan(0);

    // Mirror the bridge's ack so the awaited Promise resolves.
    simulateMessage('offscreen', {
      type: 'clear-chat-ack',
      requestId: envelope.payload.requestId,
    });
    await pending;
  });

  it('clear-chat resolves on timeout if no ack arrives', async () => {
    vi.useFakeTimers();
    try {
      const pending = client.clearAllMessages();
      // 5s timeout backs out cleanly so the panel can reload anyway.
      vi.advanceTimersByTime(5000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks outbound messages when locked', () => {
    // updateModel() is a public method that calls this.send({ type: 'refresh-model' }).
    // Source: packages/webapp/src/ui/offscreen-client.ts updateModel() at ~line 222.
    client.updateModel();
    const beforeLockCount = sentMessages.length;

    client.setLocked(true);
    client.updateModel();
    expect(sentMessages.length).toBe(beforeLockCount); // no new send

    client.setLocked(false);
    client.updateModel();
    expect(sentMessages.length).toBeGreaterThan(beforeLockCount);
  });

  it('ignores messages from non-offscreen sources', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    // Panel message should be ignored
    simulateMessage('panel', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'Hello',
    });

    expect(events.length).toBe(0);
  });

  it('registerScoop sends scoop-create message', () => {
    client.registerScoop({
      jid: 'temp',
      name: 'Cone',
      folder: 'cone',
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '',
    });
    const envelope = sentMessages[0] as { payload: any };
    expect(envelope.payload.type).toBe('cone-create');
    expect(envelope.payload.name).toBe('Cone');
    // No `isCone` on the wire — the bridge handler knows this path is cone-only.
    expect(envelope.payload.isCone).toBeUndefined();
  });

  it('registerScoop rejects when called with a non-cone scoop', async () => {
    await expect(
      client.registerScoop({
        jid: 'temp',
        name: 'Rogue',
        folder: 'rogue-scoop',
        isCone: false,
        type: 'scoop',
        requiresTrigger: true,
        assistantLabel: 'rogue-scoop',
        addedAt: '',
      })
    ).rejects.toThrow(/cone-only/i);
  });

  it('unregisterScoop sends scoop-drop and removes locally', () => {
    // First add a scoop via state snapshot
    simulateMessage('offscreen', {
      type: 'state-snapshot',
      scoops: [
        {
          jid: 'scoop_1',
          name: 'Test',
          folder: 'test',
          isCone: false,
          assistantLabel: 'test',
          status: 'ready',
        },
      ],
      activeScoopJid: null,
    });
    expect(client.getScoops().length).toBe(1);

    client.unregisterScoop('scoop_1');
    expect(client.getScoops().length).toBe(0);
    const envelope = sentMessages[0] as { payload: any };
    expect(envelope.payload.type).toBe('scoop-drop');
  });

  it('stopScoop sends abort', () => {
    client.stopScoop('cone_123');
    const envelope = sentMessages[0] as { payload: any };
    expect(envelope.payload.type).toBe('abort');
    expect(envelope.payload.scoopJid).toBe('cone_123');
  });

  it('marks ready after state-snapshot', () => {
    expect(client.isReady()).toBe(false);
    simulateMessage('offscreen', {
      type: 'state-snapshot',
      scoops: [
        {
          jid: 'cone_1',
          name: 'Cone',
          folder: 'cone',
          isCone: true,
          assistantLabel: 'sliccy',
          status: 'ready',
        },
      ],
      activeScoopJid: 'cone_1',
    });
    expect(client.isReady()).toBe(true);
  });

  it('calls onReady after state-snapshot', () => {
    const onReady = vi.fn();
    // Create new client with onReady callback
    const c2 = new OffscreenClient({ ...callbacks, onReady });
    simulateMessage('offscreen', {
      type: 'state-snapshot',
      scoops: [],
      activeScoopJid: null,
    });
    expect(onReady).toHaveBeenCalled();
  });

  it('resets ready and re-requests state when offscreen restarts mid-session', () => {
    const onReady = vi.fn();
    const c2 = new OffscreenClient({ ...callbacks, onReady });

    // First boot: offscreen-ready → request-state → state-snapshot → ready
    simulateMessage('offscreen', { type: 'offscreen-ready' });
    simulateMessage('offscreen', { type: 'state-snapshot', scoops: [], activeScoopJid: null });
    expect(c2.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    sentMessages.length = 0;

    // Offscreen restarts: second offscreen-ready while already ready
    simulateMessage('offscreen', { type: 'offscreen-ready' });
    expect(c2.isReady()).toBe(false);
    const requestStateMsg = (sentMessages[0] as { payload: any })?.payload;
    expect(requestStateMsg?.type).toBe('request-state');

    // New state-snapshot arrives → onReady fires again
    simulateMessage('offscreen', { type: 'state-snapshot', scoops: [], activeScoopJid: null });
    expect(c2.isReady()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('handles tool_start and tool_end events', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'tool_start',
      toolName: 'bash',
      toolInput: { command: 'ls' },
    });

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'tool_end',
      toolName: 'bash',
      toolResult: 'file1.txt\nfile2.txt',
      isError: false,
    });

    expect(events.length).toBe(3); // message_start + tool_use_start + tool_result
    expect((events[1] as any).type).toBe('tool_use_start');
    expect((events[1] as any).toolName).toBe('bash');
    expect((events[2] as any).type).toBe('tool_result');
    expect((events[2] as any).result).toBe('file1.txt\nfile2.txt');
  });

  it('sendSetFollowerForwarding posts the toggle to the worker', () => {
    client.sendSetFollowerForwarding(true);
    const env = sentMessages.at(-1) as { source: string; payload: any };
    expect(env.source).toBe('panel');
    expect(env.payload).toEqual({ type: 'set-follower-forwarding', enabled: true });
  });

  it('sendForwardedLick posts the event to the worker', () => {
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    client.sendForwardedLick(event as any);
    const env = sentMessages.at(-1) as { source: string; payload: any };
    expect(env.payload).toEqual({ type: 'inject-forwarded-lick', event });
  });

  it('dispatches inbound forward-lick to the registered handler', () => {
    const handler = vi.fn();
    client.setForwardLickHandler(handler);
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    simulateMessage('offscreen', { type: 'forward-lick', event });
    expect(handler).toHaveBeenCalledWith(event);
  });
});

describe('OffscreenClient.setSelectedScoopJid + onScoopSelected', () => {
  let localClient: InstanceType<typeof OffscreenClient>;
  const callbacks = {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
  };

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    localClient = new OffscreenClient(callbacks);
  });

  it('setSelectedScoopJid updates the field and fires listeners', () => {
    const calls: string[] = [];
    localClient.onScoopSelected((jid) => calls.push(jid));
    localClient.setSelectedScoopJid('scoop-1');
    expect(localClient.selectedScoopJid).toBe('scoop-1');
    expect(calls).toEqual(['scoop-1']);
  });

  it('does not fire when the same jid is set twice', () => {
    localClient.setSelectedScoopJid('scoop-1');
    const calls: string[] = [];
    localClient.onScoopSelected((jid) => calls.push(jid));
    localClient.setSelectedScoopJid('scoop-1');
    expect(calls).toEqual([]);
  });

  it('returns an unsubscribe that stops firing', () => {
    const off = localClient.onScoopSelected(() => {
      throw new Error('should not fire after off()');
    });
    off();
    expect(() => localClient.setSelectedScoopJid('scoop-2')).not.toThrow();
  });

  it('handler throws are logged but do not break other listeners', () => {
    const calls: string[] = [];
    localClient.onScoopSelected(() => {
      throw new Error('first handler bad');
    });
    localClient.onScoopSelected((jid) => calls.push(jid));
    localClient.setSelectedScoopJid('scoop-3');
    expect(calls).toEqual(['scoop-3']);
  });

  it('setSelectedScoopJid(null) updates the field but does NOT fire listeners', () => {
    // The deliberate contract: a null clear is internal bookkeeping
    // (no scoop selected), not a selection event. Listeners ONLY fire
    // on transitions to a non-null jid. Without this gate, downstream
    // observers (e.g. the extension-leader hooks pushing active-scoop
    // to offscreen) would mistakenly broadcast a "selection" with a
    // null payload on every clear.
    localClient.setSelectedScoopJid('scoop-1');
    const calls: string[] = [];
    localClient.onScoopSelected((jid) => calls.push(jid));
    localClient.setSelectedScoopJid(null);
    expect(localClient.selectedScoopJid).toBeNull();
    expect(calls).toEqual([]);
  });

  it('setSelectedScoopJid(null) followed by non-null fires the listener', () => {
    // The flip side of the contract above: clearing to null and then
    // selecting a new scoop MUST fire the listener for the new scoop.
    // (If the null clear silently advanced state without resetting the
    // change-detection gate, the next selection could be treated as
    // unchanged.)
    localClient.setSelectedScoopJid('scoop-1');
    localClient.setSelectedScoopJid(null);
    const calls: string[] = [];
    localClient.onScoopSelected((jid) => calls.push(jid));
    localClient.setSelectedScoopJid('scoop-2');
    expect(calls).toEqual(['scoop-2']);
  });
});

describe('OffscreenClient.getScoopTranscript', () => {
  let client: InstanceType<typeof OffscreenClient>;
  const callbacks = {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
  };

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    client = new OffscreenClient(callbacks);
  });

  it('sends request-scoop-transcript and resolves on matching reply', async () => {
    const pending = client.getScoopTranscript('cone_1');
    expect(sentMessages.length).toBe(1);
    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.source).toBe('panel');
    expect(envelope.payload.type).toBe('request-scoop-transcript');
    expect(envelope.payload.scoopJid).toBe('cone_1');
    const requestId = envelope.payload.requestId;
    expect(typeof requestId).toBe('string');

    simulateMessage('offscreen', {
      type: 'scoop-transcript',
      requestId,
      scoopJid: 'cone_1',
      transcript: 'user: hi\nassistant: hello',
    });

    await expect(pending).resolves.toBe('user: hi\nassistant: hello');
  });

  it('ignores replies for unrelated requestIds', async () => {
    const pending = client.getScoopTranscript('cone_1');
    const envelope = sentMessages[0] as { source: string; payload: any };
    const requestId = envelope.payload.requestId;

    // Unrelated reply — must not resolve the pending promise.
    simulateMessage('offscreen', {
      type: 'scoop-transcript',
      requestId: 'tr-other',
      scoopJid: 'cone_1',
      transcript: 'spurious',
    });

    // Correct reply
    simulateMessage('offscreen', {
      type: 'scoop-transcript',
      requestId,
      scoopJid: 'cone_1',
      transcript: 'real',
    });
    await expect(pending).resolves.toBe('real');
  });
});

describe('OffscreenClient stream-pointer resync on scoop-messages-replaced', () => {
  let client: InstanceType<typeof OffscreenClient>;
  const callbacks = {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
    onScoopMessagesReplaced: vi.fn(),
  };

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    client = new OffscreenClient(callbacks);
  });

  // Regression for #959: a mid-turn canonical replay (frozen-session thaw /
  // scoop switch / remount) used to leave the panel streaming into a vanished
  // synthetic id, so live deltas were dropped and the spinner hung forever.
  it('adopts the replay streaming-tail id so resumed deltas extend that bubble', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: any[] = [];
    handle.onEvent((e) => events.push(e));

    // First turn starts streaming under a synthetic id.
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'before',
    });
    expect(events[0].type).toBe('message_start');
    const syntheticId = events[0].messageId;

    // Canonical replay lands mid-turn with a still-streaming tail.
    simulateMessage('offscreen', {
      type: 'scoop-messages-replaced',
      scoopJid: 'cone_123',
      messages: [
        { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
        { id: 'buf-stream', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
      ],
    });
    expect(callbacks.onScoopMessagesReplaced).toHaveBeenCalledWith('cone_123', expect.any(Array));

    events.length = 0;
    // The next delta must continue into the replay's bubble (no new
    // message_start) and carry the replay's id, not the stale synthetic one.
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: ' after',
    });
    expect(events.map((e) => e.type)).toEqual(['content_delta']);
    expect(events[0].messageId).toBe('buf-stream');
    expect(events[0].messageId).not.toBe(syntheticId);
  });

  it('drops the pointer when the replay tail is settled so the next delta opens a fresh bubble', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: any[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'turn one',
    });

    // Replay with no streaming tail (turn already settled).
    simulateMessage('offscreen', {
      type: 'scoop-messages-replaced',
      scoopJid: 'cone_123',
      messages: [
        { id: 'a1', role: 'assistant', content: 'turn one', timestamp: 2, isStreaming: false },
      ],
    });

    events.length = 0;
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'turn two',
    });
    // A fresh turn: must re-open with message_start under a new id.
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta']);
    expect(events[0].messageId).not.toBe('a1');
  });
});
