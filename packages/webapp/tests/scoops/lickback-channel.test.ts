/**
 * LickbackAgentHandle — the page-side AgentHandle that drives the chat panel
 * from an external brain over the lick-back wire. `sendMessage` emits a chat
 * push; inbound reply frames translate to ordered AgentEvents
 * (`message_start → content_delta* → content_done → turn_end`). Mirrors the
 * tray-follower handle, but the transport is loopback HTTP instead of WebRTC.
 */
import { describe, expect, it } from 'vitest';
import { LickbackAgentHandle } from '../../src/scoops/lickback-channel.js';
import type { LickbackReplyFrame } from '../../src/scoops/lickback-worker-channel.js';
import type { AgentEvent } from '../../src/ui/types.js';

function makeClient() {
  let replyHandler: ((reply: LickbackReplyFrame) => void) | null = null;
  return {
    sent: [] as Array<{ channel: string; event: unknown }>,
    sendLickbackEvent(channel: string, event: unknown) {
      this.sent.push({ channel, event });
    },
    setLickbackReplyHandler(h: ((reply: LickbackReplyFrame) => void) | null) {
      replyHandler = h;
    },
    /** Test helper: simulate an inbound reply frame. */
    reply(frame: LickbackReplyFrame) {
      replyHandler?.(frame);
    },
    hasReplyHandler() {
      return replyHandler !== null;
    },
  };
}

describe('LickbackAgentHandle — outbound', () => {
  it('emits a chat push on sendMessage with the supplied messageId', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    handle.sendMessage('hello brain', 'm1');
    expect(client.sent).toEqual([
      { channel: 'chat', event: { kind: 'chat', text: 'hello brain', msgId: 'm1' } },
    ]);
  });

  it('generates a messageId when none is supplied', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    handle.sendMessage('hi');
    expect(client.sent).toHaveLength(1);
    const event = client.sent[0].event as { kind: string; text: string; msgId: string };
    expect(event.kind).toBe('chat');
    expect(event.text).toBe('hi');
    expect(typeof event.msgId).toBe('string');
    expect(event.msgId.length).toBeGreaterThan(0);
  });

  it('registers a reply handler on construction', () => {
    const client = makeClient();
    new LickbackAgentHandle(client);
    expect(client.hasReplyHandler()).toBe(true);
  });
});

describe('LickbackAgentHandle — inbound reply → AgentEvents', () => {
  function collect(handle: LickbackAgentHandle): AgentEvent[] {
    const events: AgentEvent[] = [];
    handle.onEvent((e) => events.push(e));
    return events;
  }

  it('translates streamed deltas into an ordered turn', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events = collect(handle);

    client.reply({ channel: 'chat', replyTo: 'm1', delta: 'Hel' });
    client.reply({ channel: 'chat', replyTo: 'm1', delta: 'lo' });
    client.reply({ channel: 'chat', replyTo: 'm1', done: true });

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_delta',
      'content_done',
      'turn_end',
    ]);
    const start = events[0] as Extract<AgentEvent, { type: 'message_start' }>;
    const d1 = events[1] as Extract<AgentEvent, { type: 'content_delta' }>;
    const d2 = events[2] as Extract<AgentEvent, { type: 'content_delta' }>;
    const done = events[3] as Extract<AgentEvent, { type: 'content_done' }>;
    const end = events[4] as Extract<AgentEvent, { type: 'turn_end' }>;
    // All five events carry the SAME assistant message id.
    expect(d1.messageId).toBe(start.messageId);
    expect(d2.messageId).toBe(start.messageId);
    expect(done.messageId).toBe(start.messageId);
    expect(end.messageId).toBe(start.messageId);
    expect(d1.text).toBe('Hel');
    expect(d2.text).toBe('lo');
  });

  it('handles a one-shot text+done reply as a full turn', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events = collect(handle);

    client.reply({ channel: 'chat', replyTo: 'm1', text: 'All done', done: true });

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_done',
      'turn_end',
    ]);
    const delta = events[1] as Extract<AgentEvent, { type: 'content_delta' }>;
    expect(delta.text).toBe('All done');
  });

  it('ignores replies for a different channel', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events = collect(handle);
    client.reply({ channel: 'other', replyTo: 'm1', delta: 'x', done: true });
    expect(events).toEqual([]);
  });

  it('closes a stranded turn when a reply for a new user message arrives', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events = collect(handle);

    client.reply({ channel: 'chat', replyTo: 'm1', delta: 'first' }); // no done
    client.reply({ channel: 'chat', replyTo: 'm2', delta: 'second' }); // new turn

    // First turn auto-finalized, second turn opened.
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_done',
      'turn_end',
      'message_start',
      'content_delta',
    ]);
    const firstStart = events[0] as Extract<AgentEvent, { type: 'message_start' }>;
    const secondStart = events[4] as Extract<AgentEvent, { type: 'message_start' }>;
    expect(secondStart.messageId).not.toBe(firstStart.messageId);
  });

  it('stop() finalizes an in-flight turn so the spinner clears', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events = collect(handle);
    client.reply({ channel: 'chat', replyTo: 'm1', delta: 'partial' });
    handle.stop();
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_done',
      'turn_end',
    ]);
  });

  it('onEvent unsubscribe stops further delivery', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    const events: AgentEvent[] = [];
    const off = handle.onEvent((e) => events.push(e));
    client.reply({ channel: 'chat', replyTo: 'm1', delta: 'a' });
    off();
    client.reply({ channel: 'chat', replyTo: 'm1', done: true });
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_delta']);
  });

  it('dispose() detaches the reply handler', () => {
    const client = makeClient();
    const handle = new LickbackAgentHandle(client);
    handle.dispose();
    expect(client.hasReplyHandler()).toBe(false);
  });
});
