import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/core/agent-types.js';
import { resetLoggerDedupForTests } from '../../src/core/logger.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  isCherryTarget,
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
  labelForFollower,
  selectTeleportPool,
} from '../../src/scoops/tray-leader-sync.js';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../../src/scoops/tray-sync-protocol.js';
import { CHERRY_RUNTIME_TAG } from '../../src/scoops/tray-sync-protocol.js';
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
    // The manager sends a `hello` version handshake on addFollower; filter it
    // out so per-feature assertions stay focused. Hello-specific tests read
    // the raw `sent` array instead.
    return this.sent
      .map((s) => JSON.parse(s) as LeaderToFollowerMessage)
      .filter((m) => m.type !== 'hello');
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
    sendControl: () => {},
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

describe('labelForFollower', () => {
  it('maps known float types to readable labels', () => {
    expect(labelForFollower('extension')).toBe('extension follower');
    expect(labelForFollower('standalone')).toBe('standalone follower');
    expect(labelForFollower('electron')).toBe('Electron follower');
    expect(labelForFollower('ios')).toBe('iOS follower');
  });
  it('falls back to the raw runtime string for unknown', () => {
    expect(labelForFollower('unknown', 'slicc-weird')).toBe('follower (slicc-weird)');
    expect(labelForFollower('unknown')).toBe('follower');
  });
});

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

  it('fires onFollowerCountChanged on add and remove', () => {
    const onFollowerCountChanged = vi.fn();
    const { manager } = createManager({ onFollowerCountChanged });
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();

    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);
    expect(onFollowerCountChanged.mock.calls.map((c) => c[0])).toEqual([1, 2]);

    manager.removeFollower('b1');
    manager.removeFollower('b2');
    expect(onFollowerCountChanged.mock.calls.map((c) => c[0])).toEqual([1, 2, 1, 0]);
  });

  it('sends a large snapshot as chunks on addFollower', () => {
    // Create messages large enough to exceed the 64KB chunk threshold
    const largeMessages: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      largeMessages.push(
        makeChatMessage(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(2000))
      );
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
    const chunks = sent.filter((m) => m.type === 'snapshot_chunk');
    expect(chunks).toHaveLength(sent.length);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].type === 'snapshot_chunk') {
        expect(chunks[i].chunkIndex).toBe(i);
      }
    }

    // Reassembling all chunks should recover the original data
    const reassembled = chunks
      .map((c) => (c.type === 'snapshot_chunk' ? c.chunkData : ''))
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

    expect(onFollowerMessage).toHaveBeenCalledWith('from follower', 'fm1', undefined);
  });

  it('handles follower user_message attachments', () => {
    const { manager, onFollowerMessage } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);
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

    channel.simulateMessage({
      type: 'user_message',
      text: 'from follower',
      messageId: 'fm1',
      attachments,
    });

    expect(onFollowerMessage).toHaveBeenCalledWith('from follower', 'fm1', attachments);
  });

  it('strips path-only attachments from follower messages before forwarding', () => {
    const { manager, onFollowerMessage } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    channel.simulateMessage({
      type: 'user_message',
      text: 'from follower',
      messageId: 'fm2',
      attachments: [
        {
          id: 'a1',
          name: 'huge.bin',
          mimeType: 'application/octet-stream',
          size: 60_000_000,
          kind: 'file',
          path: '/tmp/attachment-follower-only',
        },
      ],
    });

    const forwarded = onFollowerMessage.mock.calls[0][2] as
      | { path?: string; error?: string }[]
      | undefined;
    expect(forwarded?.[0].path).toBeUndefined();
    expect(forwarded?.[0].error).toMatch(/remote runtime/);
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

  it('routes follower new_session to onFollowerNewSession with the action', () => {
    const onFollowerNewSession = vi.fn();
    const { manager } = createManager({ onFollowerNewSession });
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    channel.simulateMessage({ type: 'new_session', action: 'save' });

    expect(onFollowerNewSession).toHaveBeenCalledWith('save', 'b1');
  });

  it('broadcastSnapshot pushes the current messages to every follower', () => {
    let messages: ChatMessage[] = [
      makeChatMessage('m1', 'user', 'hello'),
      makeChatMessage('m2', 'assistant', 'hi there'),
    ];
    const { manager } = createManager({ getMessages: () => [...messages] });
    const ch1 = new FakeChannel();
    const ch2 = new FakeChannel();
    manager.addFollower('b1', ch1);
    manager.addFollower('b2', ch2);
    ch1.sent.length = 0;
    ch2.sent.length = 0;

    // Simulate the leader clearing all messages, then broadcasting the
    // (now empty) snapshot to already-connected followers.
    messages = [];
    manager.broadcastSnapshot();

    for (const ch of [ch1, ch2]) {
      const sent = ch.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('snapshot');
      if (sent[0].type === 'snapshot') {
        expect(sent[0].messages).toEqual([]);
      }
    }
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
    expect(followers2.map((f) => f.runtimeId)).toContain('follower-b1');
    expect(followers2.map((f) => f.runtimeId)).toContain('follower-b2');

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

  it('getTargets federates an advertised follower as composite remote entries (BUG-F3)', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    // An Electron follower joins and advertises its local CDP page targets.
    manager.addFollower('b1', ch1, { runtime: 'slicc-electron' });
    ch1.simulateMessage({
      type: 'targets.advertise',
      runtimeId: 'follower-b1',
      targets: [
        { targetId: 'tab1', title: 'Page One', url: 'https://example.com/1' },
        { targetId: 'tab2', title: 'Page Two', url: 'https://example.com/2' },
      ],
    });

    // The leader's BrowserAPI provider (which backs `playwright list-tabs`)
    // must expose them as composite `${runtimeId}:${localTargetId}` remotes.
    const entries = manager.getTargets();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      targetId: 'follower-b1:tab1',
      localTargetId: 'tab1',
      runtimeId: 'follower-b1',
      isLocal: false,
      kind: 'browser',
    });
    expect(entries.map((e) => e.targetId)).toContain('follower-b1:tab2');
  });

  it('getTargets drops a follower\u2019s entries once it disconnects (getConnectedEntries filter)', () => {
    const { manager } = createManager();
    const ch1 = new FakeChannel();
    manager.addFollower('b1', ch1, { runtime: 'slicc-electron' });
    ch1.simulateMessage({
      type: 'targets.advertise',
      runtimeId: 'follower-b1',
      targets: [{ targetId: 'tab1', title: 'Page', url: 'https://example.com' }],
    });
    expect(manager.getTargets()).toHaveLength(1);

    // After the follower leaves, its targets must no longer be federated.
    manager.removeFollower('b1');
    expect(manager.getTargets()).toEqual([]);
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

  it('broadcastUserMessage forwards inline attachments unchanged', () => {
    // Attachments without a `path` (inline `data`/`text`) carry no
    // leader-local state — they must arrive verbatim on every follower
    // channel so images/text remain visible after the wire trip.
    const { manager } = createManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    const inlineAtt = {
      id: 'a1',
      name: 'inline.png',
      mimeType: 'image/png',
      size: 3,
      kind: 'image' as const,
      data: 'AAA',
    };
    manager.broadcastUserMessage('look here', 'msg-att-1', [inlineAtt]);

    const sent = ch.parseSent();
    // snapshot + user_message_echo
    expect(sent).toHaveLength(2);
    const echo = sent[1];
    if (echo.type !== 'user_message_echo') throw new Error('expected user_message_echo');
    expect(echo.attachments).toEqual([inlineAtt]);
  });

  it('broadcastUserMessage strips leader-local VFS paths before sending', () => {
    // CR-1: without this scrub, the standalone-leader chat hook
    // (`ui/main.ts:mainStandaloneWorker` `setOnLocalUserMessage` →
    // `broadcastUserMessage`) would ship the real off-loaded paths
    // produced by `attachment-vfs.ts:makeAttachmentPath` (shape:
    // `/tmp/attachment-<stamp>-<seq>-<rand>-<name>`) over the WebRTC
    // wire to every follower — meaningless on the receiver. Inline
    // content still arrives; path-only attachments demote to
    // `not-included` placeholders.
    const { manager } = createManager();
    const ch = new FakeChannel();
    manager.addFollower('b1', ch);

    manager.broadcastUserMessage('see this', 'msg-att-2', [
      // Mixed: an image with inline data + a path; the path should be
      // dropped but the data should survive.
      {
        id: 'a2',
        name: 'foo.png',
        mimeType: 'image/png',
        size: 3,
        kind: 'image',
        data: 'AAA',
        path: '/tmp/attachment-1716045123456-1-abc123-foo.png',
      },
      // Path-only attachment — no inline `data`/`text` — should
      // demote to `not-included` with an explanatory `error`.
      {
        id: 'a3',
        name: 'no-data.png',
        mimeType: 'image/png',
        size: 0,
        kind: 'image',
        path: '/tmp/attachment-1716045123456-2-def456-no-data.png',
      },
    ]);

    const sent = ch.parseSent();
    const echo = sent[1];
    if (echo.type !== 'user_message_echo') throw new Error('expected user_message_echo');
    expect(echo.attachments).toBeDefined();
    expect(echo.attachments).toHaveLength(2);
    // First: inline data survives, `path` dropped.
    expect(echo.attachments![0]).not.toHaveProperty('path');
    expect((echo.attachments![0] as { data?: string }).data).toBe('AAA');
    // Second: path-only demoted with `error` reason.
    expect(echo.attachments![1]).not.toHaveProperty('path');
    expect((echo.attachments![1] as { error?: string }).error).toMatch(/remote runtime/i);
  });

  it('multi-follower re-broadcast: a follower-originated message reaches sibling followers and dedupes on the sender', () => {
    // F-3: this is the load-bearing behavior of the
    // `ui/main.ts:onFollowerMessage` re-broadcast — without it,
    // sibling followers stay invisible to each other. The actual
    // re-broadcast wiring lives in main.ts (out of unit-test reach),
    // but the LeaderSyncManager surfaces that must hold up under it
    // are: (a) `broadcastUserMessage` forwarding the message to every
    // follower channel, and (b) the originating follower's
    // `sentMessageIds` dedup catching the echo when it comes back.
    // We simulate the main.ts wiring inline here.
    const onFollowerMessageMock =
      vi.fn<(text: string, messageId: string, attachments?: unknown) => void>();
    const { manager } = createManager({
      onFollowerMessage: (text, messageId, attachments) => {
        onFollowerMessageMock(text, messageId, attachments);
        // Mirror the `main.ts:2428` wiring: re-broadcast to OTHER
        // followers so siblings see this peer's message.
        manager.broadcastUserMessage(text, messageId, attachments as never);
      },
    });
    const sender = new FakeChannel();
    const sibling = new FakeChannel();
    manager.addFollower('sender', sender);
    manager.addFollower('sibling', sibling);

    // Discard the initial snapshots from both channels so the slice
    // below reflects only the re-broadcast.
    sender.sent.length = 0;
    sibling.sent.length = 0;

    sender.simulateMessage({
      type: 'user_message',
      text: 'hi from peer',
      messageId: 'peer-msg-1',
    });

    // The leader callback got the follower's message exactly once.
    expect(onFollowerMessageMock).toHaveBeenCalledTimes(1);
    expect(onFollowerMessageMock).toHaveBeenCalledWith('hi from peer', 'peer-msg-1', undefined);

    // Both channels received the re-broadcast `user_message_echo`.
    // The sender's `FollowerSyncManager.sentMessageIds` is what drops
    // the echo on the sender — that lives in the follower-sync tests
    // (`tray-follower-sync.test.ts: only deduplicates each message ID
    // once`). Here we verify only the leader-side: the message went
    // out on every channel, exactly once.
    const senderEchoes = sender
      .parseSent()
      .filter(
        (m): m is LeaderToFollowerMessage & { type: 'user_message_echo' } =>
          m.type === 'user_message_echo'
      );
    const siblingEchoes = sibling
      .parseSent()
      .filter(
        (m): m is LeaderToFollowerMessage & { type: 'user_message_echo' } =>
          m.type === 'user_message_echo'
      );
    expect(senderEchoes).toHaveLength(1);
    expect(siblingEchoes).toHaveLength(1);
    expect(senderEchoes[0].messageId).toBe('peer-msg-1');
    expect(siblingEchoes[0].messageId).toBe('peer-msg-1');
    expect(senderEchoes[0].text).toBe('hi from peer');
    expect(siblingEchoes[0].text).toBe('hi from peer');
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

    it('getTargets filters out stale remote targets for disconnected followers', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      manager.setLocalTargets([
        { targetId: 'lt1', title: 'Leader Tab', url: 'https://leader.com' },
      ]);
      channel.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Remote Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      // Simulate stale registry/runtime mapping state where the follower has disconnected
      // but a remote target entry still remains cached.
      (manager as any).followers.delete('b1');

      expect(manager.getTargets()).toEqual([
        expect.objectContaining({ runtimeId: 'leader', localTargetId: 'lt1' }),
      ]);
    });

    it('broadcastTargetRegistry filters out stale remote targets for disconnected followers', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      manager.setLocalTargets([
        { targetId: 'lt1', title: 'Leader Tab', url: 'https://leader.com' },
      ]);
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Remote Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      ch2.sent.length = 0;
      (manager as any).followers.delete('b1');

      manager.broadcastTargetRegistry();

      const sent = ch2.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('targets.registry');
      if (sent[0].type === 'targets.registry') {
        expect(sent[0].targets).toEqual([
          expect.objectContaining({ runtimeId: 'leader', localTargetId: 'lt1' }),
        ]);
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

    it('new follower initial registry excludes stale disconnected runtimes', () => {
      const { manager } = createManager();
      const ch1 = new FakeChannel();
      manager.addFollower('b1', ch1);

      manager.setLocalTargets([
        { targetId: 'lt1', title: 'Leader Tab', url: 'https://leader.com' },
      ]);
      ch1.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'tab1', title: 'Remote Tab', url: 'https://example.com' }],
        runtimeId: 'follower-b1',
      });

      (manager as any).followers.delete('b1');

      const ch2 = new FakeChannel();
      manager.addFollower('b2', ch2);

      const sent = ch2.parseSent();
      expect(sent).toHaveLength(2);
      expect(sent[0].type).toBe('snapshot');
      expect(sent[1].type).toBe('targets.registry');
      if (sent[1].type === 'targets.registry') {
        expect(sent[1].targets).toEqual([
          expect.objectContaining({ runtimeId: 'leader', localTargetId: 'lt1' }),
        ]);
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
      const response = sent.find((m) => m.type === 'cdp.response');
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
      const response = sent.find((m) => m.type === 'cdp.response');
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
      const response = sent1.find((m) => m.type === 'cdp.response');
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
      const response = sent.find((m) => m.type === 'tab.opened');
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
      const response = sent.find((m) => m.type === 'tab.open.error');
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
      const response = sent1.find((m) => m.type === 'tab.opened');
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
      const response = sent1.find((m) => m.type === 'tab.open.error');
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
      const tabOpenMsg = sent.find((m) => m.type === 'tab.open');
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

      await expect(manager.openRemoteTab('unknown', 'https://example.com')).rejects.toThrow(
        'not connected'
      );
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
      const response = sent.find((m) => m.type === 'fs.response');
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
      const response = sent.find((m) => m.type === 'fs.response');
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
        response: {
          ok: true,
          data: { type: 'file', content: 'remote content', encoding: 'utf-8' },
        },
      } as any);

      const sent1 = ch1.parseSent();
      const response = sent1.find((m) => m.type === 'fs.response');
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
      const fsReq = sent.find((m) => m.type === 'fs.request');
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

      const responses = await manager.sendFsRequest('leader', {
        op: 'readFile',
        path: '/local.txt',
      });
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
      manager.addFollower('b1', ch, {
        runtime: 'slicc-standalone',
        connectedAt: new Date().toISOString(),
      });

      // Not visible yet: getConnectedFollowers() is keyed by the runtimeId
      // mapping, which only exists after the follower advertises targets.
      expect(manager.getConnectedFollowers()).toHaveLength(0);
      // Verify floatType/lastActivity via the internal state by advertising targets
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
      expect(followers.find((f) => f.runtimeId === 'f1')?.floatType).toBe('standalone');
      expect(followers.find((f) => f.runtimeId === 'f2')?.floatType).toBe('extension');
      expect(followers.find((f) => f.runtimeId === 'f3')?.floatType).toBe('electron');
      expect(followers.find((f) => f.runtimeId === 'f4')?.floatType).toBe('unknown');
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

    it('excludes a cherry follower by runtime tag even before it advertises targets', () => {
      const { manager } = createManager();

      const ch = new FakeChannel();
      manager.addFollower('b1', ch, { runtime: CHERRY_RUNTIME_TAG });
      // No advertise yet — the runtime-tag short-circuit must still exclude it,
      // so it is never offered as a teleport target.
      expect(manager.getBestFollowerForTeleport()).toBeNull();
    });

    it('skips a cherry follower and selects the real browser follower', () => {
      const { manager } = createManager();

      const chCherry = new FakeChannel();
      manager.addFollower('b1', chCherry, { runtime: CHERRY_RUNTIME_TAG });
      chCherry.simulateMessage({
        type: 'targets.advertise',
        targets: [
          {
            targetId: 'host',
            title: 'Host',
            url: 'https://host.example',
            kind: 'cherry',
            capabilities: { navigate: true, network: false, screenshot: true },
          },
        ],
        runtimeId: 'f-cherry',
      });

      const chStd = new FakeChannel();
      manager.addFollower('b2', chStd, { runtime: 'slicc-standalone' });
      chStd.simulateMessage({ type: 'targets.advertise', targets: [], runtimeId: 'f-std' });

      const best = manager.getBestFollowerForTeleport();
      expect(best!.runtimeId).toBe('f-std');
    });

    it('excludes a non-cherry-tagged follower whose advertised targets are all cherry', () => {
      const { manager } = createManager();

      // Runtime tag is not cherry, but every advertised target is — so it
      // cannot serve a network-requiring teleport and must be excluded.
      const ch = new FakeChannel();
      manager.addFollower('b1', ch, { runtime: 'slicc-standalone' });
      ch.simulateMessage({
        type: 'targets.advertise',
        targets: [
          {
            targetId: 'host',
            title: 'Host',
            url: 'https://host.example',
            kind: 'cherry',
            capabilities: { navigate: true, network: false, screenshot: true },
          },
        ],
        runtimeId: 'f-allcherry',
      });

      expect(manager.getBestFollowerForTeleport()).toBeNull();
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

  // ---------------------------------------------------------------------------
  // Sprinkle sync — close coverage gap for the leader side. Mirrors the iOS
  // follower's expectations against the protocol described in
  // `tray-sync-protocol.ts` + `packages/ios-app/SliccFollower/App/AppState.swift`.
  // ---------------------------------------------------------------------------

  describe('sprinkle sync', () => {
    function makeSprinkles(): import('../../src/scoops/tray-sync-protocol.js').SprinkleSummary[] {
      return [
        {
          name: 'welcome',
          title: 'Welcome',
          path: '/shared/sprinkles/welcome.shtml',
          open: true,
          autoOpen: true,
          icon: 'rocket',
        },
        {
          name: 'todo',
          title: 'Todo',
          path: '/workspace/sprinkles/todo.shtml',
          open: false,
          autoOpen: false,
        },
      ];
    }

    it('sends a sprinkles.list on addFollower when getSprinkles is provided', () => {
      const sprinkles = makeSprinkles();
      const { manager } = createManager({ getSprinkles: () => sprinkles });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      const listMessages = channel.parseSent().filter((m) => m.type === 'sprinkles.list');
      expect(listMessages).toHaveLength(1);
      if (listMessages[0].type === 'sprinkles.list') {
        expect(listMessages[0].sprinkles).toEqual(sprinkles);
      }
    });

    it('omits sprinkles.list when getSprinkles is not provided', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      const listMessages = channel.parseSent().filter((m) => m.type === 'sprinkles.list');
      expect(listMessages).toHaveLength(0);
    });

    it('broadcastSprinklesList sends the current list to every follower', () => {
      const sprinkles = makeSprinkles();
      const { manager } = createManager({ getSprinkles: () => sprinkles });
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);

      // Reset to ignore the initial-attach broadcasts.
      ch1.sent.length = 0;
      ch2.sent.length = 0;

      manager.broadcastSprinklesList();

      expect(ch1.parseSent()).toEqual([{ type: 'sprinkles.list', sprinkles }]);
      expect(ch2.parseSent()).toEqual([{ type: 'sprinkles.list', sprinkles }]);
    });

    it('broadcastSprinkleUpdate sends sprinkle.update to every follower', () => {
      const { manager } = createManager({ getSprinkles: () => makeSprinkles() });
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);
      ch1.sent.length = 0;
      ch2.sent.length = 0;

      manager.broadcastSprinkleUpdate('welcome', { progress: 0.5 });

      const expected = {
        type: 'sprinkle.update',
        sprinkleName: 'welcome',
        data: { progress: 0.5 },
      };
      expect(ch1.parseSent()).toEqual([expected]);
      expect(ch2.parseSent()).toEqual([expected]);
    });

    it('broadcastPreviewOpen sends preview.open to every follower', () => {
      const { manager } = createManager({ getSprinkles: () => makeSprinkles() });
      const ch1 = new FakeChannel();
      const ch2 = new FakeChannel();
      manager.addFollower('b1', ch1);
      manager.addFollower('b2', ch2);
      ch1.sent.length = 0;
      ch2.sent.length = 0;

      manager.broadcastPreviewOpen('https://abc--def.sliccy.now/index.html');

      for (const ch of [ch1, ch2]) {
        const sent = ch.parseSent();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({
          type: 'preview.open',
          url: 'https://abc--def.sliccy.now/index.html',
        });
        expect((sent[0] as { requestId: string }).requestId).toMatch(/^prv-/);
      }
    });

    it('broadcastPreviewOpen is a no-op when no followers are connected', () => {
      const { manager } = createManager({ getSprinkles: () => makeSprinkles() });
      // No throws, no broadcast — the early-return on followers.size === 0 path.
      expect(() => manager.broadcastPreviewOpen('https://x.sliccy.now/')).not.toThrow();
    });

    it('sprinkles.refresh from follower triggers a fresh sprinkles.list reply', () => {
      const sprinkles = makeSprinkles();
      const { manager } = createManager({ getSprinkles: () => sprinkles });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({ type: 'sprinkles.refresh' });

      const sent = channel.parseSent();
      expect(sent).toEqual([{ type: 'sprinkles.list', sprinkles }]);
    });

    it('sprinkle.fetch with small content replies with a single sprinkle.content', async () => {
      const readSprinkleContent = vi.fn(async (name: string) => `<p>${name}</p>`);
      const { manager } = createManager({ readSprinkleContent });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({
        type: 'sprinkle.fetch',
        requestId: 'req-1',
        sprinkleName: 'welcome',
      });

      // Allow the async read + send to flush.
      await new Promise((r) => setTimeout(r, 0));

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        type: 'sprinkle.content',
        requestId: 'req-1',
        sprinkleName: 'welcome',
        content: '<p>welcome</p>',
      });
      expect(readSprinkleContent).toHaveBeenCalledWith('welcome');
    });

    it('sprinkle.fetch with large content chunks the sprinkle.content reply', async () => {
      // Threshold is 64KB; chunk size is 32KB. Build a 100KB payload to force chunking.
      const largeContent = 'x'.repeat(100_000);
      const readSprinkleContent = vi.fn(async () => largeContent);
      const { manager } = createManager({ readSprinkleContent });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({ type: 'sprinkle.fetch', requestId: 'req-1', sprinkleName: 'big' });
      await new Promise((r) => setTimeout(r, 0));

      const sent = channel.parseSent();
      // ceil(100000 / 32768) = 4 chunks.
      expect(sent).toHaveLength(4);
      const reassembled = sent
        .map((m) => {
          if (m.type !== 'sprinkle.content') throw new Error('unexpected message type');
          expect(m.totalChunks).toBe(4);
          return m.content;
        })
        .join('');
      expect(reassembled).toBe(largeContent);
    });

    it('sprinkle.fetch replies with error when reader returns null', async () => {
      const readSprinkleContent = vi.fn(async () => null);
      const { manager } = createManager({ readSprinkleContent });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({ type: 'sprinkle.fetch', requestId: 'req-1', sprinkleName: 'gone' });
      await new Promise((r) => setTimeout(r, 0));

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      if (sent[0].type !== 'sprinkle.content') throw new Error('unexpected');
      expect(sent[0].error).toMatch(/not found/i);
    });

    it('sprinkle.fetch replies with error when no readSprinkleContent is wired', async () => {
      const { manager } = createManager(); // No reader.
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({ type: 'sprinkle.fetch', requestId: 'req-1', sprinkleName: 'x' });
      await new Promise((r) => setTimeout(r, 0));

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      if (sent[0].type !== 'sprinkle.content') throw new Error('unexpected');
      expect(sent[0].error).toMatch(/reader/i);
    });

    it('sprinkle.fetch replies with error when reader throws', async () => {
      const readSprinkleContent = vi.fn(async () => {
        throw new Error('disk full');
      });
      const { manager } = createManager({ readSprinkleContent });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      channel.sent.length = 0;

      channel.simulateMessage({ type: 'sprinkle.fetch', requestId: 'req-1', sprinkleName: 'x' });
      await new Promise((r) => setTimeout(r, 0));

      const sent = channel.parseSent();
      expect(sent).toHaveLength(1);
      if (sent[0].type !== 'sprinkle.content') throw new Error('unexpected');
      expect(sent[0].error).toBe('disk full');
    });

    it('sprinkle.lick invokes onSprinkleLick with name, body, targetScoop, and origin label', () => {
      const onSprinkleLick = vi.fn();
      const { manager } = createManager({ onSprinkleLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-ios' });

      channel.simulateMessage({
        type: 'sprinkle.lick',
        sprinkleName: 'welcome',
        body: { action: 'click' },
        targetScoop: 'scoop-1',
      });

      expect(onSprinkleLick).toHaveBeenCalledWith(
        'welcome',
        { action: 'click' },
        'scoop-1',
        'iOS follower'
      );
    });

    it('sprinkle.lick is safe when onSprinkleLick is not wired', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      expect(() =>
        channel.simulateMessage({
          type: 'sprinkle.lick',
          sprinkleName: 'welcome',
          body: { action: 'click' },
        })
      ).not.toThrow();
    });

    it('onSprinkleLick throwing does not break the channel', () => {
      const onSprinkleLick = vi.fn(() => {
        throw new Error('handler bug');
      });
      const { manager } = createManager({ onSprinkleLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      expect(() =>
        channel.simulateMessage({
          type: 'sprinkle.lick',
          sprinkleName: 'welcome',
          body: { action: 'click' },
        })
      ).not.toThrow();

      // Subsequent messages still route normally.
      channel.simulateMessage({
        type: 'sprinkle.lick',
        sprinkleName: 'welcome',
        body: { action: 'second' },
      });
      expect(onSprinkleLick).toHaveBeenCalledTimes(2);
    });
  });

  describe('inbound generic lick', () => {
    it('stamps origin from the connection and calls onForwardedLick', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      channel.simulateMessage({
        type: 'lick',
        event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
      });

      expect(onForwardedLick).toHaveBeenCalledTimes(1);
      const [event, bootstrapId] = onForwardedLick.mock.calls[0];
      expect(bootstrapId).toBe('b1');
      expect(event).toMatchObject({
        type: 'navigate',
        originFollowerId: 'b1',
        originLabel: 'extension follower',
      });
    });

    it('preserves discovery ARD fields and stamps origin on a forwarded discovery lick', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      channel.simulateMessage({
        type: 'lick',
        event: {
          type: 'discovery',
          timestamp: 't',
          discoveryOrigin: 'https://shop.example',
          discoveryKind: 'ai-catalog',
          discoveryUrl: 'https://shop.example/.well-known/ai-catalog.json',
          body: {
            origin: 'https://shop.example',
            kind: 'ai-catalog',
            url: 'https://shop.example/.well-known/ai-catalog.json',
            targetId: 't1',
          },
        },
      } as unknown as FollowerToLeaderMessage);

      expect(onForwardedLick).toHaveBeenCalledTimes(1);
      const [event, bootstrapId] = onForwardedLick.mock.calls[0];
      expect(bootstrapId).toBe('b1');
      expect(event).toMatchObject({
        type: 'discovery',
        discoveryOrigin: 'https://shop.example',
        discoveryKind: 'ai-catalog',
        discoveryUrl: 'https://shop.example/.well-known/ai-catalog.json',
        originFollowerId: 'b1',
        originLabel: 'extension follower',
      });
    });

    it('rejects a non-forwardable lick type', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      channel.simulateMessage({
        type: 'lick',
        event: { type: 'webhook', timestamp: 't', body: {} },
      } as unknown as FollowerToLeaderMessage);

      expect(onForwardedLick).not.toHaveBeenCalled();
    });

    it('scrubs follower-sent origin fields before stamping', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      channel.simulateMessage({
        type: 'lick',
        event: {
          type: 'navigate',
          navigateUrl: 'https://x',
          timestamp: 't',
          body: {},
          originFollowerId: 'SPOOFED',
          originLabel: 'SPOOFED',
        },
      } as unknown as FollowerToLeaderMessage);

      const [event] = onForwardedLick.mock.calls[0];
      expect(event.originFollowerId).toBe('b1');
      expect(event.originLabel).toBe('extension follower');
    });

    it('drops a follower-supplied targetScoop so forwarded licks target the cone', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      channel.simulateMessage({
        type: 'lick',
        event: {
          type: 'navigate',
          navigateUrl: 'https://x',
          timestamp: 't',
          body: {},
          targetScoop: 'some-scoop',
        },
      } as unknown as FollowerToLeaderMessage);

      expect(onForwardedLick).toHaveBeenCalledTimes(1);
      const [event] = onForwardedLick.mock.calls[0];
      expect(event.targetScoop).toBeUndefined();
    });

    it('ignores a lick message with a missing event without crashing or forwarding', () => {
      const onForwardedLick = vi.fn();
      const { manager } = createManager({ onForwardedLick });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

      expect(() =>
        channel.simulateMessage({ type: 'lick' } as unknown as FollowerToLeaderMessage)
      ).not.toThrow();
      expect(onForwardedLick).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Cherry event routing + tab.open gating (leader side)
  // ---------------------------------------------------------------------------

  describe('cherry leader-side methods', () => {
    it('routes cherry.host_event to onCherryHostEvent with the owning runtime id', () => {
      const onCherryHostEvent = vi.fn();
      const { manager } = createManager({ onCherryHostEvent });
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      // Advertise so the bootstrapId maps to a runtimeId.
      channel.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'host1', title: 'Host', url: 'https://host.com' }],
        runtimeId: 'follower-b1',
      });

      channel.simulateMessage({
        type: 'cherry.host_event',
        targetId: 'follower-b1:host1',
        name: 'cart.updated',
        detail: { items: 3 },
      });

      expect(onCherryHostEvent).toHaveBeenCalledTimes(1);
      expect(onCherryHostEvent).toHaveBeenCalledWith('follower-b1', 'cart.updated', { items: 3 });
    });

    it('drops cherry.host_event without throwing when no onCherryHostEvent is wired', () => {
      const { manager } = createManager(); // No onCherryHostEvent.
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      expect(() =>
        channel.simulateMessage({
          type: 'cherry.host_event',
          targetId: 'follower-b1:host1',
          name: 'cart.updated',
          detail: { items: 3 },
        })
      ).not.toThrow();
    });

    it('emitCherrySliccEvent returns false for an unknown/disconnected runtime', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);
      // No targets.advertise → no runtimeToBootstrap mapping for 'ghost'.

      expect(manager.emitCherrySliccEvent('ghost:host1', 'open', { x: 1 })).toBe(false);
    });

    it('emitCherrySliccEvent sends cherry.slicc_event over the owning follower channel', () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      channel.simulateMessage({
        type: 'targets.advertise',
        targets: [{ targetId: 'host1', title: 'Host', url: 'https://host.com' }],
        runtimeId: 'follower-b1',
      });
      channel.sent.length = 0;

      const ok = manager.emitCherrySliccEvent('follower-b1:host1', 'open', { x: 1 });
      expect(ok).toBe(true);

      const sent = channel.parseSent();
      const evt = sent.find((m) => m.type === 'cherry.slicc_event');
      expect(evt).toBeDefined();
      if (evt && evt.type === 'cherry.slicc_event') {
        expect(evt.targetId).toBe('follower-b1:host1');
        expect(evt.name).toBe('open');
        expect(evt.detail).toEqual({ x: 1 });
      }
    });

    it('openRemoteTab refuses a runtime whose advertised targets are all cherry', async () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      channel.simulateMessage({
        type: 'targets.advertise',
        targets: [
          {
            targetId: 'host1',
            title: 'Host',
            url: 'https://host.com',
            kind: 'cherry',
            capabilities: { navigate: true, network: false, screenshot: true },
          },
        ],
        runtimeId: 'follower-b1',
      });

      await expect(manager.openRemoteTab('follower-b1', 'https://new.com')).rejects.toThrow(
        /cherry host that cannot open tabs/i
      );
    });

    it('openRemoteTab allows a runtime with at least one browser target', async () => {
      const { manager } = createManager();
      const channel = new FakeChannel();
      manager.addFollower('b1', channel);

      channel.simulateMessage({
        type: 'targets.advertise',
        targets: [
          {
            targetId: 'host1',
            title: 'Host',
            url: 'https://host.com',
            kind: 'cherry',
            capabilities: { navigate: true, network: false, screenshot: true },
          },
          { targetId: 'tab1', title: 'Real Tab', url: 'https://real.com', kind: 'browser' },
        ],
        runtimeId: 'follower-b1',
      });
      channel.sent.length = 0;

      const promise = manager.openRemoteTab('follower-b1', 'https://new.com');

      // It should NOT have rejected synchronously — instead it sent a tab.open.
      const sent = channel.parseSent();
      const tabOpen = sent.find((m) => m.type === 'tab.open');
      expect(tabOpen).toBeDefined();
      if (tabOpen && tabOpen.type === 'tab.open') {
        channel.simulateMessage({
          type: 'tab.opened',
          requestId: tabOpen.requestId,
          targetId: 'follower-b1:new-99',
        });
      }
      await expect(promise).resolves.toBe('follower-b1:new-99');
    });
  });
});

