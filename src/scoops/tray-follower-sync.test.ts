import { describe, expect, it, vi } from 'vitest';

import { FollowerSyncManager } from './tray-follower-sync.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { LeaderToFollowerMessage, FollowerToLeaderMessage } from './tray-sync-protocol.js';

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
