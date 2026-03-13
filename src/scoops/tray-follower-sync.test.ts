import { describe, expect, it, vi } from 'vitest';

import { FollowerSyncManager } from './tray-follower-sync.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { LeaderToFollowerMessage, FollowerToLeaderMessage, TrayTargetEntry } from './tray-sync-protocol.js';

// ---------------------------------------------------------------------------
// Fake data channel
// ---------------------------------------------------------------------------

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<Function>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: Function): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  simulateLeaderMessage(msg: LeaderToFollowerMessage): void {
    const data = JSON.stringify(msg);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  simulateClose(): void {
    for (const listener of this.listeners.get('close') ?? []) {
      (listener as () => void)();
    }
  }

  simulateError(): void {
    for (const listener of this.listeners.get('error') ?? []) {
      (listener as () => void)();
    }
  }

  parseSent(): FollowerToLeaderMessage[] {
    return this.sent.map(s => JSON.parse(s));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FollowerSyncManager', () => {
  describe('AgentHandle: sendMessage', () => {
    it('sends user_message to leader over the data channel', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendMessage('hello', 'msg-1');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({ type: 'user_message', text: 'hello', messageId: 'msg-1' });
    });

    it('generates a messageId when not provided', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendMessage('hi');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('user_message');
      if (sent[0].type === 'user_message') {
        expect(sent[0].text).toBe('hi');
        expect(sent[0].messageId).toBeTruthy();
      }
    });
  });

  describe('AgentHandle: stop', () => {
    it('sends abort to leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.stop();

      const sent = channel.parseSent();
      expect(sent).toEqual([{ type: 'abort' }]);
    });
  });

  describe('AgentHandle: onEvent', () => {
    it('receives agent_event from leader and dispatches to listeners', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(e => events.push(e));

      const event: AgentEvent = { type: 'content_delta', messageId: 'm1', text: 'chunk' };
      channel.simulateLeaderMessage({ type: 'agent_event', event, scoopJid: 'cone' });

      expect(events).toEqual([event]);
    });

    it('unsubscribe removes the listener', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      const unsub = follower.onEvent(e => events.push(e));

      channel.simulateLeaderMessage({
        type: 'agent_event',
        event: { type: 'content_delta', messageId: 'm1', text: 'a' },
        scoopJid: 'cone',
      });
      expect(events).toHaveLength(1);

      unsub();
      channel.simulateLeaderMessage({
        type: 'agent_event',
        event: { type: 'content_delta', messageId: 'm1', text: 'b' },
        scoopJid: 'cone',
      });
      expect(events).toHaveLength(1);
    });

    it('dispatches error events from leader error messages', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(e => events.push(e));

      channel.simulateLeaderMessage({ type: 'error', error: 'something broke' });

      expect(events).toEqual([{ type: 'error', error: 'something broke' }]);
    });
  });

  describe('snapshot handling', () => {
    it('calls onSnapshot callback with messages', () => {
      const channel = new FakeChannel();
      const onSnapshot = vi.fn();
      const follower = new FollowerSyncManager(channel, { onSnapshot });

      const messages: ChatMessage[] = [
        { id: '1', role: 'user', content: 'hi', timestamp: 1 },
        { id: '2', role: 'assistant', content: 'hello', timestamp: 2 },
      ];
      channel.simulateLeaderMessage({ type: 'snapshot', messages, scoopJid: 'cone' });

      expect(onSnapshot).toHaveBeenCalledWith(messages, 'cone');
    });

    it('stores the latest snapshot for later retrieval', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      expect(follower.getLatestSnapshot()).toBeNull();

      const messages: ChatMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 1 }];
      channel.simulateLeaderMessage({ type: 'snapshot', messages, scoopJid: 'cone' });

      const snapshot = follower.getLatestSnapshot();
      expect(snapshot).toEqual({ messages, scoopJid: 'cone' });
    });
  });

  describe('user_message_echo handling', () => {
    it('calls onUserMessage callback with text, messageId and scoopJid', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from leader',
        messageId: 'msg-42',
        scoopJid: 'cone',
      });

      expect(onUserMessage).toHaveBeenCalledWith('hello from leader', 'msg-42', 'cone');
    });

    it('does not crash when onUserMessage is not provided', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      // Should not throw
      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'orphan message',
        messageId: 'msg-99',
        scoopJid: 'cone',
      });
    });

    it('skips user_message_echo for own messages (dedup)', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      // Follower sends a message (which tracks the ID)
      follower.sendMessage('hello from follower', 'msg-123');

      // Leader echoes it back
      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from follower',
        messageId: 'msg-123',
        scoopJid: 'cone',
      });

      // Should NOT trigger onUserMessage since it is the follower's own echo
      expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('displays user_message_echo from other sources (not own)', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      // Leader sends a user message echo from the leader or another follower
      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from leader',
        messageId: 'msg-456',
        scoopJid: 'cone',
      });

      // Should trigger onUserMessage
      expect(onUserMessage).toHaveBeenCalledWith('hello from leader', 'msg-456', 'cone');
    });

    it('only deduplicates each message ID once (single use)', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      // Follower sends a message
      follower.sendMessage('repeat test', 'msg-789');

      // First echo: suppressed
      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'repeat test',
        messageId: 'msg-789',
        scoopJid: 'cone',
      });
      expect(onUserMessage).not.toHaveBeenCalled();

      // Second echo with same ID (unlikely but defensive): not suppressed
      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'repeat test',
        messageId: 'msg-789',
        scoopJid: 'cone',
      });
      expect(onUserMessage).toHaveBeenCalledTimes(1);
      expect(onUserMessage).toHaveBeenCalledWith('repeat test', 'msg-789', 'cone');
    });
  });

  describe('status handling', () => {
    it('calls onStatus callback', () => {
      const channel = new FakeChannel();
      const onStatus = vi.fn();
      const follower = new FollowerSyncManager(channel, { onStatus });

      channel.simulateLeaderMessage({ type: 'status', scoopStatus: 'processing' });

      expect(onStatus).toHaveBeenCalledWith('processing');
    });
  });

  describe('requestSnapshot', () => {
    it('sends request_snapshot to leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.requestSnapshot();

      const sent = channel.parseSent();
      expect(sent).toEqual([{ type: 'request_snapshot' }]);
    });
  });

  describe('close', () => {
    it('closes the channel and stops dispatching events', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(e => events.push(e));

      follower.close();

      expect(channel.readyState).toBe('closed');

      // Events should not be dispatched after close
      channel.simulateLeaderMessage({
        type: 'agent_event',
        event: { type: 'content_delta', messageId: 'm1', text: 'late' },
        scoopJid: 'cone',
      });
      expect(events).toHaveLength(0);
    });
  });

  describe('listener error resilience', () => {
    it('does not break other listeners when one throws', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(() => { throw new Error('bad listener'); });
      follower.onEvent(e => events.push(e));

      channel.simulateLeaderMessage({
        type: 'agent_event',
        event: { type: 'turn_end', messageId: 'm1' },
        scoopJid: 'cone',
      });

      expect(events).toEqual([{ type: 'turn_end', messageId: 'm1' }]);
    });
  });

  describe('target advertising', () => {
    it('advertiseTargets sends correct message to leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.advertiseTargets(
        [{ targetId: 'tab1', title: 'Google', url: 'https://google.com' }],
        'follower-rt1',
      );

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Google', url: 'https://google.com' }],
        runtimeId: 'follower-rt1',
      });
    });
  });

  describe('target registry receiving', () => {
    it('receives targets.registry and stores entries', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const targets: TrayTargetEntry[] = [
        { targetId: 'leader:tab1', localTargetId: 'tab1', runtimeId: 'leader', title: 'Tab', url: 'https://example.com', isLocal: false },
      ];
      channel.simulateLeaderMessage({ type: 'targets.registry', targets });

      expect(follower.getTargets()).toEqual(targets);
    });

    it('returns empty array before any registry is received', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      expect(follower.getTargets()).toEqual([]);
    });

    it('calls onTargetsUpdated callback when registry arrives', () => {
      const channel = new FakeChannel();
      const onTargetsUpdated = vi.fn();
      const follower = new FollowerSyncManager(channel, { onTargetsUpdated });

      const targets: TrayTargetEntry[] = [
        { targetId: 'rt:t1', localTargetId: 't1', runtimeId: 'rt', title: 'Tab', url: 'https://example.com', isLocal: false },
      ];
      channel.simulateLeaderMessage({ type: 'targets.registry', targets });

      expect(onTargetsUpdated).toHaveBeenCalledWith(targets);
    });

    it('does not crash when onTargetsUpdated is not provided', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      // Should not throw
      channel.simulateLeaderMessage({
        type: 'targets.registry',
        targets: [{ targetId: 'rt:t1', localTargetId: 't1', runtimeId: 'rt', title: 'Tab', url: 'https://x.com', isLocal: false }],
      });

      expect(follower.getTargets()).toHaveLength(1);
    });

    it('replaces previous entries when new registry arrives', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'targets.registry',
        targets: [{ targetId: 'a:t1', localTargetId: 't1', runtimeId: 'a', title: 'Old', url: 'https://old.com', isLocal: false }],
      });
      channel.simulateLeaderMessage({
        type: 'targets.registry',
        targets: [{ targetId: 'b:t2', localTargetId: 't2', runtimeId: 'b', title: 'New', url: 'https://new.com', isLocal: false }],
      });

      const targets = follower.getTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0].title).toBe('New');
    });
  });

  describe('CDP routing', () => {
    it('handles incoming cdp.request — executes locally and returns response', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ sessionId: 'sess-local' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-1',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-1');
        expect(response.result).toEqual({ sessionId: 'sess-local' });
      }
    });

    it('handles incoming cdp.request — returns error when no browser transport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-2',
        localTargetId: 'tab1',
        method: 'Page.navigate',
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-2');
        expect(response.error).toBe('Follower has no browser transport');
      }
    });

    it('handles incoming cdp.request — returns error on transport failure', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('CDP timeout')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-3',
        localTargetId: 'tab1',
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-3');
        expect(response.error).toBe('CDP timeout');
      }
    });

    it('createRemoteTransport sends requests to leader via data channel', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');

      // Send a CDP command through the remote transport
      transport.send('Page.navigate', { url: 'https://example.com' });

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('cdp.request');
      if (sent[0].type === 'cdp.request') {
        expect((sent[0] as any).targetRuntimeId).toBe('leader');
        expect((sent[0] as any).localTargetId).toBe('tab1');
        expect((sent[0] as any).method).toBe('Page.navigate');
      }
    });

    it('routes incoming cdp.response to correct RemoteCDPTransport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');
      const promise = transport.send('Runtime.evaluate', { expression: '1+1' });

      // Get the requestId from the sent message
      const sent = channel.parseSent();
      const request = sent[0] as any;

      // Leader sends back a response
      channel.simulateLeaderMessage({
        type: 'cdp.response',
        requestId: request.requestId,
        result: { result: { value: 2 } },
      } as any);

      const result = await promise;
      expect(result).toEqual({ result: { value: 2 } });
    });

    it('routes incoming cdp.response error to correct RemoteCDPTransport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('other-follower', 'tab2');
      const promise = transport.send('Page.navigate', { url: 'chrome://crash' });

      const sent = channel.parseSent();
      const request = sent[0] as any;

      channel.simulateLeaderMessage({
        type: 'cdp.response',
        requestId: request.requestId,
        error: 'Target crashed',
      } as any);

      await expect(promise).rejects.toThrow('Target crashed');
    });

    it('removeRemoteTransport disconnects and cleans up', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('leader', 'tab1');
      expect(transport.state).toBe('connected');

      follower.removeRemoteTransport('leader', 'tab1');
      expect(transport.state).toBe('disconnected');
    });
  });

  describe('channel disconnect handling', () => {
    it('emits error event when channel closes', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(e => events.push(e));

      channel.simulateClose();

      expect(events).toEqual([{ type: 'error', error: 'Connection to leader lost' }]);
    });

    it('emits error event when channel errors', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      follower.onEvent(e => events.push(e));

      channel.simulateError();

      expect(events).toEqual([{ type: 'error', error: 'Connection to leader failed' }]);
    });
  });
});
