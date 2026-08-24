/**
 * Derivations of the canonical record (#2275): Pi history, the UI
 * projection, transcript text and the child summary.
 *
 * The round-trip assertions are the contract this whole PR rests on — a
 * conversation that goes into the record must come back out unchanged, and
 * the UI projection derived from the record must equal the one the live path
 * produces from the same messages.
 */

import { describe, expect, it } from 'vitest';
import { agentMessagesToChatMessages } from '../../../src/scoops/agent-message-to-chat.js';
import {
  conversationLength,
  toAgentMessages,
  toChatMessages,
  toChildResultSummary,
  toTranscriptText,
} from '../../../src/work-unit/conversation/derive.js';
import {
  entriesFromAgentMessages,
  entriesFromChatMessages,
} from '../../../src/work-unit/conversation/entries.js';
import type {
  ConversationOrigin,
  WorkUnitConversationRecord,
} from '../../../src/work-unit/conversation/types.js';
import { CONVERSATION_RECORD_VERSION } from '../../../src/work-unit/conversation/types.js';
import { legacyAgentMessages, legacyChatMessages, lickAgentMessages } from './fixtures.js';

function record(
  entries: WorkUnitConversationRecord['entries'],
  origin: ConversationOrigin = 'agent-history'
): WorkUnitConversationRecord {
  return {
    key: '/workspace::cone_1',
    version: CONVERSATION_RECORD_VERSION,
    workUnitId: 'cone_1',
    workspaceId: '/workspace',
    folder: 'cone',
    origin,
    entries,
    createdAt: 1,
    updatedAt: 2,
    legacyKeys: { agentSessionId: 'cone_1', chatSessionId: 'session-cone' },
  };
}

describe('toAgentMessages', () => {
  it('round-trips a Pi conversation losslessly', () => {
    const messages = legacyAgentMessages();
    expect(toAgentMessages(record(entriesFromAgentMessages(messages)))).toEqual(messages);
  });

  it('drops tool-call entries — Pi keeps them inside the assistant message', () => {
    const entries = entriesFromAgentMessages(legacyAgentMessages());
    expect(entries.filter((e) => e.kind === 'tool-call')).toHaveLength(1);
    expect(toAgentMessages(record(entries))).toHaveLength(4);
  });

  it('derives nothing from a UI-projection record, by design', () => {
    const ui = record(entriesFromChatMessages(legacyChatMessages()), 'ui-projection');
    expect(toAgentMessages(ui)).toEqual([]);
  });

  it('derives nothing from a record written by a newer schema', () => {
    const future = { ...record(entriesFromAgentMessages(legacyAgentMessages())), version: 99 };
    expect(toAgentMessages(future)).toEqual([]);
  });

  it('derives nothing from no record at all', () => {
    expect(toAgentMessages(null)).toEqual([]);
  });
});

describe('toChatMessages', () => {
  it('matches the live translator message-for-message', async () => {
    const messages = legacyAgentMessages();
    const derived = await toChatMessages(record(entriesFromAgentMessages(messages)), {
      source: 'cone',
      idSeed: seededIds(),
    });
    expect(derived).toEqual(
      agentMessagesToChatMessages(messages, {
        source: 'cone',
        idSeed: seededIds(),
      })
    );
  });

  it('returns the stored chat messages for a UI-projection record', async () => {
    const chat = legacyChatMessages();
    const derived = await toChatMessages(record(entriesFromChatMessages(chat), 'ui-projection'));
    expect(derived).toEqual(chat);
  });

  it('returns nothing for an empty record', async () => {
    expect(await toChatMessages(record([]))).toEqual([]);
  });
});

describe('toTranscriptText', () => {
  it('flattens the conversation and omits the tool trace', () => {
    const text = toTranscriptText(record(entriesFromAgentMessages(legacyAgentMessages())));
    expect(text).toBe(
      ['user: ship the release', 'assistant: reading the changelog', 'assistant: released'].join(
        '\n'
      )
    );
  });

  it('labels events and child results by channel', () => {
    const text = toTranscriptText(record(entriesFromAgentMessages(lickAgentMessages())));
    expect(text).toContain('event(webhook):');
    expect(text).toContain('child(scoop-notify):');
  });
});

describe('toChildResultSummary', () => {
  it('is the last assistant answer', () => {
    expect(toChildResultSummary(record(entriesFromAgentMessages(legacyAgentMessages())))).toBe(
      'released'
    );
  });

  it('is empty when the child never answered', () => {
    const entries = entriesFromAgentMessages([{ role: 'user', content: 'do it' }] as never);
    expect(toChildResultSummary(record(entries))).toBe('');
  });
});

describe('conversationLength', () => {
  it('counts messages, not entries', () => {
    expect(conversationLength(record(entriesFromAgentMessages(legacyAgentMessages())))).toBe(4);
  });
});

/** Deterministic ids so two translations can be compared directly. */
function seededIds(): () => string {
  let n = 0;
  return () => `id-${n++}`;
}
