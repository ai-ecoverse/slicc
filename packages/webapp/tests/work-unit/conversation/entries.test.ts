/**
 * Ingest: legacy representations → canonical entries (#2275).
 */

import { describe, expect, it } from 'vitest';
import {
  entriesFromAgentMessages,
  entriesFromChatMessages,
} from '../../../src/work-unit/conversation/entries.js';
import { legacyAgentMessages, legacyChatMessages, lickAgentMessages } from './fixtures.js';

describe('entriesFromAgentMessages', () => {
  it('breaks a Pi conversation into its six kinds', () => {
    const entries = entriesFromAgentMessages(legacyAgentMessages());
    expect(entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
      'assistant',
    ]);
  });

  it('numbers entries densely and stably', () => {
    const entries = entriesFromAgentMessages(legacyAgentMessages());
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(entries.map((e) => e.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('is deterministic — the same messages ingest identically', () => {
    expect(entriesFromAgentMessages(legacyAgentMessages())).toEqual(
      entriesFromAgentMessages(legacyAgentMessages())
    );
  });

  it('a growing conversation re-ingests to the stored prefix plus a tail', () => {
    const messages = legacyAgentMessages();
    const before = entriesFromAgentMessages(messages.slice(0, 3));
    const after = entriesFromAgentMessages(messages);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('normalises ISO-string timestamps to epoch ms', () => {
    const [first] = entriesFromAgentMessages(legacyAgentMessages());
    expect(first.timestamp).toBe(Date.parse('2026-01-04T10:00:01.000Z'));
  });

  it('points a tool call at the assistant message that issued it', () => {
    const entries = entriesFromAgentMessages(legacyAgentMessages());
    const call = entries[2];
    expect(call.kind === 'tool-call' && call.assistantEntryId).toBe('e1');
    expect(call.kind === 'tool-call' && call.name).toBe('read_file');
  });

  it('carries no tool arguments on the call entry — they stay on the message', () => {
    const call = entriesFromAgentMessages(legacyAgentMessages())[2];
    expect(JSON.stringify(call)).not.toContain('CHANGELOG');
  });

  it('classifies a batched lick prompt as an external event', () => {
    const [batched] = entriesFromAgentMessages(lickAgentMessages());
    expect(batched.kind).toBe('external-event');
    expect(batched.kind === 'external-event' && batched.channel).toBe('webhook');
  });

  it("classifies a child's completion notice as a child result", () => {
    const [, notice] = entriesFromAgentMessages(lickAgentMessages());
    expect(notice.kind).toBe('child-result');
    expect(notice.kind === 'child-result' && notice.channel).toBe('scoop-notify');
  });

  it('keeps a message of an unknown role rather than dropping it', () => {
    const entries = entriesFromAgentMessages([
      { role: 'from-the-future', content: 'hello' },
    ] as never);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('user');
    expect(entries[0].kind === 'user' && entries[0].text).toBe('hello');
  });

  it('keeps the verbatim Pi message on every message entry', () => {
    const messages = legacyAgentMessages();
    const entries = entriesFromAgentMessages(messages);
    expect(entries[0].kind === 'user' && entries[0].message).toBe(messages[0]);
    expect(entries[3].kind === 'tool-result' && entries[3].message).toBe(messages[2]);
  });
});

describe('entriesFromChatMessages', () => {
  it('breaks a rendered transcript into the same entry kinds', () => {
    expect(entriesFromChatMessages(legacyChatMessages()).map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'external-event',
    ]);
  });

  it('keeps the chat message and attaches no Pi message', () => {
    const entries = entriesFromChatMessages(legacyChatMessages());
    const first = entries[0];
    expect(first.kind === 'user' && first.chat?.id).toBe('m1');
    expect(first.kind === 'user' && first.message).toBeUndefined();
  });

  it('ignores a channel string that is not a registered lick channel', () => {
    const entries = entriesFromChatMessages([
      { id: 'x', role: 'user', content: 'hi', source: 'lick', channel: 'not-a-channel' },
    ] as never);
    expect(entries[0].kind).toBe('user');
  });
});
