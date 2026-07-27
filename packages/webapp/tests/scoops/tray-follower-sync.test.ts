import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/core/agent-types.js';
import { resetLoggerDedupForTests } from '../../src/core/logger.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';
import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  TrayTargetEntry,
} from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';

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
    if (this.readyState === 'closed') {
      throw new Error('Cannot send on closed channel');
    }
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
    // The manager sends a `hello` version handshake on construction; filter it
    // out so per-feature assertions stay focused. Hello-specific tests read
    // the raw `sent` array instead.
    return this.sent
      .map((s) => JSON.parse(s) as FollowerToLeaderMessage)
      .filter((m) => m.type !== 'hello');
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

    it('strips local paths from path-only attachments before sending', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendMessage('check this', 'msg-2', [
        {
          id: 'a1',
          name: 'huge.bin',
          mimeType: 'application/octet-stream',
          size: 60_000_000,
          kind: 'file',
          path: '/tmp/attachment-follower-only',
        },
      ]);

      const sent = channel.parseSent() as Array<{
        attachments?: { path?: string; error?: string }[];
      }>;
      const sentAttachments = sent[0].attachments;
      expect(sentAttachments?.[0].path).toBeUndefined();
      expect(sentAttachments?.[0].error).toMatch(/remote runtime/);
    });

    it('strips local paths but keeps inline content for hybrid attachments', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendMessage('look', 'msg-3', [
        {
          id: 'a1',
          name: 'note.txt',
          mimeType: 'text/plain',
          size: 5,
          kind: 'text',
          text: 'hello',
          // Should never normally happen, but defend against it anyway.
          path: '/tmp/attachment-follower-local',
        },
      ]);

      const sent = channel.parseSent() as Array<{
        attachments?: { path?: string; text?: string }[];
      }>;
      expect(sent[0].attachments?.[0].path).toBeUndefined();
      expect(sent[0].attachments?.[0].text).toBe('hello');
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
      new FollowerSyncManager(channel, { onUserMessage });
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

  describe('cherry.slicc_event handling', () => {
    it('invokes onCherrySliccEvent with name, detail (wire targetId not forwarded)', () => {
      const channel = new FakeChannel();
      const onCherrySliccEvent = vi.fn();
      new FollowerSyncManager(channel, { onCherrySliccEvent });

      channel.simulateLeaderMessage({
        type: 'cherry.slicc_event',
        targetId: 'follower-abc',
        name: 'build.done',
        detail: { ok: true },
      });

      expect(onCherrySliccEvent).toHaveBeenCalledWith('build.done', { ok: true });
    });

    it('ignores cherry.slicc_event when no callback is wired', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      // Must not throw — falls through without a handler.
      expect(() =>
        channel.simulateLeaderMessage({
          type: 'cherry.slicc_event',
          targetId: 'follower-abc',
          name: 'noop',
        })
      ).not.toThrow();
      void follower;
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

  describe('requestNewSession', () => {
    it('sends new_session to leader with the action', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.requestNewSession('save');
      follower.requestNewSession('skip');
      follower.requestNewSession('erase');

      const sent = channel.parseSent();
      expect(sent).toEqual([
        { type: 'new_session', action: 'save' },
        { type: 'new_session', action: 'skip' },
        { type: 'new_session', action: 'erase' },
      ]);
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

    it('preview.open is dispatched through executeLocalTabOpen (same as tab.open)', async () => {
      const channel = new FakeChannel();
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'preview-tab' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const _follower = new FollowerSyncManager(channel, {
        browserTransport: fakeBrowserTransport,
      });

      channel.simulateLeaderMessage({
        type: 'preview.open',
        requestId: 'prv-1',
        url: 'https://abc--def.sliccy.now/index.html',
      } as any);

      await vi.waitFor(() => {
        expect(channel.parseSent().length).toBeGreaterThan(0);
      });

      // executeLocalTabOpen replies with tab.opened (regardless of whether the
      // inbound was tab.open or preview.open — they share the executor).
      const sent = channel.parseSent();
      const response = sent.find((m) => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('prv-1');
        expect(response.targetId).toBe('preview-tab');
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

  // ---------------------------------------------------------------------------
  // Sprinkle handling — mirrors the iOS follower (`AppState.swift`):
  // sprinkles.list → onSprinklesList; sprinkle.content → fetch promise (chunk
  // reassembly + dedupe + error rejection); sprinkle.update → onSprinkleUpdate;
  // outbound: refreshSprinkles / fetchSprinkleContent / sendSprinkleLick.
  // ---------------------------------------------------------------------------

  describe('scoops.list handling', () => {
    it('dispatches scoops.list to onScoopsList', () => {
      const channel = new FakeChannel();
      const onScoopsList = vi.fn();
      new FollowerSyncManager(channel, { onScoopsList });

      const scoops = [
        {
          jid: 'cone-jid',
          name: 'cone',
          folder: '/workspace',
          isCone: true,
          assistantLabel: 'sliccy',
        },
        {
          jid: 'scoop-1',
          name: 'research',
          folder: '/scoops/research',
          isCone: false,
          assistantLabel: 'research',
        },
      ];
      channel.simulateLeaderMessage({ type: 'scoops.list', scoops, activeScoopJid: 'cone-jid' });

      expect(onScoopsList).toHaveBeenCalledWith(scoops, 'cone-jid');
    });

    it('does not crash on scoops.list when no callback is registered', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel, {});

      expect(() =>
        channel.simulateLeaderMessage({ type: 'scoops.list', scoops: [], activeScoopJid: '' })
      ).not.toThrow();
    });
  });

  describe('sprinkle handling', () => {
    it('dispatches sprinkles.list to onSprinklesList', () => {
      const channel = new FakeChannel();
      const onSprinklesList = vi.fn();
      const follower = new FollowerSyncManager(channel, { onSprinklesList });

      const sprinkles = [
        {
          name: 'welcome',
          title: 'Welcome',
          path: '/shared/sprinkles/welcome.shtml',
          open: true,
          autoOpen: true,
        },
        {
          name: 'todo',
          title: 'Todo',
          path: '/workspace/sprinkles/todo.shtml',
          open: false,
          autoOpen: false,
        },
      ];
      channel.simulateLeaderMessage({ type: 'sprinkles.list', sprinkles });

      expect(onSprinklesList).toHaveBeenCalledWith(sprinkles);
      expect(follower.getSprinkles()).toEqual(sprinkles);
    });

    it('dispatches sprinkle.update to onSprinkleUpdate', () => {
      const channel = new FakeChannel();
      const onSprinkleUpdate = vi.fn();
      new FollowerSyncManager(channel, { onSprinkleUpdate });

      const data = { kind: 'progress', step: 'install', percent: 42 };
      channel.simulateLeaderMessage({ type: 'sprinkle.update', sprinkleName: 'welcome', data });

      expect(onSprinkleUpdate).toHaveBeenCalledWith('welcome', data);
    });

    it('refreshSprinkles sends sprinkles.refresh to the leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.refreshSprinkles();

      const sent = channel.parseSent();
      expect(sent).toEqual([{ type: 'sprinkles.refresh' }]);
    });

    it('sendSprinkleLick forwards lick to the leader with body and targetScoop', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendSprinkleLick('welcome', { action: 'click', data: { button: 'go' } }, 'scoop-1');

      const sent = channel.parseSent();
      expect(sent).toEqual([
        {
          type: 'sprinkle.lick',
          sprinkleName: 'welcome',
          body: { action: 'click', data: { button: 'go' } },
          targetScoop: 'scoop-1',
        },
      ]);
    });

    it('sendSprinkleLick omits targetScoop when not provided', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendSprinkleLick('welcome', { action: 'click' });

      const sent = channel.parseSent() as Array<Record<string, unknown>>;
      expect(sent[0].targetScoop).toBeUndefined();
    });

    it('forwardLick sends a generic lick to the leader and returns true', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const ok = follower.forwardLick({
        type: 'navigate',
        navigateUrl: 'https://x',
        timestamp: 't',
        body: { v: 1 },
      });
      expect(ok).toBe(true);
      expect(channel.parseSent()).toEqual([
        {
          type: 'lick',
          event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
        },
      ]);
    });

    it('forwardLick returns false and sends nothing when the channel is closed', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      channel.close();
      const ok = follower.forwardLick({
        type: 'navigate',
        navigateUrl: 'https://x',
        timestamp: 't',
        body: {},
      });
      expect(ok).toBe(false);
      expect(channel.parseSent()).toHaveLength(0);
    });

    it('fetchSprinkleContent sends sprinkle.fetch and resolves with single-chunk content', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('sprinkle.fetch');
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;
      expect(sent[0].sprinkleName).toBe('welcome');

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: '<p>Hello</p>',
      });

      await expect(pending).resolves.toBe('<p>Hello</p>');
    });

    it('fetchSprinkleContent reassembles chunked sprinkle.content responses', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: '<p>One',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: ' Two',
        chunkIndex: 1,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: ' Three</p>',
        chunkIndex: 2,
        totalChunks: 3,
      });

      await expect(pending).resolves.toBe('<p>One Two Three</p>');
    });

    it('fetchSprinkleContent handles out-of-order chunks', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      // Deliver chunks 2 → 0 → 1 to verify ordered reassembly.
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'C',
        chunkIndex: 2,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'B',
        chunkIndex: 1,
        totalChunks: 3,
      });

      await expect(pending).resolves.toBe('ABC');
    });

    it('fetchSprinkleContent rejects when sprinkle.content carries an error', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('missing');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'missing',
        content: '',
        error: 'Sprinkle not found: missing',
      });

      await expect(pending).rejects.toThrow('Sprinkle not found: missing');
    });

    it('fetchSprinkleContent dedupes concurrent calls for the same sprinkle', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      const second = follower.fetchSprinkleContent('welcome');

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1); // Only one outbound fetch.
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: '<p>Welcome</p>',
      });

      await expect(first).resolves.toBe('<p>Welcome</p>');
      await expect(second).resolves.toBe('<p>Welcome</p>');
    });

    it('fetchSprinkleContent caches resolved content and returns it without re-fetching', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'welcome',
        content: 'cached-content',
      });
      await expect(first).resolves.toBe('cached-content');

      // Second call should hit cache, not send another fetch.
      const second = follower.fetchSprinkleContent('welcome');
      await expect(second).resolves.toBe('cached-content');
      expect(channel.parseSent()).toHaveLength(1);
    });

    it('clearSprinkleCache forces the next fetchSprinkleContent to re-request from the leader', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('welcome');
      let sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[0].requestId,
        sprinkleName: 'welcome',
        content: 'v1',
      });
      await first;

      follower.clearSprinkleCache('welcome');
      const second = follower.fetchSprinkleContent('welcome');
      sent = channel.parseSent();
      expect(sent).toHaveLength(2); // Re-fetched.
      if (sent[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[1].requestId,
        sprinkleName: 'welcome',
        content: 'v2',
      });
      await expect(second).resolves.toBe('v2');
    });

    it('close rejects pending sprinkle fetches so callers do not hang', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');
      // Don't deliver a response.
      follower.close();

      await expect(pending).rejects.toThrow(/closed|disconnect/i);
    });

    // F-2: the standalone-follower path calls `fetchSprinkleContent`
    // without an external timeout wrapper (extension uses the panel
    // proxy's 15s timer instead). Without an internal timeout a stuck
    // leader would hold the controller's `opening` lock forever.
    it('fetchSprinkleContent times out after sprinkleFetchTimeoutMs when the leader never replies', async () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 1000 });
        const pending = follower
          .fetchSprinkleContent('stuck')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        await vi.advanceTimersByTimeAsync(1001);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.err.message).toMatch(/timed out after 1000ms/);

        // After timeout the lockstep maps must be empty so a re-fetch
        // for the same name issues a brand-new sprinkle.fetch.
        const before = channel.sent.length;
        const second = follower.fetchSprinkleContent('stuck');
        // Re-fetch sent (lockstep maps were cleaned up).
        expect(channel.sent.length).toBeGreaterThan(before);
        const sent = channel.parseSent();
        const lastSent = sent[sent.length - 1];
        if (lastSent.type !== 'sprinkle.fetch') throw new Error('expected sprinkle.fetch');
        // Resolve the second fetch so the test can shut down cleanly.
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: lastSent.requestId,
          sprinkleName: 'stuck',
          content: '<p>finally</p>',
        });
        await expect(second).resolves.toBe('<p>finally</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('fetchSprinkleContent timeout does not reject sibling waiters that joined the same fetch', async () => {
      // Two concurrent callers latch onto a single in-flight request.
      // When the FIRST caller's wrapper times out, only that promise
      // should reject — the second caller's timer is still running and
      // its waiter is preserved (the cancel only fires when the LAST
      // waiter gives up).
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 2000 });

        // First caller: timer set at t=0, fires at t=2000.
        const first = follower
          .fetchSprinkleContent('big')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        // Second caller joins 500ms later: timer set at t=500, fires at t=2500.
        await vi.advanceTimersByTimeAsync(500);
        const second = follower
          .fetchSprinkleContent('big')
          .then((c) => ({ ok: true as const, c }))
          .catch((err: Error) => ({ ok: false as const, err }));

        // Advance past first deadline, before second.
        await vi.advanceTimersByTimeAsync(1501); // now t=2001
        const firstResult = await first;
        expect(firstResult.ok).toBe(false);

        // Sibling still in-flight — deliver content.
        const sent = channel.parseSent();
        const fetchMsg = sent.find((m) => m.type === 'sprinkle.fetch');
        if (fetchMsg?.type !== 'sprinkle.fetch') {
          throw new Error('expected sprinkle.fetch');
        }
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: fetchMsg.requestId,
          sprinkleName: 'big',
          content: '<p>arrived just in time</p>',
        });

        const secondResult = await second;
        expect(secondResult.ok).toBe(true);
        if (!secondResult.ok) throw new Error('unreachable');
        expect(secondResult.c).toBe('<p>arrived just in time</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('handleDisconnect (via channel close) rejects pending sprinkle fetches', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('welcome');
      channel.simulateClose();

      await expect(pending).rejects.toThrow(/closed|disconnect/i);
    });

    // F-1: prior to this PR's cleanup pass, `close()` and
    // `handleDisconnect()` only rejected sprinkle waiters. Pending
    // `openRemoteTab` and `sendFsRequest` callers would hang forever
    // when the leader disconnected, because a fresh
    // `FollowerSyncManager` is constructed on reconnect and the
    // original resolvers never resolve. These guard the symmetry.
    it('close rejects pending openRemoteTab callers so they do not hang on reconnect', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower
        .openRemoteTab('follower-1', 'https://example.test')
        .then((id) => ({ ok: true as const, id }))
        .catch((err: Error) => ({ ok: false as const, err }));
      follower.close();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/closed|disconnect/i);
    });

    it('manual close() is idempotent and does not trigger handleDisconnect side effects (status flip, onDisconnect)', () => {
      // B-1: prior to gating `close()` with the same `disconnected`
      // flag `handleDisconnect` uses, a channel-close event after a
      // manual close would re-run handleDisconnect — flipping global
      // follower status to `error`, emitting an `error` event, and
      // firing the `onDisconnect` callback that drives reconnect
      // logic. Verify the gate.
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const onDeadFn = vi.fn();
      const follower = new FollowerSyncManager(channel, {
        onDisconnect,
        onDead: onDeadFn,
      });

      follower.close();
      // Simulate the underlying RTCDataChannel firing its `close` event
      // shortly after our explicit teardown — the gate should swallow
      // the re-entry into handleDisconnect.
      channel.simulateClose();

      expect(onDisconnect).not.toHaveBeenCalled();

      // A second manual close is also a no-op.
      expect(() => follower.close()).not.toThrow();
    });

    it('FollowerSyncManager throws when constructed with a negative or non-finite sprinkleFetchTimeoutMs', () => {
      // F-validate-timeout: `0` is the explicit "disabled" sentinel,
      // but anything else (NaN, Infinity, negative) used to silently
      // disable via the `timeoutMs > 0` runtime guard. Validate at
      // construction so the contract is honest.
      const channel = new FakeChannel();
      expect(() => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: -1 })).toThrow(
        RangeError
      );
      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: Number.NaN })
      ).toThrow(RangeError);
      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: Number.POSITIVE_INFINITY })
      ).toThrow(RangeError);
      // `0` is the explicit disable sentinel — accepted.
      expect(() => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 0 })).not.toThrow();
      // Positive values pass.
      expect(
        () => new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 1000 })
      ).not.toThrow();
    });

    it('sprinkleFetchTimeoutMs: 0 disables the timer (fetchSprinkleContent never rejects on time)', async () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, { sprinkleFetchTimeoutMs: 0 });
        let state: 'pending' | 'resolved' | 'rejected' = 'pending';
        let value: string | undefined;
        let error: Error | undefined;
        const pending = follower.fetchSprinkleContent('forever').then(
          (c) => {
            state = 'resolved';
            value = c;
          },
          (err: Error) => {
            state = 'rejected';
            error = err;
          }
        );

        // Advance by 25 s — past the default 15 s sprinkle timeout but
        // safely under the 30 s keepalive-dead threshold (10 s interval
        // × 3 missed pongs). The promise must still be pending.
        await vi.advanceTimersByTimeAsync(25_000);
        expect(state).toBe('pending');

        // Resolve via leader reply so the test exits cleanly.
        const sent = channel.parseSent();
        const fetchMsg = sent.find((m) => m.type === 'sprinkle.fetch');
        if (fetchMsg?.type !== 'sprinkle.fetch') {
          throw new Error('expected sprinkle.fetch');
        }
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: fetchMsg.requestId,
          sprinkleName: 'forever',
          content: '<p>resolved</p>',
        });
        await pending;
        // Make the failure mode explicit if the timeout did fire after all.
        expect({ state, error: error?.message }).toEqual({ state: 'resolved', error: undefined });
        expect(value).toBe('<p>resolved</p>');
      } finally {
        vi.useRealTimers();
      }
    });

    it('close rejects in-flight RemoteCDPTransport.send() calls (federated CDP cleanup)', async () => {
      // The F-1 cleanup docstring claims `transport.disconnect()` is
      // walked on close. Verify the wiring end-to-end: a CDP request
      // through a transport created via `createRemoteTransport` must
      // reject when the FollowerSyncManager closes, with no pending
      // resolver left dangling.
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);
      const transport = follower.createRemoteTransport('follower-1', 'tab-1');
      const pending = transport
        .send('Page.navigate', { url: 'https://example.test' })
        .then((r) => ({ ok: true as const, r }))
        .catch((err: Error) => ({ ok: false as const, err }));
      follower.close();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/transport disconnected/i);
      // State assertion: the transport itself reports disconnected.
      expect(transport.state).toBe('disconnected');
    });

    it('handleDisconnect rejects pending sendFsRequest callers symmetrically', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower
        .sendFsRequest('follower-1', {
          op: 'readFile',
          path: '/workspace/x',
        })
        .then((r) => ({ ok: true as const, r }))
        .catch((err: Error) => ({ ok: false as const, err }));
      channel.simulateClose();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.err.message).toMatch(/closed|disconnect/i);
    });

    it('does not crash on sprinkles.list when no callback is registered', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({ type: 'sprinkles.list', sprinkles: [] })
      ).not.toThrow();
    });

    it('does not crash on sprinkle.update when no callback is registered', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({ type: 'sprinkle.update', sprinkleName: 'x', data: {} })
      ).not.toThrow();
    });

    it('drops sprinkle.content that does not match a pending fetch (no crash)', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId: 'stale',
          sprinkleName: 'gone',
          content: 'ignored',
        })
      ).not.toThrow();
    });

    // C4: the chunked branch used to silently create a buffer for an unknown
    // requestId, accumulate chunks, and on completion write the assembled
    // content into `sprinkleContentCache` — even though no waiter existed.
    // A misbehaving (or replaying) leader could then poison the cache. The
    // fix mirrors the non-chunked guard: drop unsolicited deliveries.
    it('drops chunked sprinkle.content for an unknown requestId without poisoning the cache', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      // No pending fetch — deliver chunked content anyway.
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: 'stale',
        sprinkleName: 'gone',
        content: 'poison-1',
        chunkIndex: 0,
        totalChunks: 1,
      });

      // A subsequent legitimate fetch for the same sprinkle name must go on
      // the wire — the cache must not have been pre-populated by the stale
      // delivery.
      const pending = follower.fetchSprinkleContent('gone');
      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('sprinkle.fetch');
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[0].requestId,
        sprinkleName: 'gone',
        content: 'fresh',
      });
      await expect(pending).resolves.toBe('fresh');
    });

    it('drops chunked sprinkle.content with chunkIndex out of bounds', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      void follower.fetchSprinkleContent('x').catch(() => {});
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      // Misbehaving leader: chunkIndex equals totalChunks (out of [0, total)).
      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId,
          sprinkleName: 'x',
          content: 'bad',
          chunkIndex: 5,
          totalChunks: 3,
        })
      ).not.toThrow();
      // Also negative chunkIndex.
      expect(() =>
        channel.simulateLeaderMessage({
          type: 'sprinkle.content',
          requestId,
          sprinkleName: 'x',
          content: 'bad',
          chunkIndex: -1,
          totalChunks: 3,
        })
      ).not.toThrow();
    });

    it('does not double-count duplicate chunks (idempotent)', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const pending = follower.fetchSprinkleContent('big');
      const sent = channel.parseSent();
      if (sent[0].type !== 'sprinkle.fetch') throw new Error('unreachable');
      const requestId = sent[0].requestId;

      // Duplicate chunk 0 should NOT advance the completion count toward 3.
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A',
        chunkIndex: 0,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'A-dup',
        chunkIndex: 0,
        totalChunks: 3,
      });
      // Promise must NOT have resolved yet (only 1 of 3 unique chunks).
      let resolved = false;
      void pending.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'B',
        chunkIndex: 1,
        totalChunks: 3,
      });
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId,
        sprinkleName: 'big',
        content: 'C',
        chunkIndex: 2,
        totalChunks: 3,
      });
      await expect(pending).resolves.toBe('ABC');
    });
  });

  // ---------------------------------------------------------------------------
  // Default case + last-error replay (suggestions S2 / I5 from the PR review).
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // R2-IMP-2: cancelSprinkleFetch — rejects pending waiters so a stuck
  // leader doesn't accumulate them across panel retries.
  // R2-IMP-3: sprinkles.list invalidates `sprinkleContentCache` so a
  // late-arriving content reply (after the panel timed out) can't poison
  // the cache permanently.
  // ---------------------------------------------------------------------------

  describe('R2-IMP-2: cancelSprinkleFetch', () => {
    it('rejects every pending waiter for the named sprinkle', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const second = follower.fetchSprinkleContent('x'); // shares the same waiter list

      follower.cancelSprinkleFetch('x', 'panel timeout');

      await expect(first).rejects.toThrow(/panel timeout/);
      await expect(second).rejects.toThrow(/panel timeout/);
    });

    it('does not affect waiters for other sprinkles', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const x = follower.fetchSprinkleContent('x');
      const y = follower.fetchSprinkleContent('y');

      follower.cancelSprinkleFetch('x');

      const ySent = channel
        .parseSent()
        .find((m) => m.type === 'sprinkle.fetch' && m.sprinkleName === 'y');
      if (ySent?.type !== 'sprinkle.fetch') throw new Error('unreachable');

      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: ySent.requestId,
        sprinkleName: 'y',
        content: 'y-ok',
      });

      await expect(x).rejects.toThrow(/cancelled/);
      await expect(y).resolves.toBe('y-ok');
    });

    it('subsequent fetch for the cancelled sprinkle goes back on the wire', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      follower.cancelSprinkleFetch('x');
      const second = follower.fetchSprinkleContent('x');

      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2); // cancel did NOT issue a wire fetch — only the two real calls did
      await expect(first).rejects.toThrow();
      // Second fetch is still pending — we don't have to resolve it for this test.
      void second;
    });

    it('a late sprinkle.content for a cancelled requestId is dropped (does not poison cache)', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const firstSent = channel.parseSent()[0];
      if (firstSent.type !== 'sprinkle.fetch') throw new Error('unreachable');
      follower.cancelSprinkleFetch('x');
      await expect(first).rejects.toThrow();

      // Leader is still trying to reply. The unknown-requestId guard
      // (R2-CRIT C4 fix) drops the late content.
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: firstSent.requestId,
        sprinkleName: 'x',
        content: 'stale',
      });

      // A fresh fetch must go back on the wire — not return cached stale.
      const second = follower.fetchSprinkleContent('x');
      const sent = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(sent).toHaveLength(2);
      if (sent[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent[1].requestId,
        sprinkleName: 'x',
        content: 'fresh',
      });
      await expect(second).resolves.toBe('fresh');
    });
  });

  describe('R2-IMP-3: sprinkles.list invalidates sprinkleContentCache', () => {
    it('drops cached content for sprinkles named in the new list', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      // Prime the cache with a successful fetch.
      const first = follower.fetchSprinkleContent('welcome');
      const sent1 = channel.parseSent()[0];
      if (sent1.type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent1.requestId,
        sprinkleName: 'welcome',
        content: 'v1',
      });
      await expect(first).resolves.toBe('v1');

      // Confirm the cache hit by issuing another fetch with no new wire.
      await expect(follower.fetchSprinkleContent('welcome')).resolves.toBe('v1');
      expect(channel.parseSent().filter((m) => m.type === 'sprinkle.fetch')).toHaveLength(1);

      // Leader broadcasts a new list including 'welcome' — cache MUST drop.
      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false }],
      });

      // Next fetch goes back on the wire.
      const second = follower.fetchSprinkleContent('welcome');
      const sent2 = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(sent2).toHaveLength(2);
      if (sent2[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent2[1].requestId,
        sprinkleName: 'welcome',
        content: 'v2',
      });
      await expect(second).resolves.toBe('v2');
    });

    it('R3-IMP: cache write that races a sprinkles.list broadcast is discarded', async () => {
      // Scenario: a fetch is in-flight when `sprinkles.list` arrives. The
      // late `sprinkle.content` reply must NOT overwrite the cache —
      // otherwise the next fetcher gets pre-list stale content forever.
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('x');
      const sent1 = channel.parseSent()[0];
      if (sent1.type !== 'sprinkle.fetch') throw new Error('unreachable');

      // Leader broadcasts a fresh list BEFORE the first reply comes back.
      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'x', title: 'X', path: '/x.shtml', open: true, autoOpen: false }],
      });

      // The original reply arrives — must resolve waiters but must NOT
      // write the cache (content is from before the list barrier).
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent1.requestId,
        sprinkleName: 'x',
        content: 'stale-v1',
      });
      await expect(first).resolves.toBe('stale-v1');

      // A subsequent fetch must go on the wire — cache must NOT have
      // been populated by the racing reply.
      const second = follower.fetchSprinkleContent('x');
      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2);
      if (fetches[1].type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: fetches[1].requestId,
        sprinkleName: 'x',
        content: 'fresh-v2',
      });
      await expect(second).resolves.toBe('fresh-v2');
    });

    it('also drops cache entries for sprinkles that disappeared from the list', async () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      const first = follower.fetchSprinkleContent('gone');
      const sent = channel.parseSent()[0];
      if (sent.type !== 'sprinkle.fetch') throw new Error('unreachable');
      channel.simulateLeaderMessage({
        type: 'sprinkle.content',
        requestId: sent.requestId,
        sprinkleName: 'gone',
        content: 'cached',
      });
      await first;

      // Leader broadcasts a list that does NOT include 'gone'.
      channel.simulateLeaderMessage({
        type: 'sprinkles.list',
        sprinkles: [{ name: 'other', title: 'O', path: '/o.shtml', open: false, autoOpen: false }],
      });

      // A future fetch for 'gone' must NOT return the stale cached value.
      const second = follower.fetchSprinkleContent('gone');
      const fetches = channel.parseSent().filter((m) => m.type === 'sprinkle.fetch');
      expect(fetches).toHaveLength(2);
      void second;
    });
  });

  describe('sendCherryHostEvent', () => {
    it('sends a cherry.host_event stamped with the configured selfRuntimeId', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel, { selfRuntimeId: 'rt-9' });

      follower.sendCherryHostEvent('checkout-done', { id: 7 });

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'cherry.host_event',
        targetId: 'rt-9',
        name: 'checkout-done',
        detail: { id: 7 },
      });
    });

    it('falls back to an empty targetId when no selfRuntimeId is set', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendCherryHostEvent('ping');

      const sent = channel.parseSent() as Array<{ type: string; targetId: string }>;
      expect(sent[0].type).toBe('cherry.host_event');
      expect(sent[0].targetId).toBe('');
    });
  });

  describe('version handshake', () => {
    it('sends hello with the protocol version as its first message', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel, { selfRuntimeId: 'follower-1' });

      const first = JSON.parse(channel.sent[0]) as {
        type: string;
        protocolVersion: number;
        runtime?: string;
      };
      expect(first.type).toBe('hello');
      expect(first.protocolVersion).toBe(3);
      expect(first.runtime).toBe('follower-1');
    });

    it('warns when the leader speaks a newer protocol version', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        channel.simulateLeaderMessage({ type: 'hello', protocolVersion: 999 });
        const warned = warnSpy.mock.calls.flat().map(String).join(' ');
        expect(warned).toContain('newer tray sync protocol');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('diagnoses a legacy leader once when the first message is not hello', () => {
      // Earlier tests in this file also trip the legacy diagnosis; clear the
      // module-global dedup buffer so this instance's log is not suppressed.
      resetLoggerDedupForTests();
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      try {
        channel.simulateLeaderMessage({ type: 'status', scoopStatus: 'idle' });
        channel.simulateLeaderMessage({ type: 'status', scoopStatus: 'idle' });
        const infos = infoSpy.mock.calls.flat().map(String).join('\n');
        const matches = infos.match(/legacy peer \(pre-versioning build\)/g) ?? [];
        expect(matches).toHaveLength(1);
      } finally {
        infoSpy.mockRestore();
      }
    });
  });

  describe('protocol drift safety', () => {
    it('warns but does not throw on an unknown leader message type', () => {
      const channel = new FakeChannel();
      new FollowerSyncManager(channel);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(() =>
          channel.simulateLeaderMessage({
            // Intentionally invent a type the switch does not handle.
            type: 'future.feature' as unknown as 'snapshot',
            messages: [],
            scoopJid: '',
          } as never)
        ).not.toThrow();
        const warned = warnSpy.mock.calls.flat().map(String).join(' ');
        expect(warned).toContain('Unknown leader message type');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