describe('cherry teleport selection', () => {
  const browserTarget = { targetId: 'b', kind: 'browser' as const };
  const cherryTarget = {
    targetId: 'c',
    kind: 'cherry' as const,
    capabilities: { navigate: true, network: false, screenshot: true },
  };

  it('isCherryTarget detects cherry kind', () => {
    expect(isCherryTarget(cherryTarget)).toBe(true);
    expect(isCherryTarget(browserTarget)).toBe(false);
  });

  it('selectTeleportPool excludes cherry targets when network is required', () => {
    const pool = selectTeleportPool([browserTarget, cherryTarget], { requireNetwork: true });
    expect(pool.map((t) => t.targetId)).toEqual(['b']);
  });

  it('selectTeleportPool includes cherry targets when network is not required', () => {
    const pool = selectTeleportPool([browserTarget, cherryTarget], { requireNetwork: false });
    expect(pool.map((t) => t.targetId).sort()).toEqual(['b', 'c']);
  });

  it('selectTeleportPool includes a cherry target that advertises network when network is required', () => {
    const networkCherry = {
      targetId: 'nc',
      kind: 'cherry' as const,
      capabilities: { navigate: true, network: true, screenshot: true },
    };
    const pool = selectTeleportPool([browserTarget, networkCherry], { requireNetwork: true });
    expect(pool.map((t) => t.targetId).sort()).toEqual(['b', 'nc']);
  });

  it('fires onRemoteTransportsCleaned for each mapped runtime when a follower is removed', () => {
    const onRemoteTransportsCleaned = vi.fn();
    const { manager } = createManager({ onRemoteTransportsCleaned });
    const ch1 = new FakeChannel();
    manager.addFollower('b1', ch1);
    // Advertise so runtimeToBootstrap maps 'follower-b1' → 'b1'.
    ch1.simulateMessage({
      type: 'targets.advertise',
      targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
      runtimeId: 'follower-b1',
    });
    manager.removeFollower('b1');
    expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('follower-b1');
  });
});

