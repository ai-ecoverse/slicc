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
    onMessageUpdate: vi.fn(),
    onLickBackpressure: vi.fn(),
    onScoopActivity: vi.fn(),
    onScoopPhaseChange: vi.fn(),
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

  it('forwards the steer flag on a steering send and leaves it unset otherwise', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();

    handle.sendMessage('interrupt', 'msg-1', undefined, { steer: true });
    handle.sendMessage('enqueue', 'msg-2');

    const payloads = sentMessages.map((m) => (m as { payload: any }).payload);
    expect(payloads[0].steer).toBe(true);
    expect(payloads[1].steer).toBeUndefined();
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

  it('fires onScoopActivity for non-selected scoop agent events while not rendering them', () => {
    // The navbar eyes follow the actively-streaming scoop even when it is
    // not the selected one; the thread itself must NOT render those events.
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: unknown[] = [];
    handle.onEvent((e) => events.push(e));

    for (const eventType of ['text_delta', 'tool_start', 'tool_ui', 'turn_end']) {
      simulateMessage('offscreen', {
        type: 'agent-event',
        scoopJid: 'other_scoop',
        eventType,
        text: 'x',
        toolName: 't',
        requestId: 'r',
        html: '<i/>',
      });
    }

    expect(callbacks.onScoopActivity).toHaveBeenCalledTimes(4);
    expect(callbacks.onScoopActivity).toHaveBeenCalledWith('other_scoop');
    // Selection gate still suppresses thread rendering for non-selected scoops.
    expect(events.length).toBe(0);
  });

  it('does not fire onScoopActivity for tool_end / response_done', () => {
    // Activity ping is restricted to the four "loud" event types so the
    // attention attribute doesn't flap on every micro-event.
    client.setSelectedScoopJid('cone_123');

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'tool_end',
      toolName: 't',
      toolResult: 'ok',
    });
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'response_done',
    });

    expect(callbacks.onScoopActivity).not.toHaveBeenCalled();
  });

  describe('per-scoop busy phase (onScoopPhaseChange)', () => {
    /** Feed one agent event for `jid` (defaults to a NON-selected scoop). */
    function agentEvent(eventType: string, jid = 'other_scoop'): void {
      simulateMessage('offscreen', {
        type: 'agent-event',
        scoopJid: jid,
        eventType,
        toolName: 't',
        toolResult: 'ok',
      });
    }

    /** The phases reported so far, as `jid:phase` pairs. */
    function reported(): string[] {
      return callbacks.onScoopPhaseChange.mock.calls.map(([jid, phase]) => `${jid}:${phase}`);
    }

    beforeEach(() => client.setSelectedScoopJid('cone_123'));

    it('crosses to tool on tool_start and back to thinking on tool_end', () => {
      agentEvent('tool_start');
      agentEvent('tool_end');
      expect(reported()).toEqual(['other_scoop:tool', 'other_scoop:thinking']);
    });

    it('tracks scoops the user is NOT looking at (the whole point of the tab pin)', () => {
      agentEvent('tool_start', 'other_scoop');
      expect(reported()).toEqual(['other_scoop:tool']);
    });

    it('reports only zero crossings, so nested tool calls do not flap the pin', () => {
      agentEvent('tool_start');
      agentEvent('tool_start');
      agentEvent('tool_end');
      expect(reported()).toEqual(['other_scoop:tool']);
      agentEvent('tool_end');
      expect(reported()).toEqual(['other_scoop:tool', 'other_scoop:thinking']);
    });

    it('never drops below zero on an unmatched tool_end', () => {
      agentEvent('tool_end');
      expect(reported()).toEqual([]);
      agentEvent('tool_start');
      expect(reported()).toEqual(['other_scoop:tool']);
    });

    it('resets at turn_end so a turn that died mid-tool cannot strand the pin', () => {
      agentEvent('tool_start');
      agentEvent('turn_end');
      expect(reported()).toEqual(['other_scoop:tool', 'other_scoop:thinking']);
    });

    it('resets on a CHANGED scoop status, but not on a repeated one', () => {
      /** Broadcast a lifecycle status for the non-selected scoop. */
      function status(value: string): void {
        simulateMessage('offscreen', {
          type: 'scoop-status',
          scoopJid: 'other_scoop',
          status: value,
        });
      }
      // Real ordering: the turn's `processing` edge lands before any tool.
      status('processing');
      agentEvent('tool_start');
      callbacks.onScoopPhaseChange.mockClear();
      // A repeated identical broadcast is not a turn boundary — a tool that is
      // still running must keep its phase.
      status('processing');
      status('processing');
      expect(reported()).toEqual([]);
      // Erroring out mid-tool IS a boundary, and clears it.
      status('error');
      expect(reported()).toEqual(['other_scoop:thinking']);
    });

    it('keeps a separate count per scoop', () => {
      agentEvent('tool_start', 'a');
      agentEvent('tool_start', 'b');
      agentEvent('tool_end', 'a');
      expect(reported()).toEqual(['a:tool', 'b:tool', 'a:thinking']);
    });
  });

  it('relays message-updated to onMessageUpdate (live lick flip)', () => {
    simulateMessage('offscreen', {
      type: 'message-updated',
      scoopJid: 'cone_123',
      messageId: 'sudo-request-lick-1',
      lickId: 'lick-1',
      lickState: 'confirmed',
    });

    expect(callbacks.onMessageUpdate).toHaveBeenCalledWith('cone_123', {
      messageId: 'sudo-request-lick-1',
      lickId: 'lick-1',
      lickState: 'confirmed',
    });
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
        parentJid: 'cone_1',
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
          parentJid: null,
          assistantLabel: 'sliccy',
          status: 'ready',
        },
        {
          jid: 'scoop_1',
          name: 'Worker',
          folder: 'worker-scoop',
          isCone: false,
          parentJid: 'cone_1',
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

  it('routes lick backpressure through its dedicated callback', () => {
    simulateMessage('offscreen', {
      type: 'lick-backpressure',
      scoopJid: 'cone_123',
      count: 4,
      waitingMs: 300_000,
    });

    expect(callbacks.onLickBackpressure).toHaveBeenCalledWith('cone_123', {
      count: 4,
      waitingMs: 300_000,
    });
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

  it('awaits thinking acknowledgment and updates the cached scoop before resolving', async () => {
    simulateMessage('offscreen', {
      type: 'scoop-list',
      scoops: [
        {
          jid: 'cone_1',
          name: 'Cone',
          folder: 'cone',
          isCone: true,
          parentJid: null,
          assistantLabel: 'sliccy',
          status: 'ready',
          config: { thinkingLevel: 'off' },
        },
      ],
    });
    const pending = client.setScoopThinkingLevel('cone_1', 'xhigh', 'max');
    const envelope = sentMessages[0] as { payload: any };

    expect(envelope.payload).toMatchObject({
      type: 'set-thinking-level',
      scoopJid: 'cone_1',
      level: 'xhigh',
      effortOverride: 'max',
    });
    simulateMessage('offscreen', {
      type: 'set-thinking-level-ack',
      requestId: envelope.payload.requestId,
      scoopJid: 'cone_1',
      level: 'xhigh',
      effortOverride: 'max',
      applied: true,
    });

    await expect(pending).resolves.toBe(true);
    expect(client.getScoop('cone_1')?.config).toMatchObject({
      thinkingLevel: 'xhigh',
      effortOverride: 'max',
    });
  });

  it('bounds a thinking update when the worker does not acknowledge it', async () => {
    vi.useFakeTimers();
    try {
      const pending = client.setScoopThinkingLevel('cone_1', 'xhigh', 'max');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
      parentJid: null,
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
        parentJid: 'cone_1',
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
          parentJid: 'cone_1',
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
          parentJid: null,
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

  it('finds the streaming assistant even when a queued user message is buffered after it', () => {
    client.setSelectedScoopJid('cone_123');
    const handle = client.createAgentHandle();
    const events: any[] = [];
    handle.onEvent((e) => events.push(e));

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'before',
    });

    // A prompt/lick queued mid-turn lands AFTER the streaming assistant in
    // the replay buffer — the streaming entry is no longer the tail.
    simulateMessage('offscreen', {
      type: 'scoop-messages-replaced',
      scoopJid: 'cone_123',
      messages: [
        { id: 'buf-stream', role: 'assistant', content: 'before', timestamp: 2, isStreaming: true },
        { id: 'queued-1', role: 'user', content: 'do this next', timestamp: 3 },
      ],
    });

    events.length = 0;
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: ' after',
    });
    // Still extends the streaming assistant, not a new bubble.
    expect(events.map((e) => e.type)).toEqual(['content_delta']);
    expect(events[0].messageId).toBe('buf-stream');
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

describe('OffscreenClient compaction notices (#1985)', () => {
  let client: InstanceType<typeof OffscreenClient>;
  const callbacks = {
    onStatusChange: vi.fn(),
    onScoopCreated: vi.fn(),
    onScoopListUpdate: vi.fn(),
    onIncomingMessage: vi.fn(),
    onMessageUpdate: vi.fn(),
    onLickBackpressure: vi.fn(),
    onScoopActivity: vi.fn(),
    onCompactionStateChange: vi.fn(),
  };

  beforeEach(() => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    client = new OffscreenClient(callbacks);
  });

  function collect(): Array<{ type: string; messageId?: string; text?: string }> {
    const events: Array<{ type: string; messageId?: string; text?: string }> = [];
    client.createAgentHandle().onEvent((e) => events.push(e as (typeof events)[number]));
    return events;
  }

  it('renders "summarizing" as a standalone completed bubble', () => {
    client.setSelectedScoopJid('cone_123');
    const events = collect();

    simulateMessage('offscreen', {
      type: 'compaction-state',
      scoopJid: 'cone_123',
      state: 'summarizing',
    });

    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'content_done']);
    expect(events[1].text).toContain('compacting history');
    // All three events target the same synthetic bubble.
    expect(new Set(events.map((e) => e.messageId)).size).toBe(1);
    expect(callbacks.onCompactionStateChange).toHaveBeenCalledWith('cone_123', 'summarizing');
  });

  it('renders "fallback" as a truncation notice and stays silent for other states', () => {
    client.setSelectedScoopJid('cone_123');
    const events = collect();

    for (const state of ['extracting-memory', 'idle', 'fallback']) {
      simulateMessage('offscreen', { type: 'compaction-state', scoopJid: 'cone_123', state });
    }

    // Only 'fallback' produced a bubble.
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta', 'content_done']);
    expect(events[1].text).toContain('Compaction summarization failed');
    expect(callbacks.onCompactionStateChange).toHaveBeenCalledTimes(3);
  });

  it('does not disturb an in-flight assistant stream', () => {
    client.setSelectedScoopJid('cone_123');
    const events = collect();

    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'part one ',
    });
    const streamId = events[0].messageId;

    simulateMessage('offscreen', {
      type: 'compaction-state',
      scoopJid: 'cone_123',
      state: 'summarizing',
    });
    simulateMessage('offscreen', {
      type: 'agent-event',
      scoopJid: 'cone_123',
      eventType: 'text_delta',
      text: 'part two',
    });

    // The stream resumes into ITS bubble — no fresh message_start, same id —
    // rather than being captured by (or appended to) the notice bubble.
    const tail = events[events.length - 1];
    expect(tail).toMatchObject({ type: 'content_delta', text: 'part two', messageId: streamId });
    const noticeIds = events
      .filter((e) => e.type === 'content_done')
      .map((e) => e.messageId as string);
    expect(noticeIds).toHaveLength(1);
    expect(noticeIds[0]).not.toBe(streamId);
  });

  it('drops notices for non-selected scoops but still forwards the state callback', () => {
    client.setSelectedScoopJid('cone_123');
    const events = collect();

    simulateMessage('offscreen', {
      type: 'compaction-state',
      scoopJid: 'scoop_other',
      state: 'fallback',
    });

    expect(events).toHaveLength(0);
    expect(callbacks.onCompactionStateChange).toHaveBeenCalledWith('scoop_other', 'fallback');
  });
});

