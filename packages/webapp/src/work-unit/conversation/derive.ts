/**
 * Derivations of the canonical conversation record (#2275).
 *
 * Everything that used to be a parallel WRITE is a read of this module:
 * Pi's restore history, the chat panel's projection, transcript text for
 * tray snapshots and frozen archives, and the summary a child hands its
 * parent. There is one spine (`record.entries`) and four views of it.
 *
 * Every derivation is total: an empty or unreadable record derives to
 * nothing, which is the signal callers use to fall back to the legacy
 * stores (`session-persistence.ts`, `kernel/facade.ts`). A derivation never
 * throws on a record it does not understand.
 */

import type { AgentMessage } from '../../core/index.js';
import type { ChatMessage } from '../../scoops/chat-types.js';
import type { ConversationEntry, WorkUnitConversationRecord } from './types.js';
import { isReadableRecord } from './types.js';

/**
 * Pi history. Lossless for an `agent-history` record: the verbatim messages
 * in append order, with `tool-call` entries skipped because Pi keeps tool
 * calls inside the assistant message that issued them.
 *
 * Empty for a `ui-projection` record BY DESIGN — a rendered transcript
 * cannot be turned back into a faithful Pi conversation, and feeding the
 * model a reconstruction would be worse than restoring from the legacy
 * store, which is exactly what an empty answer makes the caller do.
 */
export function toAgentMessages(record: WorkUnitConversationRecord | null): AgentMessage[] {
  if (!isReadableRecord(record) || record === null) return [];
  if (record.origin !== 'agent-history') return [];
  const out: AgentMessage[] = [];
  for (const entry of record.entries) {
    if (entry.kind === 'tool-call') continue;
    if (entry.message) out.push(entry.message);
  }
  return out;
}

/**
 * The chat panel's projection. For an `agent-history` record this runs the
 * existing `agentMessagesToChatMessages` translator over the derived Pi
 * history, so the projection the panel renders from the canonical record is
 * byte-for-byte the one it renders from live agent state — the reason the
 * translator's tests remain the contract for both. Lazy-imported to keep
 * pi-ai types out of every caller's eager closure.
 *
 * For a `ui-projection` record the stored chat messages ARE the projection.
 */
export async function toChatMessages(
  record: WorkUnitConversationRecord | null,
  options: { source?: string; idSeed?: () => string } = {}
): Promise<ChatMessage[]> {
  if (!isReadableRecord(record) || record === null) return [];
  if (record.origin === 'ui-projection') {
    const out: ChatMessage[] = [];
    for (const entry of record.entries) {
      if (entry.kind === 'tool-call') continue;
      if (entry.chat) out.push(entry.chat);
    }
    return out;
  }
  const messages = toAgentMessages(record);
  if (messages.length === 0) return [];
  const { agentMessagesToChatMessages } = await import('../../scoops/agent-message-to-chat.js');
  return agentMessagesToChatMessages(messages, options);
}

/**
 * Flat `user: … / assistant: …` transcript — what the scope-label tooltip,
 * tray snapshots and frozen archives read. Tool traffic is omitted: the
 * transcript is the conversation, not the trace.
 */
export function toTranscriptText(record: WorkUnitConversationRecord | null): string {
  if (!isReadableRecord(record) || record === null) return '';
  const lines: string[] = [];
  for (const entry of record.entries) {
    const label = transcriptLabel(entry);
    if (!label) continue;
    const text = 'text' in entry ? entry.text.trim() : '';
    if (text.length === 0) continue;
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * The summary a finished child hands its parent: its last assistant text.
 * Empty when the child never answered — the caller then reports completion
 * without a body rather than inventing one.
 */
export function toChildResultSummary(record: WorkUnitConversationRecord | null): string {
  if (!isReadableRecord(record) || record === null) return '';
  for (let i = record.entries.length - 1; i >= 0; i--) {
    const entry = record.entries[i];
    if (entry.kind !== 'assistant') continue;
    const text = entry.text.trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** How many messages (not entries) a record represents — tool calls excluded. */
export function conversationLength(record: WorkUnitConversationRecord | null): number {
  if (!isReadableRecord(record) || record === null) return 0;
  return record.entries.filter((e) => e.kind !== 'tool-call').length;
}

function transcriptLabel(entry: ConversationEntry): string | null {
  switch (entry.kind) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'external-event':
      return `event(${entry.channel})`;
    case 'child-result':
      return `child(${entry.channel})`;
    default:
      return null;
  }
}
