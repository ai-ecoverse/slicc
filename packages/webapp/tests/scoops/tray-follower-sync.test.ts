import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';
import {
  setFollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';
import type { AgentEvent, ChatMessage } from '../../src/ui/types.js';
import type {
  LeaderToFollowerMessage,
  FollowerToLeaderMessage,
  TrayTargetEntry,
} from '../../src/scoops/tray-sync-protocol.js';

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
    return this.sent.map((s) => JSON.parse(s));
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

    it('sends attachments with user_message payloads', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
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

      follower.sendMessage('hello', 'msg-1', attachments);

      const sent = channel.parseSent();
      expect(sent[0]).toEqual({
        type: 'user_message',
        text: 'hello',
        messageId: 'msg-1',
        attachments,
      });
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
      follower.onEvent((e) => events.push(e));

      const event: AgentEvent = { type: 'content_delta', messageId: 'm1', text: 'chunk' };
      channel.simulateLeaderMessage({ type: 'agent_event', event, scoopJid: 'cone' });

      expect(events).toEqual([event]);
    });

    it('unsubscribe removes the listener', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const events: AgentEvent[] = [];
      const unsub = follower.onEvent((e) => events.push(e));

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
      follower.onEvent((e) => events.push(e));

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

      expect(onUserMessage).toHaveBeenCalledWith('hello from leader', 'msg-42', 'cone', undefined);
    });

    it('passes user_message_echo attachments to onUserMessage', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });
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

      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from leader',
        messageId: 'msg-42',
        scoopJid: 'cone',
        attachments,
      });

      expect(onUserMessage).toHaveBeenCalledWith(
        'hello from leader',
        'msg-42',
        'cone',
        attachments
      );
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
      expect(onUserMessage).toHaveBeenCalledWith('hello from leader', 'msg-456', 'cone', undefined);
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
      expect(onUserMessage).toHaveBeenCalledWith('repeat test', 'msg-789', 'cone', undefined);
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
      follower.onEvent((e) => events.push(e));

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
      follower.onEvent(() => {
        throw new Error('bad listener');
      });
      follower.onEvent((e) => events.push(e));

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
        'follower-rt1'
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
        {
          targetId: 'leader:tab1',
          localTargetId: 'tab1',
          runtimeId: 'leader',
          title: 'Tab',
          url: 'https://example.com',
          isLocal: false,
        },
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
        {
          targetId: 'rt:t1',
          localTargetId: 't1',
          runtimeId: 'rt',
          title: 'Tab',
          url: 'https://example.com',
          isLocal: false,
        },
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
        targets: [
          {
            targetId: 'rt:t1',
            localTargetId: 't1',
            runtimeId: 'rt',
            title: 'Tab',
            url: 'https://x.com',
            isLocal: false,
          },
        ],
      });

      expect(follower.getTargets()).toHaveLength(1);
    });

    it('replaces previous entries when new registry arrives', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'targets.registry',
        targets: [
          {
            targetId: 'a:t1',
            localTargetId: 't1',
            runtimeId: 'a',
            title: 'Old',
            url: 'https://old.com',
            isLocal: false,
          },
        ],
      });
      channel.simulateLeaderMessage({
        type: 'targets.registry',
        targets: [
          {
            targetId: 'b:t2',
            localTargetId: 't2',
            runtimeId: 'b',
            title: 'New',
            url: 'https://new.com',
            isLocal: false,
          },
        ],
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
      const response = sent.find((m) => m.type === 'cdp.response');
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
      const response = sent.find((m) => m.type === 'cdp.response');
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
      const response = sent.find((m) => m.type === 'cdp.response');
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

  describe('tab.open handling', () => {
    it('handles incoming tab.open — creates local tab and sends tab.opened', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'local-new-tab' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-1',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('tabopen-1');
        expect(response.targetId).toBe('local-new-tab');
      }
    });

    it('handles incoming tab.open — returns error when no browser transport', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-2',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-2');
        expect(response.error).toBe('Follower has no browser transport');
      }
    });

    it('handles incoming tab.open — returns error on transport failure', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('Target creation failed')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-3',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-3');
        expect(response.error).toBe('Target creation failed');
      }
    });

    it('calls onTargetsChanged after successfully creating a local tab', async () => {
      const channel = new FakeChannel();
      const onTargetsChanged = vi.fn();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'new-tab-id' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
        onTargetsChanged,
      });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-cb',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'tab.opened')).toBe(true);
      });

      expect(onTargetsChanged).toHaveBeenCalledTimes(1);
    });

    it('does not call onTargetsChanged when tab creation fails', async () => {
      const channel = new FakeChannel();
      const onTargetsChanged = vi.fn();
      const fakeBrowserTransport = {
        send: vi.fn().mockRejectedValue(new Error('Creation failed')),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
        onTargetsChanged,
      });

      channel.simulateLeaderMessage({
        type: 'tab.open',
        requestId: 'tabopen-fail',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'tab.open.error')).toBe(true);
      });

      expect(onTargetsChanged).not.toHaveBeenCalled();
    });

    it('openRemoteTab sends request and resolves on tab.opened', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.openRemoteTab('leader', 'https://remote.com');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('tab.open');
      if (sent[0].type === 'tab.open') {
        expect((sent[0] as any).targetRuntimeId).toBe('leader');
        expect((sent[0] as any).url).toBe('https://remote.com');

        channel.simulateLeaderMessage({
          type: 'tab.opened',
          requestId: (sent[0] as any).requestId,
          targetId: 'leader:new-tab-1',
        } as any);
      }

      const targetId = await promise;
      expect(targetId).toBe('leader:new-tab-1');
    });

    it('openRemoteTab rejects on tab.open.error', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const promise = follower.openRemoteTab('unknown', 'https://remote.com');

      const sent = channel.parseSent();
      if (sent[0].type === 'tab.open') {
        channel.simulateLeaderMessage({
          type: 'tab.open.error',
          requestId: (sent[0] as any).requestId,
          error: 'Target runtime "unknown" not connected',
        } as any);
      }

      await expect(promise).rejects.toThrow('not connected');
    });
  });

  describe('pong updates lastPingTime', () => {
    beforeEach(() => {
      setFollowerTrayRuntimeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-1',
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
        attachAttempts: 0,
        lastAttachCode: null,
        connectingSince: null,
        lastError: null,
      });
    });

    it('sets lastPingTime when a pong is received from the leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const before = Date.now();
      channel.simulateLeaderMessage({ type: 'pong' } as any);
      const after = Date.now();

      const status = getFollowerTrayRuntimeStatus();
      expect(status.lastPingTime).toBeGreaterThanOrEqual(before);
      expect(status.lastPingTime).toBeLessThanOrEqual(after);
    });
  });

  describe('CDP event forwarding', () => {
    it('forwards CDP events for remote-initiated sessions to the leader', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Target.attachToTarget')
            return Promise.resolve({ sessionId: 'sess-remote' });
          return Promise.resolve({});
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Simulate remote CDP request: leader attaches to a follower tab
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      // Event listeners should have been registered on the local transport
      expect(fakeBrowserTransport.on).toHaveBeenCalled();

      channel.sent.length = 0;

      // Simulate a Page.frameNavigated event from the local browser for the remote session
      for (const listener of eventListeners.get('Page.frameNavigated') ?? []) {
        (listener as (params: Record<string, unknown>) => void)({
          sessionId: 'sess-remote',
          frame: { url: 'https://navigated.com', id: 'main' },
        });
      }

      // The follower should have forwarded the event to the leader
      const sent = channel.parseSent();
      const eventMsg = sent.find((m) => m.type === 'cdp.event');
      expect(eventMsg).toBeDefined();
      if (eventMsg && eventMsg.type === 'cdp.event') {
        expect(eventMsg.method).toBe('Page.frameNavigated');
        expect(eventMsg.sessionId).toBe('sess-remote');
        expect((eventMsg as any).params.frame).toEqual({
          url: 'https://navigated.com',
          id: 'main',
        });
        // sessionId should NOT be in the forwarded params (it's at message level)
        expect((eventMsg as any).params.sessionId).toBeUndefined();
      }
    });

    it('does NOT forward events for non-remote sessions', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Target.attachToTarget')
            return Promise.resolve({ sessionId: 'sess-remote' });
          return Promise.resolve({});
        }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Remote session attach
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      channel.sent.length = 0;

      // Fire event for a DIFFERENT session (the follower's own browsing)
      for (const listener of eventListeners.get('Page.frameNavigated') ?? []) {
        (listener as (params: Record<string, unknown>) => void)({
          sessionId: 'sess-local-own',
          frame: { url: 'https://local.com', id: 'main' },
        });
      }

      // Should NOT forward the event
      const sent = channel.parseSent();
      expect(sent.filter((m) => m.type === 'cdp.event')).toHaveLength(0);
    });

    it('cleans up event forwarding on close', async () => {
      const channel = new FakeChannel();
      const eventListeners = new Map<string, Set<Function>>();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ sessionId: 'sess-remote' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn((event: string, listener: Function) => {
          if (!eventListeners.has(event)) eventListeners.set(event, new Set());
          eventListeners.get(event)!.add(listener);
        }),
        off: vi.fn((event: string, listener: Function) => {
          eventListeners.get(event)?.delete(listener);
        }),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const follower = new FollowerSyncManager(channel, { browserTransport: fakeBrowserTransport });

      // Remote session attach
      channel.simulateLeaderMessage({
        type: 'cdp.request',
        requestId: 'req-attach',
        localTargetId: 'tab1',
        method: 'Target.attachToTarget',
        params: { targetId: 'tab1', flatten: true },
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().some((m) => m.type === 'cdp.response')).toBe(true);
      });

      // Verify listeners were registered
      expect(fakeBrowserTransport.on).toHaveBeenCalled();
      const onCallCount = fakeBrowserTransport.on.mock.calls.length;

      // Close the follower
      follower.close();

      // off() should have been called to remove all registered listeners
      expect(fakeBrowserTransport.off).toHaveBeenCalledTimes(onCallCount);
    });

    it('routes cdp.event from leader to RemoteCDPTransport', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const transport = follower.createRemoteTransport('other-runtime', 'tab2');

      // Register an event listener on the remote transport
      const events: Record<string, unknown>[] = [];
      transport.on('Page.frameNavigated', (params) => events.push(params));

      // Simulate leader forwarding a cdp.event
      channel.simulateLeaderMessage({
        type: 'cdp.event',
        method: 'Page.frameNavigated',
        params: { frame: { url: 'https://remote-navigated.com', id: 'main' } },
        sessionId: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ frame: { url: 'https://remote-navigated.com', id: 'main' } });
    });
  });

  describe('channel disconnect handling', () => {
    beforeEach(() => {
      setFollowerTrayRuntimeStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-1',
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
        attachAttempts: 0,
        lastAttachCode: null,
        connectingSince: null,
        lastError: null,
      });
    });

    it('emits error event and updates status when channel closes', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const follower = new FollowerSyncManager(channel, { onDisconnect });
      const events: AgentEvent[] = [];
      follower.onEvent((e) => events.push(e));

      channel.simulateClose();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const status = getFollowerTrayRuntimeStatus();
      expect(status.state).toBe('error');
      expect(status.error).toBe('Data channel closed');
      expect(onDisconnect).toHaveBeenCalledWith('Data channel closed');
    });

    it('emits error event and updates status when channel errors', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const follower = new FollowerSyncManager(channel, { onDisconnect });
      const events: AgentEvent[] = [];
      follower.onEvent((e) => events.push(e));

      channel.simulateError();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const status = getFollowerTrayRuntimeStatus();
      expect(status.state).toBe('error');
      expect(status.error).toBe('Data channel error');
      expect(onDisconnect).toHaveBeenCalledWith('Data channel error');
    });

    it('handles disconnect only once (dedup)', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const follower = new FollowerSyncManager(channel, { onDisconnect });
      const events: AgentEvent[] = [];
      follower.onEvent((e) => events.push(e));

      // Trigger two disconnects — only first should fire
      channel.simulateClose();
      channel.simulateError();

      expect(events).toHaveLength(1);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('calls onDisconnect when keepalive declares dead', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onDead = vi.fn();
        const onDisconnect = vi.fn();
        const follower = new FollowerSyncManager(channel, { onDead, onDisconnect });

        // Let keepalive tick enough times to declare dead (default: 10s interval, 3 missed)
        // 4 ticks: first sends ping, then 3 misses
        vi.advanceTimersByTime(10_000); // tick 1: ping sent
        vi.advanceTimersByTime(10_000); // tick 2: missed=1
        vi.advanceTimersByTime(10_000); // tick 3: missed=2
        vi.advanceTimersByTime(10_000); // tick 4: missed=3 → dead

        expect(onDead).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledTimes(1);
        expect(onDisconnect).toHaveBeenCalledWith('Keepalive timeout — leader not responding');

        const status = getFollowerTrayRuntimeStatus();
        expect(status.state).toBe('error');
        expect(status.error).toBe('Keepalive timeout — leader not responding');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
