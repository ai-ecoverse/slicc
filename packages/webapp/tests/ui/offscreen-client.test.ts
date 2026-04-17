/**
 * Tests for OffscreenClient — side panel's interface to the offscreen agent engine.
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
    client.selectedScoopJid = 'cone_123';
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

  it('sends abort on stop', () => {
    client.selectedScoopJid = 'cone_123';
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
    client.selectedScoopJid = 'cone_123';
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
    client.selectedScoopJid = 'cone_123';
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
    client.selectedScoopJid = 'cone_123';
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

  it('sends clear-chat', () => {
    client.clearAllMessages();

    const envelope = sentMessages[0] as { source: string; payload: any };
    expect(envelope.payload.type).toBe('clear-chat');
  });

  it('ignores messages from non-offscreen sources', () => {
    client.selectedScoopJid = 'cone_123';
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
      name: 'Test',
      folder: 'test-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'test-scoop',
      addedAt: '',
    });
    const envelope = sentMessages[0] as { payload: any };
    expect(envelope.payload.type).toBe('scoop-create');
    expect(envelope.payload.name).toBe('Test');
    expect(envelope.payload.isCone).toBe(false);
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

  it('handles tool_start and tool_end events', () => {
    client.selectedScoopJid = 'cone_123';
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
});