describe('OffscreenClient.spawnAgent wire-safe cancel (#1972)', () => {
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

  function payloads(type: string): any[] {
    return sentMessages.map((m) => (m as { payload: any }).payload).filter((p) => p?.type === type);
  }

  it('strips the AbortSignal from the wired options (not structured-cloneable)', () => {
    const controller = new AbortController();
    void client.spawnAgent({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'go',
      signal: controller.signal,
    });

    const req = payloads('agent-spawn-request')[0];
    expect(req).toBeDefined();
    expect('signal' in req.options).toBe(false);
    expect(req.options.prompt).toBe('go');
    expect(typeof req.requestId).toBe('string');
  });

  it('translates a later abort into agent-spawn-abort with the same requestId', () => {
    const controller = new AbortController();
    void client.spawnAgent({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'go',
      signal: controller.signal,
    });
    const requestId = payloads('agent-spawn-request')[0].requestId;
    expect(payloads('agent-spawn-abort')).toHaveLength(0);

    controller.abort();

    const abort = payloads('agent-spawn-abort');
    expect(abort).toHaveLength(1);
    expect(abort[0].requestId).toBe(requestId);
  });

  it('sends the abort immediately when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    void client.spawnAgent({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'go',
      signal: controller.signal,
    });

    const req = payloads('agent-spawn-request')[0];
    const abort = payloads('agent-spawn-abort');
    expect(abort).toHaveLength(1);
    expect(abort[0].requestId).toBe(req.requestId);
  });

  it('sends no abort message when no signal is provided', () => {
    void client.spawnAgent({ cwd: '/workspace', allowedCommands: ['*'], prompt: 'go' });
    expect(payloads('agent-spawn-abort')).toHaveLength(0);
  });
});
