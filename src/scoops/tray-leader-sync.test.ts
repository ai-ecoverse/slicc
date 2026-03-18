import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { LeaderSyncManager, type LeaderSyncManagerOptions } from './tray-leader-sync.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { LeaderToFollowerMessage, FollowerToLeaderMessage, TrayTargetEntry } from './tray-sync-protocol.js';
import { VirtualFS } from '../fs/virtual-fs.js';

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

  it('sends a large snapshot as chunks on addFollower', () => {
    // Create messages large enough to exceed the 64KB chunk threshold
    const largeMessages: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      largeMessages.push(makeChatMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000)));
    }
    const { manager } = createManager({ getMessages: () => [...largeMessages] });
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const sent = channel.parseSent();
    // Should have multiple snapshot_chunk messages instead of a single snapshot
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0].type).toBe('snapshot_chunk');
    if (sent[0].type === 'snapshot_chunk') {
      expect(sent[0].chunkIndex).toBe(0);
      expect(sent[0].totalChunks).toBeGreaterThan(1);
      expect(sent[0].scoopJid).toBe('cone');
    }

    // All chunks should have sequential indices
    const chunks = sent.filter(m => m.type === 'snapshot_chunk');
    expect(chunks).toHaveLength(sent.length);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].type === 'snapshot_chunk') {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    }

    // Reassembling all chunks should recover the original data
    const reassembled = chunks
      .map(c => (c.type === 'snapshot_chunk' ? c.chunkData : ''))
      .join('');
    const parsed = JSON.parse(reassembled) as { messages: ChatMessage[]; scoopJid: string };
    expect(parsed.messages).toHaveLength(50);
    expect(parsed.scoopJid).toBe('cone');
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

  it('getConnectedFollowers returns runtimeIds of advertised followers', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);

    // Initially no runtimeIds (advertise hasn't happened yet)
    expect(manager.getConnectedFollowers()).toEqual([]);

    // Follower b1 advertises targets
    ch1.simulateMessage({
      type: 'targets.advertise',
      targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
      runtimeId: 'follower-b1',
    });

    const followers1 = manager.getConnectedFollowers();
    expect(followers1).toHaveLength(1);
    expect(followers1[0].runtimeId).toBe('follower-b1');

    // Follower b2 advertises
    ch2.simulateMessage({
      type: 'targets.advertise',
      targets: [{ targetId: 'tab2', title: 'Tab 2', url: 'https://example2.com' }],
      runtimeId: 'follower-b2',
    });

    const followers2 = manager.getConnectedFollowers();
    expect(followers2).toHaveLength(2);
    expect(followers2.map(f => f.runtimeId)).toContain('follower-b1');
    expect(followers2.map(f => f.runtimeId)).toContain('follower-b2');

    // Remove follower b1
    manager.removeFollower('b1');
    const followers3 = manager.getConnectedFollowers();
    expect(followers3).toHaveLength(1);
    expect(followers3[0].runtimeId).toBe('follower-b2');
  });

  it('getConnectedFollowers includes runtime and connectedAt metadata', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    const connectedAt = '2026-03-16T10:00:00.000Z';
    manager.addFollower('b1', ch1, { runtime: 'slicc-electron', connectedAt });

    // Advertise to register runtimeId
    ch1.simulateMessage({
      type: 'targets.advertise',
      targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
      runtimeId: 'follower-b1',
    });

    const followers = manager.getConnectedFollowers();
    expect(followers).toHaveLength(1);
    expect(followers[0]).toMatchObject({
      runtimeId: 'follower-b1',
      runtime: 'slicc-electron',
      connectedAt,
      floatType: 'electron',
    });
    expect(followers[0].lastActivity).toBeGreaterThan(0);
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

  describe('CDP routing', () => {
    it('handles cdp.request for leader targets — executes locally and returns response', async () => {
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const { manager } = createManager();
      (manager as any).options.browserTransport = fakeBrowserTransport;

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      // Follower sends a CDP request targeting the leader
      ch1.simulateMessage({
        type: 'cdp.request',
        requestId: 'req-1',
        targetRuntimeId: 'leader',
        localTargetId: 'lt1',
        method: 'Target.attachToTarget',
        params: { targetId: 'lt1', flatten: true },
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-1');
        expect(response.result).toEqual({ sessionId: 'sess-1' });
      }
    });

    it('handles cdp.request for leader targets — returns error if no browser transport', async () => {
      const { manager } = createManager();
      // No browserTransport set

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'cdp.request',
        requestId: 'req-2',
        targetRuntimeId: 'leader',
        localTargetId: 'lt1',
        method: 'Page.navigate',
      } as any);

      // Wait for async execution
      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-2');
        expect(response.error).toBe('Leader has no browser transport');
      }
    });

    it('forwards cdp.request to target follower', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Follower b2 advertises targets so leader knows its runtime mapping
      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      // Follower b1 sends a CDP request targeting follower-b2
      ch1.simulateMessage({
        type: 'cdp.request',
        requestId: 'req-3',
        targetRuntimeId: 'follower-b2',
        localTargetId: 'tab1',
        method: 'Page.navigate',
        params: { url: 'https://new.com' },
      } as any);

      // ch2 should receive the forwarded cdp.request
      const sent2 = ch2.parseSent();
      expect(sent2).toHaveLength(1);
      expect(sent2[0].type).toBe('cdp.request');
      if (sent2[0].type === 'cdp.request') {
        expect(sent2[0].requestId).toBe('req-3');
        expect(sent2[0].localTargetId).toBe('tab1');
        expect(sent2[0].method).toBe('Page.navigate');
      }
    });

    it('forwards cdp.response back to original requester', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Establish runtime mapping
      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      // Follower b1 requests CDP from follower-b2
      ch1.simulateMessage({
        type: 'cdp.request',
        requestId: 'req-4',
        targetRuntimeId: 'follower-b2',
        localTargetId: 'tab1',
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
      } as any);

      // Follower b2 responds
      ch2.simulateMessage({
        type: 'cdp.response',
        requestId: 'req-4',
        result: { result: { value: 2 } },
      } as any);

      // ch1 should receive the response
      const sent1 = ch1.parseSent();
      const response = sent1.find(m => m.type === 'cdp.response');
      expect(response).toBeDefined();
      if (response && response.type === 'cdp.response') {
        expect(response.requestId).toBe('req-4');
        expect(response.result).toEqual({ result: { value: 2 } });
      }
    });

    it('returns error when target runtime is not connected', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'cdp.request',
        requestId: 'req-5',
        targetRuntimeId: 'unknown-runtime',
        localTargetId: 'tab1',
        method: 'Page.navigate',
      } as any);

      const sent = ch1.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('cdp.response');
      if (sent[0].type === 'cdp.response') {
        expect(sent[0].requestId).toBe('req-5');
        expect(sent[0].error).toContain('not connected');
      }
    });
  });

  describe('tab.open routing', () => {
    it('handles tab.open targeting leader — creates local tab and responds', async () => {
      const fakeBrowserTransport = {
        send: vi.fn().mockResolvedValue({ targetId: 'new-tab-1' }),
        connect: vi.fn(),
        disconnect: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        state: 'connected' as const,
      };
      const { manager } = createManager();
      (manager as any).options.browserTransport = fakeBrowserTransport;

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-1',
        targetRuntimeId: 'leader',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('tabopen-1');
        expect(response.targetId).toBe('leader:new-tab-1');
      }
    });

    it('handles tab.open targeting leader — returns error if no browser transport', async () => {
      const { manager } = createManager();

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-2',
        targetRuntimeId: 'leader',
        url: 'https://example.com',
      } as any);

      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-2');
        expect(response.error).toBe('Leader has no browser transport');
      }
    });

    it('forwards tab.open to target follower', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Follower b2 advertises so leader knows its runtime mapping
      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-3',
        targetRuntimeId: 'follower-b2',
        url: 'https://new-tab.com',
      } as any);

      const sent2 = ch2.parseSent();
      expect(sent2).toHaveLength(1);
      expect(sent2[0].type).toBe('tab.open');
      if (sent2[0].type === 'tab.open') {
        expect(sent2[0].requestId).toBe('tabopen-3');
        expect(sent2[0].url).toBe('https://new-tab.com');
      }
    });

    it('forwards tab.opened response back to requester', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-4',
        targetRuntimeId: 'follower-b2',
        url: 'https://new-tab.com',
      } as any);

      // Follower b2 responds with tab.opened
      ch2.simulateMessage({
        type: 'tab.opened',
        requestId: 'tabopen-4',
        targetId: 'follower-b2:new-tab-1',
      } as any);

      const sent1 = ch1.parseSent();
      const response = sent1.find(m => m.type === 'tab.opened');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.opened') {
        expect(response.requestId).toBe('tabopen-4');
        expect(response.targetId).toBe('follower-b2:new-tab-1');
      }
    });

    it('forwards tab.open.error response back to requester', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-5',
        targetRuntimeId: 'follower-b2',
        url: 'https://new-tab.com',
      } as any);

      ch2.simulateMessage({
        type: 'tab.open.error',
        requestId: 'tabopen-5',
        error: 'Tab creation failed',
      } as any);

      const sent1 = ch1.parseSent();
      const response = sent1.find(m => m.type === 'tab.open.error');
      expect(response).toBeDefined();
      if (response && response.type === 'tab.open.error') {
        expect(response.requestId).toBe('tabopen-5');
        expect(response.error).toBe('Tab creation failed');
      }
    });

    it('returns error when target runtime is not connected', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'tab.open',
        requestId: 'tabopen-6',
        targetRuntimeId: 'unknown-runtime',
        url: 'https://new-tab.com',
      } as any);

      const sent = ch1.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('tab.open.error');
      if (sent[0].type === 'tab.open.error') {
        expect(sent[0].requestId).toBe('tabopen-6');
        expect(sent[0].error).toContain('not connected');
      }
    });

    it('openRemoteTab sends tab.open and resolves with targetId', async () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      ch1.sent.length = 0;

      const promise = manager.openRemoteTab('follower-b1', 'https://remote-tab.com');

      // Check that the request was sent
      const sent = ch1.parseSent();
      const tabOpenMsg = sent.find(m => m.type === 'tab.open');
      expect(tabOpenMsg).toBeDefined();
      if (tabOpenMsg && tabOpenMsg.type === 'tab.open') {
        expect(tabOpenMsg.url).toBe('https://remote-tab.com');

        // Simulate follower responding
        ch1.simulateMessage({
          type: 'tab.opened',
          requestId: tabOpenMsg.requestId,
          targetId: 'follower-b1:new-tab-99',
        } as any);
      }

      const targetId = await promise;
      expect(targetId).toBe('follower-b1:new-tab-99');
    });

    it('openRemoteTab rejects when target runtime is not connected', async () => {
      const { manager } = createManager();

      await expect(manager.openRemoteTab('unknown', 'https://example.com')).rejects.toThrow('not connected');
    });
  });

  describe('keepalive dead → follower removal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('removes follower when keepalive declares dead', () => {
      const onFollowerDead = vi.fn();
      const { manager } = createManager({ onFollowerDead });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      expect(manager.hasFollowers).toBe(true);

      // Default keepalive: 10s interval, 3 missed
      vi.advanceTimersByTime(10_000); // tick 1: ping sent
      vi.advanceTimersByTime(10_000); // tick 2: missed=1
      vi.advanceTimersByTime(10_000); // tick 3: missed=2
      vi.advanceTimersByTime(10_000); // tick 4: missed=3 → dead

      expect(manager.hasFollowers).toBe(false);
      expect(channel.readyState).toBe('closed');
      expect(onFollowerDead).toHaveBeenCalledWith('b1');
    });

    it('does not remove follower if pongs arrive in time', () => {
      const onFollowerDead = vi.fn();
      const { manager } = createManager({ onFollowerDead });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      // Advance and simulate pong response each time
      vi.advanceTimersByTime(10_000); // tick 1: ping sent
      // Simulate follower responding with pong
      channel.simulateMessage({ type: 'pong' } as any);

      vi.advanceTimersByTime(10_000); // tick 2: ping sent
      channel.simulateMessage({ type: 'pong' } as any);

      vi.advanceTimersByTime(10_000); // tick 3: ping sent
      channel.simulateMessage({ type: 'pong' } as any);

      vi.advanceTimersByTime(10_000); // tick 4: ping sent
      channel.simulateMessage({ type: 'pong' } as any);

      expect(manager.hasFollowers).toBe(true);
      expect(onFollowerDead).not.toHaveBeenCalled();
    });
  });

  describe('fs routing', () => {
    let vfs: VirtualFS;
    let dbCounter = 0;

    beforeEach(async () => {
      vfs = await VirtualFS.create({ dbName: `test-leader-fs-${dbCounter++}`, wipe: true });
    });

    it('handles fs.request for leader — executes locally and returns response', async () => {
      const { manager } = createManager({ vfs });
      await vfs.writeFile('/hello.txt', 'world');

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'fs.request',
        requestId: 'fs-1',
        targetRuntimeId: 'leader',
        request: { op: 'readFile', path: '/hello.txt' },
      } as any);

      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'fs.response');
      expect(response).toBeDefined();
      if (response && response.type === 'fs.response') {
        expect(response.requestId).toBe('fs-1');
        expect(response.response.ok).toBe(true);
        if (response.response.ok) {
          expect(response.response.data).toEqual({
            type: 'file',
            content: 'world',
            encoding: 'utf-8',
          });
        }
      }
    });

    it('handles fs.request for leader — returns error if no VFS', async () => {
      const { manager } = createManager();

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'fs.request',
        requestId: 'fs-2',
        targetRuntimeId: 'leader',
        request: { op: 'readFile', path: '/nope.txt' },
      } as any);

      await vi.waitFor(() => {
        expect(ch1.parseSent().length).toBeGreaterThan(0);
      });

      const sent = ch1.parseSent();
      const response = sent.find(m => m.type === 'fs.response');
      expect(response).toBeDefined();
      if (response && response.type === 'fs.response') {
        expect(response.response.ok).toBe(false);
        if (!response.response.ok) {
          expect(response.response.error).toBe('Leader has no VFS');
        }
      }
    });

    it('forwards fs.request to target follower', () => {
      const { manager } = createManager({ vfs });
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Follower b2 advertises so leader knows its runtime mapping
      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      ch1.simulateMessage({
        type: 'fs.request',
        requestId: 'fs-3',
        targetRuntimeId: 'follower-b2',
        request: { op: 'readFile', path: '/remote.txt' },
      } as any);

      const sent2 = ch2.parseSent();
      expect(sent2).toHaveLength(1);
      expect(sent2[0].type).toBe('fs.request');
      if (sent2[0].type === 'fs.request') {
        expect(sent2[0].requestId).toBe('fs-3');
        expect(sent2[0].request.op).toBe('readFile');
      }
    });

    it('forwards fs.response back to original requester', () => {
      const { manager } = createManager({ vfs });
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b2',
      });

      ch1.sent.length = 0;
      ch2.sent.length = 0;

      // Follower b1 sends fs request targeting follower-b2
      ch1.simulateMessage({
        type: 'fs.request',
        requestId: 'fs-4',
        targetRuntimeId: 'follower-b2',
        request: { op: 'readFile', path: '/remote.txt' },
      } as any);

      // Follower b2 responds
      ch2.simulateMessage({
        type: 'fs.response',
        requestId: 'fs-4',
        response: { ok: true, data: { type: 'file', content: 'remote content', encoding: 'utf-8' } },
      } as any);

      const sent1 = ch1.parseSent();
      const response = sent1.find(m => m.type === 'fs.response');
      expect(response).toBeDefined();
      if (response && response.type === 'fs.response') {
        expect(response.requestId).toBe('fs-4');
        expect(response.response.ok).toBe(true);
      }
    });

    it('returns error when target runtime is not connected', () => {
      const { manager } = createManager({ vfs });
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.sent.length = 0;

      ch1.simulateMessage({
        type: 'fs.request',
        requestId: 'fs-5',
        targetRuntimeId: 'unknown-runtime',
        request: { op: 'stat', path: '/whatever' },
      } as any);

      const sent = ch1.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('fs.response');
      if (sent[0].type === 'fs.response') {
        expect(sent[0].response.ok).toBe(false);
        if (!sent[0].response.ok) {
          expect(sent[0].response.error).toContain('not connected');
        }
      }
    });

    it('sendFsRequest from leader sends to target follower and resolves', async () => {
      const { manager } = createManager({ vfs });
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      ch1.sent.length = 0;

      const promise = manager.sendFsRequest('follower-b1', { op: 'exists', path: '/test' });

      // Find the sent fs.request
      const sent = ch1.parseSent();
      const fsReq = sent.find(m => m.type === 'fs.request');
      expect(fsReq).toBeDefined();
      if (fsReq && fsReq.type === 'fs.request') {
        // Simulate follower responding
        ch1.simulateMessage({
          type: 'fs.response',
          requestId: fsReq.requestId,
          response: { ok: true, data: { type: 'exists', exists: true } },
        } as any);
      }

      const responses = await promise;
      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(true);
    });

    it('sendFsRequest targeting leader executes locally', async () => {
      const { manager } = createManager({ vfs });
      await vfs.writeFile('/local.txt', 'local content');

      const responses = await manager.sendFsRequest('leader', { op: 'readFile', path: '/local.txt' });
      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(true);
      if (responses[0].ok) {
        expect(responses[0].data).toEqual({
          type: 'file',
          content: 'local content',
          encoding: 'utf-8',
        });
      }
    });

    it('sendFsRequest returns error when target not connected', async () => {
      const { manager } = createManager({ vfs });

      const responses = await manager.sendFsRequest('unknown', { op: 'exists', path: '/' });
      expect(responses).toHaveLength(1);
      expect(responses[0].ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Follower activity tracking
  // ---------------------------------------------------------------------------

  describe('follower activity tracking', () => {
    it('sets lastActivity and floatType on addFollower', () => {
      const { manager } = createManager();
      const ch = new FakeChannel();
      manager.addFollower('b1', ch, { runtime: 'slicc-standalone', connectedAt: new Date().toISOString() });

      const followers = manager.getConnectedFollowers();
      // No runtimeId mapping yet because targets.advertise hasn't been sent
      // But we can verify via the internal state by advertising targets
      ch.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'follower-b1' });
      const updated = manager.getConnectedFollowers();
      expect(updated).toHaveLength(1);
      expect(updated[0].floatType).toBe('standalone');
      expect(updated[0].lastActivity).toBeGreaterThan(0);
    });

    it('derives floatType from runtime string', () => {
      const { manager } = createManager();

      // standalone
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1, { runtime: 'slicc-standalone' });
      ch1.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f1' });

      // extension
      const ch2 = new FakeChannel();
      manager.addFollower('b2', ch2, { runtime: 'slicc-extension' });
      ch2.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f2' });

      // electron
      const ch3 = new FakeChannel();
      manager.addFollower('b3', ch3, { runtime: 'slicc-electron' });
      ch3.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f3' });

      // unknown
      const ch4 = new FakeChannel();
      manager.addFollower('b4', ch4, { runtime: 'something-else' });
      ch4.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f4' });

      const followers = manager.getConnectedFollowers();
      expect(followers.find(f => f.runtimeId === 'f1')?.floatType).toBe('standalone');
      expect(followers.find(f => f.runtimeId === 'f2')?.floatType).toBe('extension');
      expect(followers.find(f => f.runtimeId === 'f3')?.floatType).toBe('electron');
      expect(followers.find(f => f.runtimeId === 'f4')?.floatType).toBe('unknown');
    });

    it('updates lastActivity on pong', () => {
      vi.useFakeTimers();
      try {
        const { manager } = createManager();
        const ch = new FakeChannel();
        manager.addFollower('b1', ch, { runtime: 'slicc-standalone' });
        ch.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f1' });

        const before = manager.getConnectedFollowers()[0].lastActivity!;
        vi.advanceTimersByTime(5000);
        ch.simulateMessage({ type: 'pong' });
        const after = manager.getConnectedFollowers()[0].lastActivity!;
        expect(after).toBeGreaterThan(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getBestFollowerForTeleport
  // ---------------------------------------------------------------------------

  describe('getBestFollowerForTeleport', () => {
    it('returns null when no followers connected', () => {
      const { manager } = createManager();
      expect(manager.getBestFollowerForTeleport()).toBeNull();
    });

    it('returns the only connected follower', () => {
      const { manager } = createManager();
      const ch = new FakeChannel();
      manager.addFollower('b1', ch, { runtime: 'slicc-extension' });
      ch.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f1' });

      const best = manager.getBestFollowerForTeleport();
      expect(best).not.toBeNull();
      expect(best!.runtimeId).toBe('f1');
      expect(best!.floatType).toBe('extension');
    });

    it('prefers standalone over extension', () => {
      const { manager } = createManager();

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1, { runtime: 'slicc-extension' });
      ch1.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-ext' });

      const ch2 = new FakeChannel();
      manager.addFollower('b2', ch2, { runtime: 'slicc-standalone' });
      ch2.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-std' });

      const best = manager.getBestFollowerForTeleport();
      expect(best!.runtimeId).toBe('f-std');
      expect(best!.floatType).toBe('standalone');
    });

    it('falls back to non-standalone when no standalone available', () => {
      const { manager } = createManager();

      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1, { runtime: 'slicc-extension' });
      ch1.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-ext' });

      const best = manager.getBestFollowerForTeleport();
      expect(best!.floatType).toBe('extension');
    });
  });

  // ---------------------------------------------------------------------------
  // Cookie teleport routing
  // ---------------------------------------------------------------------------

  describe('cookie teleport routing', () => {
    it('forwards cookie teleport request from follower to target follower', () => {
      const { manager } = createManager();

      // Set up two followers
      const chRequester = new FakeChannel();
      manager.addFollower('b-requester', chRequester, { runtime: 'slicc-extension' });
      chRequester.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-requester' });

      const chTarget = new FakeChannel();
      manager.addFollower('b-target', chTarget, { runtime: 'slicc-standalone' });
      chTarget.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-target' });

      // Clear sent messages from setup
      chTarget.sent.length = 0;
      chRequester.sent.length = 0;

      // Requester sends a cookie teleport request targeting f-target
      chRequester.simulateMessage({
        type: 'cookie.teleport.request',
        requestId: 'ct-1',
        targetRuntimeId: 'f-target',
      });

      // Target should have received the forwarded request
      const targetSent = chTarget.parseSent();
      const teleportReq = targetSent.find(m => m.type === 'cookie.teleport.request');
      expect(teleportReq).toBeDefined();
      expect(teleportReq!.type).toBe('cookie.teleport.request');
      if (teleportReq!.type === 'cookie.teleport.request') {
        expect(teleportReq!.requestId).toBe('ct-1');
      }
    });

    it('routes cookie teleport response back to requester (including finalUrl)', () => {
      const { manager } = createManager();

      const chRequester = new FakeChannel();
      manager.addFollower('b-requester', chRequester, { runtime: 'slicc-extension' });
      chRequester.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-requester' });

      const chTarget = new FakeChannel();
      manager.addFollower('b-target', chTarget, { runtime: 'slicc-standalone' });
      chTarget.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-target' });

      // Requester sends request
      chRequester.simulateMessage({
        type: 'cookie.teleport.request',
        requestId: 'ct-2',
        targetRuntimeId: 'f-target',
      });

      // Clear requester's sent so we can check only the response
      chRequester.sent.length = 0;

      // Target responds with cookies and finalUrl
      const fakeCookies = [{ name: 'sid', value: '123', domain: '.example.com', path: '/', expires: -1, size: 10, httpOnly: true, secure: true, session: true }];
      chTarget.simulateMessage({
        type: 'cookie.teleport.response',
        requestId: 'ct-2',
        cookies: fakeCookies as never,
        finalUrl: 'https://example.com/home',
      });

      const requesterSent = chRequester.parseSent();
      const response = requesterSent.find(m => m.type === 'cookie.teleport.response');
      expect(response).toBeDefined();
      if (response?.type === 'cookie.teleport.response') {
        expect(response.cookies).toEqual(fakeCookies);
        expect(response.finalUrl).toBe('https://example.com/home');
      }
    });

    it('returns error when target runtime not connected', () => {
      const { manager } = createManager();

      const chRequester = new FakeChannel();
      manager.addFollower('b-requester', chRequester, { runtime: 'slicc-standalone' });
      chRequester.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-requester' });

      chRequester.sent.length = 0;

      chRequester.simulateMessage({
        type: 'cookie.teleport.request',
        requestId: 'ct-3',
        targetRuntimeId: 'nonexistent',
      });

      const sent = chRequester.parseSent();
      const response = sent.find(m => m.type === 'cookie.teleport.response');
      expect(response).toBeDefined();
      if (response?.type === 'cookie.teleport.response') {
        expect(response.error).toContain('not connected');
      }
    });

    it('leader-originated sendCookieTeleportRequest resolves with cookies and finalUrl', async () => {
      const { manager } = createManager();

      const chTarget = new FakeChannel();
      manager.addFollower('b-target', chTarget, { runtime: 'slicc-standalone' });
      chTarget.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-target' });

      chTarget.sent.length = 0;

      const promise = manager.sendCookieTeleportRequest('f-target');

      // Find the request that was sent to the target
      const sent = chTarget.parseSent();
      const req = sent.find(m => m.type === 'cookie.teleport.request');
      expect(req).toBeDefined();

      // Simulate target responding with cookies and finalUrl
      const fakeCookies = [{ name: 'token', value: 'abc', domain: '.app.com', path: '/', expires: -1, size: 20, httpOnly: false, secure: true, session: true }];
      if (req?.type === 'cookie.teleport.request') {
        chTarget.simulateMessage({
          type: 'cookie.teleport.response',
          requestId: req.requestId,
          cookies: fakeCookies as never,
          finalUrl: 'https://app.com/dashboard',
        });
      }

      const result = await promise;
      expect(result.cookies).toEqual(fakeCookies);
      expect(result.finalUrl).toBe('https://app.com/dashboard');
    });

    it('leader-originated sendCookieTeleportRequest rejects when target not connected', async () => {
      const { manager } = createManager();

      await expect(manager.sendCookieTeleportRequest('nonexistent')).rejects.toThrow('not connected');
    });

    it('executes local cookie teleport when targetRuntimeId is leader (via BrowserAPI)', async () => {
      const mockBrowserAPI = {
        listPages: vi.fn().mockResolvedValue([
          { targetId: 'tab1', title: 'App', url: 'https://app.example.com' },
        ]),
        attachToPage: vi.fn().mockResolvedValue('sess-1'),
        sendCDP: vi.fn().mockResolvedValue({ cookies: [{ name: 'x', value: 'y' }] }),
      };
      const { manager } = createManager({ browserAPI: mockBrowserAPI as never });

      const chFollower = new FakeChannel();
      manager.addFollower('b-follower', chFollower, { runtime: 'slicc-standalone' });
      chFollower.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-follower' });

      chFollower.sent.length = 0;

      chFollower.simulateMessage({
        type: 'cookie.teleport.request',
        requestId: 'ct-local',
        targetRuntimeId: 'leader',
      });

      // Wait for async handler
      await vi.waitFor(() => {
        expect(chFollower.parseSent().some(m => m.type === 'cookie.teleport.response')).toBe(true);
      });

      const sent = chFollower.parseSent();
      const response = sent.find(m => m.type === 'cookie.teleport.response');
      expect(response).toBeDefined();
      if (response?.type === 'cookie.teleport.response') {
        expect(response.cookies).toEqual([{ name: 'x', value: 'y' }]);
      }
      expect(mockBrowserAPI.attachToPage).toHaveBeenCalledWith('tab1');
      expect(mockBrowserAPI.sendCDP).toHaveBeenCalledWith('Network.getCookies');
    });
  });

  // ---------------------------------------------------------------------------
  // Stale remote transport cleanup on disconnect / reconnect
  // ---------------------------------------------------------------------------

  describe('stale remote transport cleanup', () => {
    it('removeFollower cleans up remoteTransports for that follower runtimeId', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      // Follower advertises targets
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      // Leader creates a remote transport for that follower
      const transport = manager.createRemoteTransport('follower-b1', 'tab1');
      expect(transport.state).toBe('connected');

      // Remove follower — transport should be disconnected and cleaned up
      manager.removeFollower('b1');
      expect(transport.state).toBe('disconnected');

      // Verify internal map is clean (creating a new transport should work)
      const transport2 = manager.createRemoteTransport('follower-b1', 'tab1');
      expect(transport2).not.toBe(transport);
    });

    it('after follower disconnect and reconnect with new ID, CDP commands work with new ID', () => {
      const { manager } = createManager();

      // First connection
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
        runtimeId: 'follower-old',
      });

      // Leader creates a remote transport
      const oldTransport = manager.createRemoteTransport('follower-old', 'tab1');

      // Follower disconnects
      manager.removeFollower('b1');
      expect(oldTransport.state).toBe('disconnected');

      // Follower reconnects with new ID
      const ch2 = new FakeChannel();
      manager.addFollower('b2', ch2);
      ch2.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
        runtimeId: 'follower-new',
      });

      // New transport should work (sender will look up 'follower-new' in runtimeToBootstrap)
      const newTransport = manager.createRemoteTransport('follower-new', 'tab1');
      expect(newTransport.state).toBe('connected');

      // Verify the new follower is in getConnectedFollowers
      const followers = manager.getConnectedFollowers();
      expect(followers).toHaveLength(1);
      expect(followers[0].runtimeId).toBe('follower-new');
    });

    it('proactive cleanup removes orphaned transports on targets.advertise', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      // Manually inject a stale transport for a runtimeId that no longer exists
      // (simulating a race condition where removeFollower didn't clean up)
      const staleTransport = manager.createRemoteTransport('stale-runtime', 'tab-x');
      expect(staleTransport.state).toBe('connected');

      // New follower advertises targets — this should trigger cleanup of stale-runtime
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      // Stale transport should have been disconnected
      expect(staleTransport.state).toBe('disconnected');
    });

    it('removeFollower with multiple transports for same runtime cleans all', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [
          { targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' },
          { targetId: 'tab2', title: 'Tab 2', url: 'https://example2.com' },
        ],
        runtimeId: 'follower-b1',
      });

      const transport1 = manager.createRemoteTransport('follower-b1', 'tab1');
      const transport2 = manager.createRemoteTransport('follower-b1', 'tab2');

      manager.removeFollower('b1');

      expect(transport1.state).toBe('disconnected');
      expect(transport2.state).toBe('disconnected');
    });
  });

  // ---------------------------------------------------------------------------
  // CDP event forwarding
  // ---------------------------------------------------------------------------

  describe('CDP event forwarding', () => {
    it('routes cdp.event from follower to leader RemoteCDPTransport', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      // Follower advertises targets so leader knows its runtime mapping
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      // Leader creates a remote transport for the follower
      const transport = manager.createRemoteTransport('follower-b1', 'tab1');
      const events: Record<string, unknown>[] = [];
      transport.on('Page.frameNavigated', (params) => events.push(params));

      // Follower sends a cdp.event
      ch1.simulateMessage({
        type: 'cdp.event',
        method: 'Page.frameNavigated',
        params: { frame: { url: 'https://navigated.com', id: 'main' } },
        sessionId: 'sess-1',
      } as any);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ frame: { url: 'https://navigated.com', id: 'main' } });
    });

    it('does not deliver cdp.event for unknown follower bootstrapId', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      // Do NOT advertise targets — no runtimeId mapping exists

      // Create a transport for some runtime (just to have one)
      const transport = manager.createRemoteTransport('some-runtime', 'tab1');
      const events: Record<string, unknown>[] = [];
      transport.on('Page.frameNavigated', (params) => events.push(params));

      // Follower sends a cdp.event — but bootstrap has no runtimeId mapping
      ch1.simulateMessage({
        type: 'cdp.event',
        method: 'Page.frameNavigated',
        params: { frame: { url: 'https://navigated.com', id: 'main' } },
      } as any);

      // Should not be delivered since follower has no runtimeId mapping
      expect(events).toHaveLength(0);
    });

    it('delivers cdp.event to all remote transports for the same follower runtime', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [
          { targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' },
          { targetId: 'tab2', title: 'Tab 2', url: 'https://example2.com' },
        ],
        runtimeId: 'follower-b1',
      });

      const transport1 = manager.createRemoteTransport('follower-b1', 'tab1');
      const transport2 = manager.createRemoteTransport('follower-b1', 'tab2');
      const events1: Record<string, unknown>[] = [];
      const events2: Record<string, unknown>[] = [];
      transport1.on('Page.loadEventFired', (params) => events1.push(params));
      transport2.on('Page.loadEventFired', (params) => events2.push(params));

      ch1.simulateMessage({
        type: 'cdp.event',
        method: 'Page.loadEventFired',
        params: { timestamp: 123 },
      } as any);

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    it('stops delivering events after follower disconnect', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Tab 1', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      const transport = manager.createRemoteTransport('follower-b1', 'tab1');
      const events: Record<string, unknown>[] = [];
      transport.on('Page.frameNavigated', (params) => events.push(params));

      // First event — should be delivered
      ch1.simulateMessage({
        type: 'cdp.event',
        method: 'Page.frameNavigated',
        params: { frame: { url: 'https://first.com', id: 'main' } },
      } as any);
      expect(events).toHaveLength(1);

      // Remove follower — transport gets disconnected, runtime mapping removed
      manager.removeFollower('b1');
      expect(transport.state).toBe('disconnected');
    });
  });
});
