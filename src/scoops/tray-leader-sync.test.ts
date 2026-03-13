import { describe, expect, it, vi } from 'vitest';

import { LeaderSyncManager, type LeaderSyncManagerOptions } from './tray-leader-sync.js';
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

  simulateMessage(msg: FollowerToLeaderMessage): void {
    const data = JSON.stringify(msg);
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  parseSent(): LeaderToFollowerMessage[] {
    return this.sent.map(s => JSON.parse(s));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatMessage(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

function createManager(overrides?: Partial<LeaderSyncManagerOptions>) {
  const messages: ChatMessage[] = [
    makeChatMessage('m1', 'user', 'hello'),
    makeChatMessage('m2', 'assistant', 'hi there'),
  ];
  const onFollowerMessage = vi.fn();
  const onFollowerAbort = vi.fn();
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [...messages],
    getScoopJid: () => 'cone',
    onFollowerMessage,
    onFollowerAbort,
    ...(overrides ?? {}),
  };
  const manager = new LeaderSyncManager(options);
  return { manager, messages, onFollowerMessage, onFollowerAbort };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LeaderSyncManager', () => {
  it('sends a snapshot on addFollower', () => {
    const { manager, messages } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const sent = channel.parseSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('snapshot');
    if (sent[0].type === 'snapshot') {
      expect(sent[0].scoopJid).toBe('cone');
      expect(sent[0].messages).toEqual(messages);
    }
  });

  it('broadcasts agent events to all followers', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    const event: AgentEvent = { type: 'content_delta', messageId: 'msg1', text: 'chunk' };
    manager.broadcastEvent(event);

    // Each channel gets snapshot (1) + event (1) = 2 messages
    const sent1 = ch1.parseSent();
    const sent2 = ch2.parseSent();
    expect(sent1).toHaveLength(2);
    expect(sent2).toHaveLength(2);
    expect(sent1[1]).toEqual({ type: 'agent_event', event, scoopJid: 'cone' });
    expect(sent2[1]).toEqual({ type: 'agent_event', event, scoopJid: 'cone' });
  });

  it('broadcasts status changes to all followers', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    manager.broadcastStatus('processing');

    const sent = channel.parseSent();
    expect(sent[1]).toEqual({ type: 'status', scoopStatus: 'processing' });
  });

  it('does not broadcast when no followers are connected', () => {
    const { manager } = createManager();
    // Should not throw
    manager.broadcastEvent({ type: 'content_delta', messageId: 'msg1', text: 'chunk' });
    manager.broadcastStatus('ready');
  });

  it('handles follower user_message', () => {
    const { manager, onFollowerMessage } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    channel.simulateMessage({ type: 'user_message', text: 'from follower', messageId: 'fm1' });

    expect(onFollowerMessage).toHaveBeenCalledWith('from follower', 'fm1');
  });

  it('handles follower abort', () => {
    const { manager, onFollowerAbort } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    channel.simulateMessage({ type: 'abort' });

    expect(onFollowerAbort).toHaveBeenCalled();
  });

  it('handles follower request_snapshot by resending current state', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    // Clear initial snapshot
    channel.sent.length = 0;

    channel.simulateMessage({ type: 'request_snapshot' });

    const sent = channel.parseSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('snapshot');
  });

  it('removeFollower cleans up and stops broadcasting to it', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);
    channel.sent.length = 0;

    manager.removeFollower('b1');
    manager.broadcastEvent({ type: 'content_delta', messageId: 'msg1', text: 'chunk' });

    expect(channel.sent).toHaveLength(0);
    expect(manager.hasFollowers).toBe(false);
  });

  it('addFollower replaces existing connection for same bootstrapId', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b1', ch2);

    // ch1 should be closed
    expect(ch1.readyState).toBe('closed');
    // ch2 should have the snapshot
    expect(ch2.parseSent()).toHaveLength(1);
    expect(manager.hasFollowers).toBe(true);
  });

  it('stop removes all followers', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    manager.stop();

    expect(ch1.readyState).toBe('closed');
    expect(ch2.readyState).toBe('closed');
    expect(manager.hasFollowers).toBe(false);
  });

  it('broadcasts user_message_echo to all followers', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    manager.broadcastUserMessage('hello from user', 'msg-42');

    // Each channel gets snapshot (1) + user_message_echo (1) = 2 messages
    const sent1 = ch1.parseSent();
    const sent2 = ch2.parseSent();
    expect(sent1).toHaveLength(2);
    expect(sent2).toHaveLength(2);
    expect(sent1[1]).toEqual({
      type: 'user_message_echo',
      text: 'hello from user',
      messageId: 'msg-42',
      scoopJid: 'cone',
    });
    expect(sent2[1]).toEqual({
      type: 'user_message_echo',
      text: 'hello from user',
      messageId: 'msg-42',
      scoopJid: 'cone',
    });
  });

  it('does not broadcast user_message_echo when no followers', () => {
    const { manager } = createManager();
    // Should not throw
    manager.broadcastUserMessage('lonely message', 'msg-99');
  });

  describe('target registry', () => {
    it('receives targets.advertise from follower and broadcasts targets.registry', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Clear initial messages (snapshot + possibly registry)
      ch1.sent.length = 0;
      ch2.sent.length = 0;

      // Simulate follower b1 advertising targets
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Google', url: 'https://google.com' }],
        runtimeId: 'follower-b1',
      });

      // Both followers should receive targets.registry
      const sent1 = ch1.parseSent();
      const sent2 = ch2.parseSent();
      expect(sent1).toHaveLength(1);
      expect(sent1[0].type).toBe('targets.registry');
      expect(sent2).toHaveLength(1);
      expect(sent2[0].type).toBe('targets.registry');

      if (sent1[0].type === 'targets.registry') {
        expect(sent1[0].targets).toHaveLength(1);
        expect(sent1[0].targets[0].runtimeId).toBe('follower-b1');
        expect(sent1[0].targets[0].localTargetId).toBe('tab1');
      }
    });

    it('setLocalTargets triggers broadcast to followers', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      manager.setLocalTargets([
        { targetId: 'lt1', title: 'Leader Tab', url: 'https://leader.com' },
      ]);

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('targets.registry');
      if (sent[0].type === 'targets.registry') {
        expect(sent[0].targets).toHaveLength(1);
        expect(sent[0].targets[0].runtimeId).toBe('leader');
        expect(sent[0].targets[0].localTargetId).toBe('lt1');
      }
    });

    it('follower disconnect removes that runtime targets from registry', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Follower b1 advertises targets
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      // Clear messages
      ch2.sent.length = 0;

      // Remove follower b1
      manager.removeFollower('b1');

      // ch2 should receive updated registry without b1's targets
      const sent2 = ch2.parseSent();
      expect(sent2).toHaveLength(1);
      expect(sent2[0].type).toBe('targets.registry');
      if (sent2[0].type === 'targets.registry') {
        expect(sent2[0].targets).toHaveLength(0);
      }
    });

    it('new follower gets current registry on connect', () => {
      const { manager } = createManager();

      // Leader sets its own targets first
      manager.setLocalTargets([
        { targetId: 'lt1', title: 'Leader Tab', url: 'https://leader.com' },
      ]);

      // New follower connects
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      const sent = channel.parseSent();
      // Should have snapshot + targets.registry
      expect(sent).toHaveLength(2);
      expect(sent[0].type).toBe('snapshot');
      expect(sent[1].type).toBe('targets.registry');
      if (sent[1].type === 'targets.registry') {
        expect(sent[1].targets).toHaveLength(1);
        expect(sent[1].targets[0].runtimeId).toBe('leader');
      }
    });

    it('does not send empty registry to new follower', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      const sent = channel.parseSent();
      // Only snapshot, no targets.registry when registry is empty
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('snapshot');
    });

    it('setLocalTargets does not broadcast when no followers', () => {
      const { manager } = createManager();
      // Should not throw
      manager.setLocalTargets([{ targetId: 't1', title: 'Tab', url: 'https://example.com' }]);
    });
  });
});