describe('version handshake', () => {
  it('sends hello as the first message on addFollower', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const first = JSON.parse(channel.sent[0]) as { type: string; protocolVersion: number };
    expect(first.type).toBe('hello');
    expect(first.protocolVersion).toBe(1);
  });

  it('warns when a follower speaks a newer protocol version', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      channel.simulateMessage({ type: 'hello', protocolVersion: 999 });
      const warned = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warned).toContain('newer tray sync protocol');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('diagnoses a legacy follower once when the first message is not hello', () => {
    // Earlier tests in this file also trip the legacy diagnosis; clear the
    // module-global dedup buffer so this instance's log is not suppressed.
    resetLoggerDedupForTests();
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      channel.simulateMessage({ type: 'abort' });
      channel.simulateMessage({ type: 'abort' });
      const infos = infoSpy.mock.calls.flat().map(String).join('\n');
      const matches = infos.match(/legacy peer \(pre-versioning build\)/g) ?? [];
      expect(matches).toHaveLength(1);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe('protocol drift safety', () => {
  it('warns but does not throw on an unknown follower message type', () => {
    const { manager } = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        channel.simulateMessage({ type: 'future.feature' } as unknown as FollowerToLeaderMessage)
      ).not.toThrow();
      const warned = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warned).toContain('Unknown follower message type');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
