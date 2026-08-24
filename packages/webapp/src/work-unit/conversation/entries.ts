/**
 * Ingest: turn a legacy representation into canonical
 * {@link ConversationEntry}s (#2275).
 *
 * Two producers, and the asymmetry between them is the point:
 *
 * - {@link entriesFromAgentMessages} keeps each Pi message verbatim on its
 *   entry, so the Pi derivation is lossless and the UI derivation reuses the
 *   existing, already-tested `agentMessagesToChatMessages` translator. This
 *   is the path every live write takes.
 * - {@link entriesFromChatMessages} exists only for migration, for a unit
 *   whose Pi history is gone but whose rendered chat survived. It keeps the
 *   chat message verbatim and attaches NO Pi message — see
 *   `ConversationOrigin`.
 *
 * Classification (`user` vs `external-event` vs `child-result`) reads the
 * same envelope grammar the chat translator does, so a lick that renders as
 * a lick card in the live UI is a lick in the record too.
 */

import { isLickChannel, type LickChannel } from '../../base/lick-channels.js';
import type { AgentMessage } from '../../core/index.js';
import {
  lickChannelFromBody,
  lickChannelFromSenderName,
  splitEnvelopes,
} from '../../scoops/agent-message-to-chat.js';
import type { ChatMessage } from '../../scoops/chat-types.js';
import type { ConversationEntry } from './types.js';

/** Lick channels a CHILD unit produces; everything else is an external event. */
const CHILD_RESULT_CHANNELS: ReadonlySet<LickChannel> = new Set<LickChannel>([
  'scoop-notify',
  'scoop-idle',
  'scoop-wait',
]);

/** Entry id — stable for a given position, which is what makes appends idempotent. */
export function entryId(seq: number): string {
  return `e${seq}`;
}

/**
 * Build the canonical entries for a Pi conversation. Pure and deterministic:
 * the same `messages` always yield the same entries, so re-ingesting a
 * conversation that only grew produces the stored prefix plus the new tail
 * (see `store.ts`).
 */
export function entriesFromAgentMessages(messages: readonly AgentMessage[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];

  for (const message of messages) {
    const role = roleOf(message);
    const timestamp = timestampOf(message);
    if (role === 'assistant') {
      const assistantSeq = out.length;
      const assistantId = entryId(assistantSeq);
      out.push({
        id: assistantId,
        seq: assistantSeq,
        kind: 'assistant',
        timestamp,
        text: textOf(message),
        message,
        model: modelOf(message),
      });
      for (const call of toolCallsOf(message)) {
        const seq = out.length;
        out.push({
          id: entryId(seq),
          seq,
          kind: 'tool-call',
          timestamp,
          toolCallId: call.id,
          name: call.name,
          assistantEntryId: assistantId,
        });
      }
      continue;
    }
    if (role === 'toolResult') {
      const result = message as { toolCallId?: string; isError?: boolean };
      const seq = out.length;
      out.push({
        id: entryId(seq),
        seq,
        kind: 'tool-result',
        timestamp,
        text: textOf(message),
        message,
        toolCallId: result.toolCallId ?? '',
        isError: result.isError,
      });
      continue;
    }
    // `user`, and any role this build does not know: still conversation
    // state, so it is kept verbatim rather than dropped.
    const text = textOf(message);
    const channel = role === 'user' ? classifyUserText(text) : null;
    const seq = out.length;
    const id = entryId(seq);
    if (channel === null) {
      out.push({ id, seq, kind: 'user', timestamp, text, message });
    } else if (CHILD_RESULT_CHANNELS.has(channel)) {
      out.push({ id, seq, kind: 'child-result', timestamp, text, message, channel });
    } else {
      out.push({ id, seq, kind: 'external-event', timestamp, text, message, channel });
    }
  }
  return out;
}

/**
 * Migration-only ingest of a rendered chat transcript. One entry per chat
 * message plus one `tool-call` entry per tool call it carries, so the shape
 * of the record does not depend on which legacy store it came from.
 */
export function entriesFromChatMessages(messages: readonly ChatMessage[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const chat of messages) {
    const seq = out.length;
    const id = entryId(seq);
    const timestamp = chatTimestamp(chat);
    const text = typeof chat.content === 'string' ? chat.content : '';
    if (chat.role === 'assistant') {
      out.push({ id, seq, kind: 'assistant', timestamp, text, chat, model: chat.model });
      for (const call of chat.toolCalls ?? []) {
        const callSeq = out.length;
        out.push({
          id: entryId(callSeq),
          seq: callSeq,
          kind: 'tool-call',
          timestamp,
          toolCallId: call.id,
          name: call.name,
          assistantEntryId: id,
        });
      }
      continue;
    }
    // `ChatMessage.channel` is a free-form wire string; only a registered
    // lick channel makes the entry an event rather than user input.
    const channel =
      chat.source === 'lick' && chat.channel && isLickChannel(chat.channel)
        ? chat.channel
        : classifyUserText(text);
    if (channel === null) {
      out.push({ id, seq, kind: 'user', timestamp, text, chat });
    } else if (CHILD_RESULT_CHANNELS.has(channel)) {
      out.push({ id, seq, kind: 'child-result', timestamp, text, chat, channel });
    } else {
      out.push({ id, seq, kind: 'external-event', timestamp, text, chat, channel });
    }
  }
  return out;
}

/**
 * Which lick channel a user-role body belongs to, or `null` for genuine user
 * input. Sender anchor first (the orchestrator's `<channel>:<event>`
 * envelope), body markers second (scoop lifecycle notices carry no channel
 * prefix) — the same two-step the chat translator uses.
 */
function classifyUserText(text: string): LickChannel | null {
  for (const envelope of splitEnvelopes(text)) {
    const channel =
      (envelope.sender ? lickChannelFromSenderName(envelope.sender) : null) ??
      lickChannelFromBody(envelope.body);
    if (channel) return channel;
  }
  return null;
}

function roleOf(message: AgentMessage): string {
  return (message as { role?: string }).role ?? '';
}

function toEpochMs(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (raw instanceof Date) return raw.getTime();
  return 0;
}

function timestampOf(message: AgentMessage): number {
  return toEpochMs((message as { timestamp?: unknown }).timestamp);
}

function chatTimestamp(chat: ChatMessage): number {
  return toEpochMs(chat.timestamp as unknown);
}

function modelOf(message: AgentMessage): string | undefined {
  const model = (message as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if ((block as { type?: string })?.type === 'text') parts.push((block as { text: string }).text);
  }
  return parts.join('');
}

function toolCallsOf(message: AgentMessage): Array<{ id: string; name: string }> {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const block of content) {
    if ((block as { type?: string })?.type !== 'toolCall') continue;
    const call = block as { id?: string; name?: string };
    out.push({ id: call.id ?? '', name: call.name ?? '' });
  }
  return out;
}
