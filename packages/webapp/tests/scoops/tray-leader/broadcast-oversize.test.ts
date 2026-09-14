import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/core/agent-types.js';
import { degradeOversizeAgentEvent } from '../../../src/scoops/tray-leader/broadcast.js';
import {
  LeaderSyncManager,
  type LeaderSyncManagerOptions,
} from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';
import { TRAY_MAX_MESSAGE_BYTES } from '../../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../../src/scoops/tray-webrtc.js';

class FakeChannel implements TrayDataChannelLike {
  readyState = 'open';
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  agentEvents(): AgentEvent[] {
    return this.sent
      .map((s) => JSON.parse(s) as LeaderToFollowerMessage)
      .filter(
        (m): m is Extract<LeaderToFollowerMessage, { type: 'agent_event' }> =>
          m.type === 'agent_event'
      )
      .map((m) => m.event);
  }
}

function createManager(overrides?: Partial<LeaderSyncManagerOptions>) {
  const options: LeaderSyncManagerOptions = {
    sendControl: () => {},
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    ...(overrides ?? {}),
  };
  return new LeaderSyncManager(options);
}

function unsendableEvent(): AgentEvent {
  return {
    type: 'tool_result',
    messageId: 'm1',
    toolName: 'bash',
    result: 'x'.repeat(TRAY_MAX_MESSAGE_BYTES + 1),
  };
}

describe('degradeOversizeAgentEvent', () => {
  it('replaces an unbounded tool result with a marker, keeping identity fields', () => {
    const degraded = degradeOversizeAgentEvent({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'x'.repeat(5000),
      isError: true,
    });

    expect(degraded).toEqual({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: '[content too large to sync — view on leader]',
      isError: true,
    });
  });

  it('degrades a screenshot to an error rather than a broken image', () => {
    const degraded = degradeOversizeAgentEvent({ type: 'screenshot', base64: 'AAAA' });
    expect(degraded?.type).toBe('error');
  });

  it('degrades every variant that carries an unbounded field', () => {
    const variants: AgentEvent[] = [
      { type: 'tool_result', messageId: 'm', toolName: 't', result: 'r' },
      { type: 'tool_use_start', messageId: 'm', toolName: 't', toolInput: { a: 1 } },
      { type: 'tool_ui', messageId: 'm', toolName: 't', requestId: 'r', html: '<b>x</b>' },
      { type: 'content_delta', messageId: 'm', text: 'x' },
      { type: 'terminal_output', text: 'x' },
      { type: 'screenshot', base64: 'AAAA' },
    ];
    for (const event of variants) {
      expect(degradeOversizeAgentEvent(event), event.type).not.toBeNull();
    }
  });

  it('returns null for variants with nothing to strip', () => {
    const variants: AgentEvent[] = [
      { type: 'message_start', messageId: 'm' },
      { type: 'content_done', messageId: 'm' },
      { type: 'tool_ui_done', messageId: 'm', requestId: 'r' },
      { type: 'turn_end', messageId: 'm' },
      { type: 'error', error: 'boom' },
    ];
    for (const event of variants) {
      expect(degradeOversizeAgentEvent(event), event.type).toBeNull();
    }
  });
});

describe('LeaderSyncManager oversize broadcast', () => {
  it('sends a marker event when the real one cannot go out', () => {
    const manager = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);
    channel.sent.length = 0;

    manager.broadcastEvent(unsendableEvent());

    const events = channel.agentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'tool_result',
      messageId: 'm1',
      result: '[content too large to sync — view on leader]',
    });
  });

  it('degrades only for the followers that refused it', () => {
    const manager = createManager();
    const healthy = new FakeChannel();
    const congested = new FakeChannel();
    congested.bufferedAmount = 8 * 1024 * 1024;
    manager.addFollower('healthy', healthy);
    manager.addFollower('congested', congested);
    healthy.sent.length = 0;
    congested.sent.length = 0;

    manager.broadcastEvent({
      type: 'tool_result',
      messageId: 'm1',
      toolName: 'bash',
      result: 'x'.repeat(300_000),
    });

    expect(healthy.sent.length).toBeGreaterThan(1);
    expect(congested.agentEvents()).toEqual([
      {
        type: 'tool_result',
        messageId: 'm1',
        toolName: 'bash',
        result: '[content too large to sync — view on leader]',
      },
    ]);
  });

  it('does not send a second event when the failure has no degraded form', () => {
    const manager = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);
    channel.sent.length = 0;
    vi.spyOn(channel, 'send').mockImplementation(() => {
      throw new Error('InvalidStateError');
    });

    manager.broadcastEvent({ type: 'turn_end', messageId: 'm1' });

    expect(channel.sent).toHaveLength(0);
  });

  it('delivers an ordinary oversize event intact via framing', () => {
    const manager = createManager();
    const channel = new FakeChannel();
    manager.addFollower('b1', channel);
    channel.sent.length = 0;

    const event: AgentEvent = { type: 'screenshot', base64: 'A'.repeat(400_000) };
    manager.broadcastEvent(event);

    const frames = channel.sent.map((s) => JSON.parse(s) as { type: string; chunkData?: string });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((f) => f.type === '__chunk')).toBe(true);

    const reassembled = JSON.parse(
      frames.map((f) => f.chunkData ?? '').join('')
    ) as LeaderToFollowerMessage;
    expect(reassembled).toEqual({ type: 'agent_event', event, scoopJid: 'cone' });
  });
});
