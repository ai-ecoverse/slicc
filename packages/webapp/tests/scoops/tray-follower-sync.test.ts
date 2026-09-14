import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import type { AgentEvent } from '../../src/core/agent-types.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerTrayRuntimeStatus,
} from '../../src/scoops/tray-follower-status.js';
import {
  FollowerSyncManager,
  shouldApplyFollowerStatus,
} from '../../src/scoops/tray-follower-sync.js';
import {
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayTargetEntry,
} from '../../src/scoops/tray-sync-protocol.js';
import { FakeChannel } from './tray-follower/fake-channel.js';

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

    it('marks a steering send so the leader interrupts its running turn', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.sendMessage('interrupt', 'msg-1', undefined, { steer: true });

      const sent = channel.parseSent();
      expect(sent[0]).toEqual({
        type: 'user_message',
        text: 'interrupt',
        messageId: 'msg-1',
        steer: true,
      });
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

  describe('theme handling', () => {
    it('delegates theme.apply messages to the injected UI callback', () => {
      const channel = new FakeChannel();
      const onThemeApply = vi.fn();
      new FollowerSyncManager(channel, { onThemeApply });

      channel.simulateLeaderMessage({ type: 'theme.apply', themeJson: '{"id":"leader"}' });
      channel.simulateLeaderMessage({ type: 'theme.apply', themeJson: null });

      expect(onThemeApply).toHaveBeenNthCalledWith(1, '{"id":"leader"}');
      expect(onThemeApply).toHaveBeenNthCalledWith(2, null);
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

      follower.sendMessage('hello from follower', 'msg-123');

      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from follower',
        messageId: 'msg-123',
        scoopJid: 'cone',
      });

      expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('displays user_message_echo from other sources (not own)', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'hello from leader',
        messageId: 'msg-456',
        scoopJid: 'cone',
      });

      expect(onUserMessage).toHaveBeenCalledWith('hello from leader', 'msg-456', 'cone', undefined);
    });

    it('only deduplicates each message ID once (single use)', () => {
      const channel = new FakeChannel();
      const onUserMessage = vi.fn();
      const follower = new FollowerSyncManager(channel, { onUserMessage });

      follower.sendMessage('repeat test', 'msg-789');

      channel.simulateLeaderMessage({
        type: 'user_message_echo',
        text: 'repeat test',
        messageId: 'msg-789',
        scoopJid: 'cone',
      });
      expect(onUserMessage).not.toHaveBeenCalled();

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
    it('forwards the status scoop identity to the callback', () => {
      const channel = new FakeChannel();
      const onStatus = vi.fn();
      const follower = new FollowerSyncManager(channel, { onStatus });

      channel.simulateLeaderMessage({
        type: 'status',
        scoopStatus: 'processing',
        scoopJid: 'cone',
      });

      expect(onStatus).toHaveBeenCalledWith('processing', 'cone');
      void follower;
    });

    it('applies only the viewed scoop status while preserving legacy unscoped updates', () => {
      expect(shouldApplyFollowerStatus('research', 'cone')).toBe(false);
      expect(shouldApplyFollowerStatus('cone', 'cone')).toBe(true);
      expect(shouldApplyFollowerStatus(undefined, 'cone')).toBe(true);
    });

    it('forwards a legacy status without scoopJid instead of dropping it', () => {
      const channel = new FakeChannel();
      const onStatus = vi.fn();
      const follower = new FollowerSyncManager(channel, { onStatus });

      channel.simulateLeaderMessage({ type: 'status', scoopStatus: 'ready' });

      expect(onStatus).toHaveBeenCalledWith('ready', undefined);
      void follower;
    });
  });

  describe('model and thinking sync', () => {
    it('forwards model catalog and selection state broadcasts to callbacks', () => {
      const channel = new FakeChannel();
      const onModelsList = vi.fn();
      const onModelState = vi.fn();
      new FollowerSyncManager(channel, { onModelsList, onModelState });
      const models = [
        {
          providerName: 'Anthropic',
          modelId: 'anthropic:claude-sonnet-4-6',
          modelName: 'Claude Sonnet 4.6',
          reasoning: true,
        },
      ];
      const state = {
        activeModelId: 'anthropic:claude-sonnet-4-6',
        scoopJid: 'cone-jid',
        thinkingLevel: 'high' as const,
      };

      channel.simulateLeaderMessage({ type: 'models.list', models });
      channel.simulateLeaderMessage({ type: 'model.state', state });

      expect(onModelsList).toHaveBeenCalledWith(models);
      expect(onModelState).toHaveBeenCalledWith(state);
    });

    it('sends model and thinking selections to the leader', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.selectModel('anthropic:claude-opus-4-8');
      follower.setThinkingLevel('scoop-1', 'xhigh', 'max');

      expect(channel.parseSent()).toEqual([
        { type: 'model.select', modelId: 'anthropic:claude-opus-4-8' },
        {
          type: 'thinking.set',
          scoopJid: 'scoop-1',
          thinkingLevel: 'xhigh',
          effortOverride: 'max',
        },
      ]);
    });

    it('requests models only after a v5+ leader hello', () => {
      const legacyChannel = new FakeChannel();
      new FollowerSyncManager(legacyChannel);
      legacyChannel.simulateLeaderMessage({ type: 'hello', protocolVersion: 4 });
      expect(legacyChannel.parseSent()).toEqual([]);

      const currentChannel = new FakeChannel();
      new FollowerSyncManager(currentChannel);
      currentChannel.simulateLeaderMessage({ type: 'hello', protocolVersion: 5 });
      expect(currentChannel.parseSent()).toEqual([{ type: 'models.request' }]);
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

    it('requests a preserved scoop for reconnect registration', () => {
      const channel = new FakeChannel();
      const follower = new FollowerSyncManager(channel);

      follower.requestSnapshot('research');

      expect(channel.parseSent()).toEqual([{ type: 'request_snapshot', scoopJid: 'research' }]);
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

    it('updates status WITHOUT emitting a transcript error event when channel closes (#1707)', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const follower = new FollowerSyncManager(channel, { onDisconnect });
      const events: AgentEvent[] = [];
      follower.onEvent((e) => events.push(e));

      channel.simulateClose();

      expect(events).toHaveLength(0);
      const status = getFollowerTrayRuntimeStatus();
      expect(status.state).toBe('error');
      expect(status.error).toBe('Data channel closed');
      expect(onDisconnect).toHaveBeenCalledWith('Data channel closed');
    });

    it('updates status WITHOUT emitting a transcript error event when channel errors (#1707)', () => {
      const channel = new FakeChannel();
      const onDisconnect = vi.fn();
      const follower = new FollowerSyncManager(channel, { onDisconnect });
      const events: AgentEvent[] = [];
      follower.onEvent((e) => events.push(e));

      channel.simulateError();

      expect(events).toHaveLength(0);
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

      channel.simulateClose();
      channel.simulateError();

      expect(events).toHaveLength(0);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });

    it('does NOT disconnect while the channel is open — a stalled leader is not a dead one', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onDead = vi.fn();
        const onDisconnect = vi.fn();
        const events: AgentEvent[] = [];
        const follower = new FollowerSyncManager(channel, { onDead, onDisconnect });
        follower.onEvent((event) => events.push(event));

        vi.advanceTimersByTime(10 * 10_000);

        expect(onDisconnect).not.toHaveBeenCalled();
        expect(onDead).not.toHaveBeenCalled();
        expect(channel.readyState).toBe('open');
        expect(events).toHaveLength(0);
        expect(getFollowerTrayRuntimeStatus().state).toBe('connected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports the stall so the UI can say "busy" instead of "disconnected"', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onLeaderStalled = vi.fn();
        const onDisconnect = vi.fn();
        const follower = new FollowerSyncManager(channel, { onLeaderStalled, onDisconnect });

        vi.advanceTimersByTime(10 * 10_000);

        expect(onLeaderStalled).toHaveBeenCalledTimes(1);
        expect(onLeaderStalled).toHaveBeenCalledWith(true);
        expect(onDisconnect).not.toHaveBeenCalled();

        const status = getFollowerTrayRuntimeStatus();
        expect(status.state).toBe('connected');
        expect(status.stalled).toBe(true);

        channel.simulateLeaderMessage({ type: 'pong' });

        expect(onLeaderStalled).toHaveBeenLastCalledWith(false);
        expect(getFollowerTrayRuntimeStatus().stalled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the stall overlay when the connection really ends', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const follower = new FollowerSyncManager(channel, {});

        vi.advanceTimersByTime(10 * 10_000);
        expect(getFollowerTrayRuntimeStatus().stalled).toBe(true);

        channel.simulateClose();

        const status = getFollowerTrayRuntimeStatus();
        expect(status.state).toBe('error');
        expect(status.stalled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumes normally when a stalled leader starts answering again', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onDisconnect = vi.fn();
        const follower = new FollowerSyncManager(channel, { onDisconnect });

        vi.advanceTimersByTime(10 * 10_000);
        channel.simulateLeaderMessage({ type: 'pong' });
        vi.advanceTimersByTime(10 * 10_000);

        expect(onDisconnect).not.toHaveBeenCalled();
        expect(channel.readyState).toBe('open');
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls onDisconnect once the keepalive hard deadline passes', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onDead = vi.fn();
        const onDisconnect = vi.fn();
        const follower = new FollowerSyncManager(channel, { onDead, onDisconnect });

        vi.advanceTimersByTime(31 * 10_000);

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

    it('disconnects promptly when the channel is closed, not stalled', () => {
      vi.useFakeTimers();
      try {
        const channel = new FakeChannel();
        const onDisconnect = vi.fn();
        const follower = new FollowerSyncManager(channel, { onDisconnect });

        channel.readyState = 'closed';
        vi.advanceTimersByTime(4 * 10_000);

        expect(onDisconnect).toHaveBeenCalledWith('Keepalive timeout — leader not responding');
      } finally {
        vi.useRealTimers();
      }
    });
  });

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
          parentJid: null,
          assistantLabel: 'sliccy',
          state: 'working' as const,
          fill: 64,
        },
        {
          jid: 'scoop-1',
          name: 'research',
          folder: '/scoops/research',
          isCone: false,
          parentJid: 'cone-jid',
          assistantLabel: 'research',
          state: 'broken' as const,
          fill: 82,
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
      expect(first.protocolVersion).toBe(TRAY_SYNC_PROTOCOL_VERSION);
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
